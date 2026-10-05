// The "forge" MCP server that Claude Code connects to (streamable HTTP, one URL per conversation).
// It exposes compact asset tools plus a curated, studio_id-free view of Roblox Studio's own tools.
// The tool list is static so Claude Code's prompt prefix (and cache) stays stable.

import { z } from "zod";
import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { assets, bus, games, shortId } from "./store.ts";
import { importAsset, pullSelection } from "./importer.ts";
import { resultText, type StudioBridge, type ToolCallResult } from "./studio-bridge.ts";
import { MCP_TOKEN } from "./config.ts";
import {
  applyModelEdit, expandModelInput, expandParts, ModelEditSchema, ModelSpecInputSchema, PartInputSchema, sanitizeModelSpec, toNativeModel,
} from "../shared/model.ts";
import {
  applyUiEdit, expandUiInput, expandUiNodes, sanitizeUiSpec, UiEditSchema, UiNodeInputSchema, UiSpecInputSchema, UiStylesSchema, type UiSpec,
} from "../shared/ui.ts";
import { ScriptSpecSchema } from "../shared/script.ts";
import { checkModel, describeIssues } from "../shared/diagnostics.ts";
import { compactModel, compactUi, modelOutline, nodesUnder, partsInGroup } from "../shared/compact.ts";
import { animationLength, AnimationEditSchema, AnimationSpecSchema, applyAnimationEdit, RIGS, sanitizeAnimationSpec, unsupportedJoints } from "../shared/animation.ts";
import { sizeLabel, summarize, type Asset, type HtmlSource } from "../shared/assets.ts";
import type { HtmlConvertRequest, ImportResult, PermissionRequest, Settings } from "../shared/protocol.ts";

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };

type JsonSchema = Record<string, any>;

interface ToolDef {
  name: string;
  description: string;
  /** Strict schema: every call is validated against it. */
  schema: z.ZodObject;
  /** Optional rewrite of the schema shown to Claude (to keep the cached tool list small). */
  advertise?: (s: JsonSchema) => JsonSchema;
  run: (args: any, ctx: Ctx) => Promise<ToolResult>;
}

interface Ctx {
  convId: string;
  /** Live status line shown on this call in the chat. */
  progress: (text: string) => void;
}

export interface ForgeDeps {
  bridge: StudioBridge;
  getSettings: () => Settings;
  convertHtml: (request: HtmlConvertRequest) => Promise<{ spec: UiSpec; warnings: string[] }>;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
const MAX_TEXT = 20_000;

function jsonSchema(schema: z.ZodObject): JsonSchema {
  const s = z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" }) as JsonSchema;
  delete s.$schema;
  return slim(s) as JsonSchema;
}

const SAFE_INT = Number.MAX_SAFE_INTEGER;

/**
 * Drop schema noise that costs prompt tokens without helping Claude: safe-integer bounds,
 * string length limits, regex patterns and huge array limits. Validation still uses the
 * strict zod schemas, so nothing is loosened at runtime.
 */
function slim(node: unknown, isPropertyMap = false): unknown {
  if (Array.isArray(node)) return node.map((n) => slim(n));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (!isPropertyMap) {
      if ((k === "minimum" || k === "maximum") && typeof v === "number" && Math.abs(v) >= SAFE_INT) continue;
      if (k === "pattern" || k === "maxLength" || k === "minLength") continue;
      if (k === "maxItems" && typeof v === "number" && v >= 50) continue;
      if (k === "minItems" && v === 1 && !("maxItems" in node && (node as JsonSchema).maxItems < 50)) continue;
    }
    out[k] = slim(v, !isPropertyMap && k === "properties");
  }
  return out;
}

/** Replace the item schema of array properties with a one-line reference to another tool's format. */
function looseItems(s: JsonSchema, props: Record<string, string>): JsonSchema {
  for (const [key, description] of Object.entries(props)) {
    const p = s.properties?.[key];
    if (!p) continue;
    s.properties[key] = p.type === "array"
      ? { type: "array", items: { type: "object" }, description }
      : { type: "object", additionalProperties: { type: "object" }, description };
  }
  return s;
}

function dims(asset: Asset): string {
  if (asset.kind !== "model") return "";
  const { min, max } = toNativeModel(asset.spec).bounds;
  const d = [0, 1, 2].map((i) => Math.round((max[i] - min[i]) * 10) / 10);
  return `, ${d.join("×")} studs`;
}

function importLine(r: ImportResult): string {
  if (!r.ok) return `Studio import failed: ${r.error}`;
  const count = r.parts !== undefined ? ` (${r.parts} part${r.parts === 1 ? "" : "s"}${r.optimizedFrom ? `, optimized from ${r.optimizedFrom}` : ""})` : "";
  return `${r.replaced ? "Updated" : "Imported"} in Studio at ${r.path}${count}.`;
}

// ---------------------------------------------------------------------------

export class ForgeMcp {
  private pending = new Map<string, { request: PermissionRequest; resolve: (allow: boolean) => void }>();
  private alwaysAllow = new Set<string>();
  private tools: ToolDef[];
  private byName: Map<string, ToolDef>;
  /** Set by the host: shows a progress line on a running tool call (by full tool name). */
  progressSink?: (convId: string, toolName: string, text: string) => void;
  /** tools/list result, built once: the list is static (it is part of Claude's cached prompt). */
  private listed: { name: string; description: string; inputSchema: any }[];

  constructor(private deps: ForgeDeps) {
    this.tools = this.defineTools();
    this.byName = new Map(this.tools.map((t) => [t.name, t]));
    this.listed = this.tools.map((t) => {
      const schema = jsonSchema(t.schema);
      return { name: t.name, description: t.description, inputSchema: t.advertise ? t.advertise(schema) : schema };
    });
  }

  /** The advertised tool list (also used by tests and benchmarks). */
  get toolList() {
    return this.listed;
  }

  get pendingPermissions(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  resolvePermission(id: string, allow: boolean, always = false) {
    const p = this.pending.get(id);
    if (!p) return;
    if (allow && always) this.alwaysAllow.add(p.request.toolName);
    this.pending.delete(id);
    p.resolve(allow);
    bus.emitEvent({ type: "permission.resolved", id });
  }

  /** Deny everything still waiting for a conversation (e.g. when its run is stopped). */
  cancelPermissions(convId: string) {
    for (const [id, p] of this.pending) if (p.request.convId === convId) this.resolvePermission(id, false);
  }

  /** Names Claude Code may call without asking (passed to --allowedTools). */
  allowedToolNames(): string[] {
    const s = this.deps.getSettings();
    return this.tools
      .map((t) => t.name)
      .filter((n) => n !== "permission_prompt")
      .filter((n) => s.autoApproveLuau || !GATED.has(n))
      .map((n) => `mcp__forge__${n}`);
  }

  async handle(req: Request, res: Response) {
    if (req.headers.authorization !== `Bearer ${MCP_TOKEN}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (req.method !== "POST") {
      res.status(405).set("Allow", "POST").json({ error: "method not allowed" });
      return;
    }
    const convId = String(req.params.convId ?? "");
    const server = new Server({ name: "forge", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listed }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = this.byName.get(request.params.name);
      if (!tool) return text(`Unknown tool ${request.params.name}`, true);
      const parsed = tool.schema.safeParse(request.params.arguments ?? {});
      if (!parsed.success) return text(`Invalid arguments: ${z.prettifyError(parsed.error)}`, true);
      const ctx: Ctx = { convId, progress: (t) => this.progressSink?.(convId, `mcp__forge__${tool.name}`, t) };
      try {
        return await tool.run(parsed.data, ctx);
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  // -------------------------------------------------------------------------

  private async afterSave(asset: Asset, verb: string, ctx: Ctx, warnings: string[] = []): Promise<ToolResult> {
    const extra = asset.kind === "animation" ? `, ${asset.spec.rig}, ${Math.round(animationLength(asset.spec) * 100) / 100}s` : dims(asset);
    const lines = [`${verb} ${asset.kind} "${asset.name}" (id ${asset.id}, v${asset.version}, ${sizeLabel(asset.kind, summarize(asset).size)}${extra}). Shown in the preview.`];
    if (warnings.length) lines.push(`Notes: ${warnings.slice(0, 8).join("; ")}`);
    // Positioning problems Claude can fix before the user notices (floating parts, flicker…).
    if (asset.kind === "model") lines.push(...describeIssues(checkModel(asset.spec)));
    const s = this.deps.getSettings();
    if (s.autoImport && this.deps.bridge.connected && this.deps.bridge.status.studioId) {
      ctx.progress(`Saved v${asset.version} (${sizeLabel(asset.kind, summarize(asset).size)}). Importing into Studio…`);
      lines.push(importLine(await importAsset(this.deps.bridge, s, asset.id, {}, ctx.progress)));
    }
    return text(lines.join("\n"));
  }

  private save<K extends Asset["kind"]>(kind: K, spec: Extract<Asset, { kind: K }>["spec"], replaceId?: string, html?: HtmlSource | null): Asset {
    const now = Date.now();
    const prev = replaceId ? assets.get(replaceId) : undefined;
    if (replaceId && (!prev || prev.kind !== kind)) throw new Error(`No ${kind} asset with id ${replaceId}.`);
    const asset = {
      id: prev?.id ?? shortId(kind === "model" ? "m_" : kind === "ui" ? "u_" : kind === "animation" ? "a_" : "s_"),
      kind,
      name: spec.name,
      description: (spec as { description?: string }).description,
      spec,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      version: (prev?.version ?? 0) + 1,
      origin: "claude",
      lastImport: prev?.lastImport,
      // Filed under the game open in Studio (replacements stay where they are).
      gameId: prev ? prev.gameId : games.currentId,
    } as Asset;
    if (!asset.gameId) delete asset.gameId;
    if (asset.kind === "ui") {
      const keep = html === undefined && prev?.kind === "ui" ? prev.html : html ?? undefined;
      if (keep) asset.html = keep;
    }
    return assets.put(asset, true);
  }

  private studio(name: string, args: Record<string, unknown>, timeoutMs?: number) {
    return this.deps.bridge.callTool(name, args, timeoutMs).then(forward);
  }

  private requireBuiltin(feature: string) {
    if (this.deps.bridge.status.flavor === "legacy") throw new Error(`${feature} needs Roblox Studio's built-in MCP server (the legacy plugin doesn't support it).`);
  }

  private defineTools(): ToolDef[] {
    const id = z.string().describe("asset id");
    return [
      {
        name: "create_model",
        description:
          "Create (or fully replace, with id) a 3D model made of Roblox parts. Prefer edit_model for changes. Save tokens with styles (shared color/material/size), repeat (rows of copies), copies (same part at offsets) and clones (copy a whole group).",
        schema: ModelSpecInputSchema.extend({ id: id.optional().describe("replace this existing model") }),
        advertise: (s) => looseItems(s, { styles: 'name → part fields to share (any part field except name/pos), e.g. {"log":{"color":"#6b4a2b","material":"Wood"}}' }),
        run: async ({ id: replaceId, ...spec }, ctx) => {
          const model = sanitizeModelSpec(expandModelInput(spec));
          ctx.progress(`Building ${model.parts.length} parts…`);
          const asset = this.save("model", model, replaceId);
          return this.afterSave(asset, replaceId ? "Replaced" : "Created", ctx);
        },
      },
      {
        name: "edit_model",
        description: "Change an existing model: add parts, update parts by name (partial fields), remove by name, move or scale everything.",
        schema: ModelEditSchema.extend({
          id,
          add: z.array(PartInputSchema).optional(),
          styles: ModelSpecInputSchema.shape.styles,
        }),
        advertise: (s) => looseItems(s, {
          add: "new parts: same fields as create_model parts (style/repeat/copies allowed)",
          update: "partial updates matched by name: {name, ...any create_model part fields}; only listed fields change",
          styles: "styles for the added parts, as in create_model",
        }),
        run: async ({ id: assetId, styles, add, ...edit }, ctx) => {
          const prev = assets.get(assetId);
          if (!prev || prev.kind !== "model") return text(`No model with id ${assetId}.`, true);
          const { spec, missing } = applyModelEdit(prev.spec, { ...edit, add: add ? expandParts(add, styles) : undefined });
          const asset = this.save("model", spec, assetId);
          return this.afterSave(asset, "Edited", ctx, missing.length ? [`not found: ${missing.join(", ")}`] : []);
        },
      },
      {
        name: "create_ui",
        description: "Create (or fully replace, with id) a ScreenGui from a flat list of Roblox GUI nodes. Prefer edit_ui for changes.",
        schema: UiSpecInputSchema.extend({ id: id.optional().describe("replace this existing UI") }),
        advertise: (s) => looseItems(s, { styles: 'name → node fields to share (any node field except name/parent), e.g. {"card":{"bg":"#1e2230","corner":12}}' }),
        run: async ({ id: replaceId, ...raw }, ctx) => {
          const { spec, warnings } = sanitizeUiSpec(expandUiInput(raw));
          const asset = this.save("ui", spec, replaceId);
          return this.afterSave(asset, replaceId ? "Replaced" : "Created", ctx, warnings);
        },
      },
      {
        name: "edit_ui",
        description: "Change an existing UI: add nodes, update nodes by name (partial fields), remove nodes (with descendants).",
        schema: UiEditSchema.extend({ id, add: z.array(UiNodeInputSchema).optional(), styles: UiStylesSchema }),
        advertise: (s) => looseItems(s, {
          add: "new nodes (appended; set parent): same fields as create_ui nodes (style allowed)",
          update: "partial updates matched by name: {name, ...any create_ui node fields}; only listed fields change",
          styles: "styles for the added nodes, as in create_ui",
        }),
        run: async ({ id: assetId, styles, add, ...edit }, ctx) => {
          const prev = assets.get(assetId);
          if (!prev || prev.kind !== "ui") return text(`No UI with id ${assetId}.`, true);
          const { spec, missing, warnings } = applyUiEdit(prev.spec, { ...edit, add: add ? expandUiNodes(add, styles) : undefined });
          if (prev.html) warnings.push("this UI came from HTML; edit_ui_html keeps the HTML source in sync (spec-only edits are lost if the HTML is re-translated)");
          const asset = this.save("ui", spec, assetId);
          return this.afterSave(asset, "Edited", ctx, [...(missing.length ? [`not found: ${missing.join(", ")}`] : []), ...warnings]);
        },
      },
      {
        name: "create_ui_html",
        description:
          "Design a ScreenGui in HTML/CSS. The page is rendered at width×height and every element is translated to Roblox GUI objects at the same positions (frames, text, rich text, buttons, text boxes, rbxassetid images, gradients, corners, strokes, shadows, scrolling lists). Best for rich, polished UIs.",
        schema: z.object({
          name: z.string().min(1).max(60).describe("ScreenGui name"),
          html: z.string().min(1).max(300_000).describe("complete HTML document or body fragment with inline <style>; no JavaScript"),
          width: z.number().int().min(320).max(3840).optional().describe("design width px, default 1280"),
          height: z.number().int().min(240).max(2160).optional().describe("design height px, default 720"),
          autoScale: z.boolean().optional().describe("scale proportionally on other screens, default true"),
          id: id.optional().describe("replace this existing UI"),
        }),
        run: async ({ name, html, width, height, autoScale, id: replaceId }, ctx) => {
          const source: HtmlSource = { source: html, width: width ?? 1280, height: height ?? 720, autoScale: autoScale ?? true };
          ctx.progress(`Rendering the HTML at ${source.width}×${source.height} and translating it…`);
          const { spec, warnings } = await this.deps.convertHtml({ name, html, width: source.width, height: source.height, autoScale: source.autoScale });
          const asset = this.save("ui", spec, replaceId, source);
          return this.afterSave(asset, replaceId ? "Replaced (from HTML)" : "Created (from HTML)", ctx, warnings);
        },
      },
      {
        name: "edit_ui_html",
        description: "Edit the HTML source of a UI made with create_ui_html using exact find/replace edits, then re-translate it. Cheaper than re-sending the whole page.",
        schema: z.object({
          id,
          edits: z
            .array(z.object({ find: z.string().min(1), replace: z.string(), all: z.boolean().optional().describe("replace every occurrence") }))
            .min(1)
            .max(50),
          width: z.number().int().min(320).max(3840).optional(),
          height: z.number().int().min(240).max(2160).optional(),
        }),
        run: async ({ id: assetId, edits, width, height }, ctx) => {
          const prev = assets.get(assetId);
          if (!prev || prev.kind !== "ui" || !prev.html) return text(`No HTML-based UI with id ${assetId} (use create_ui_html first).`, true);
          let source = prev.html.source;
          for (const e of edits) {
            const count = source.split(e.find).length - 1;
            if (count === 0) return text(`Edit not applied: "${e.find.slice(0, 80)}" was not found. No changes were saved.`, true);
            if (count > 1 && !e.all) return text(`Edit not applied: "${e.find.slice(0, 80)}" occurs ${count} times; add more context or set all: true. No changes were saved.`, true);
            source = e.all ? source.split(e.find).join(e.replace) : source.replace(e.find, () => e.replace);
          }
          const html: HtmlSource = { ...prev.html, source, width: width ?? prev.html.width, height: height ?? prev.html.height };
          ctx.progress(`Applied ${edits.length} edit${edits.length > 1 ? "s" : ""}. Re-translating the HTML…`);
          const { spec, warnings } = await this.deps.convertHtml({ name: prev.spec.name, html: source, width: html.width, height: html.height, autoScale: html.autoScale });
          const asset = this.save("ui", spec, assetId, html);
          return this.afterSave(asset, "Edited (from HTML)", ctx, warnings);
        },
      },
      {
        name: "create_animation",
        description:
          "Create (or replace, with id) a character animation for an R15 or R6 rig. It plays live in the preview; importing saves a KeyframeSequence the Animation Editor can load onto a dummy rig.",
        schema: AnimationSpecSchema.extend({ id: id.optional().describe("replace this existing animation") }),
        advertise: (s) => looseItems(s, {
          keyframes: "[{t: seconds, poses: {joint: [x,y,z] degrees | {rot, pos}}, ease?: linear|constant|cubic|elastic|bounce, dir?: in|out|inOut, name?}] — joints: root waist neck left/right Shoulder Elbow Wrist Hip Knee Ankle",
        }),
        run: async ({ id: replaceId, ...raw }, ctx) => {
          const spec = sanitizeAnimationSpec(raw);
          const skipped = unsupportedJoints(spec, RIGS[spec.rig]);
          const asset = this.save("animation", spec, replaceId);
          return this.afterSave(asset, replaceId ? "Replaced" : "Created", ctx, skipped.length ? [`${spec.rig} has no ${skipped.join(", ")} (ignored there)`] : []);
        },
      },
      {
        name: "edit_animation",
        description: "Change an animation: merge keyframes by time (only the joints you list change), remove keyframes or joints, retime with speed, or switch rig/loop/priority.",
        schema: AnimationEditSchema.extend({ id }),
        advertise: (s) => looseItems(s, { keyframes: "same format as create_animation keyframes; merged into the keyframe at the same t" }),
        run: async ({ id: assetId, ...edit }, ctx) => {
          const prev = assets.get(assetId);
          if (!prev || prev.kind !== "animation") return text(`No animation with id ${assetId}.`, true);
          const { spec, missing } = applyAnimationEdit(prev.spec, edit);
          const asset = this.save("animation", spec, assetId);
          return this.afterSave(asset, "Edited", ctx, missing.length ? [`no keyframe at ${missing.join(", ")}s`] : []);
        },
      },
      {
        name: "create_script",
        description: "Create (or replace, with id) a Script/LocalScript/ModuleScript that is inserted at a path in the place.",
        schema: ScriptSpecSchema.extend({ id: id.optional().describe("replace this existing script") }),
        run: async ({ id: replaceId, ...spec }, ctx) => this.afterSave(this.save("script", spec, replaceId), replaceId ? "Replaced" : "Created", ctx),
      },
      {
        name: "list_assets",
        description: "List library assets (id, kind, name, size, version, Studio path). Shows the game open in Studio plus unfiled assets unless all is true.",
        schema: z.object({
          all: z.boolean().optional().describe("every game"),
          query: z.string().optional().describe("filter by name"),
        }),
        run: async ({ all, query }) => {
          const current = games.get(games.currentId);
          const everything = assets.list();
          let list = all || !current ? everything : everything.filter((a) => !a.gameId || a.gameId === current.id);
          if (query) {
            const q = query.toLowerCase();
            list = list.filter((a) => a.name.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q));
          }
          const hidden = everything.length - (all || !current ? everything.length : everything.filter((a) => !a.gameId || a.gameId === current.id).length);
          const head = current && !all ? `Game "${current.name}"${hidden ? ` (${hidden} more in other games: all: true)` : ""}` : "";
          if (!list.length) return text([head, query ? `No assets match "${query}".` : "No assets yet."].filter(Boolean).join("\n"));
          const line = (a: (typeof list)[number]) => {
            const game = all && a.gameId ? ` [${games.get(a.gameId)?.name ?? "?"}]` : "";
            return `${a.id} ${a.kind} "${a.name}" v${a.version} ${sizeLabel(a.kind, a.size)}${a.lastImport ? ` → ${a.lastImport.path}` : ""}${game}`;
          };
          const more = list.length > 60 ? `\n…${list.length - 60} more (use query)` : "";
          return text([head, ...list.slice(0, 60).map(line)].filter(Boolean).join("\n") + more);
        },
      },
      {
        name: "get_asset",
        description:
          "Return an asset's spec as JSON in create_* input format (repeated looks are factored into styles). Read only what you need: names (parts/nodes; UI nodes include their children) or group (models).",
        schema: z.object({
          id,
          names: z.array(z.string()).optional().describe("only these parts/nodes"),
          group: z.string().optional().describe("models: only this group path and its subgroups"),
          full: z.boolean().optional().describe("models over 600 parts: return everything instead of an outline"),
        }),
        run: async ({ id: assetId, names, group, full }) => {
          const a = assets.get(assetId);
          if (!a) return text(`No asset with id ${assetId}.`, true);
          if (a.kind === "model") {
            const wanted = names ? new Set(names) : null;
            const parts = wanted ? a.spec.parts.filter((p) => wanted.has(p.name ?? "")) : group ? partsInGroup(a.spec.parts, group) : a.spec.parts;
            if (!wanted && !group && !full && parts.length > 600) {
              return text(`"${a.name}" has ${parts.length} parts. Groups:\n${modelOutline(a.spec)}\nRead one with group, or pass full: true.`);
            }
            const note = parts.length !== a.spec.parts.length ? `\n(${parts.length} of ${a.spec.parts.length} parts)` : "";
            return text(JSON.stringify(compactModel({ ...a.spec, parts })) + note);
          }
          if (a.kind === "ui") {
            const nodes = names ? nodesUnder(a.spec.nodes, names) : a.spec.nodes;
            const note = nodes.length !== a.spec.nodes.length ? `\n(${nodes.length} of ${a.spec.nodes.length} nodes)` : "";
            return text(JSON.stringify(compactUi({ ...a.spec, nodes })) + note);
          }
          return text(JSON.stringify(a.spec));
        },
      },
      {
        name: "import_to_studio",
        description: "Import an asset into the open Roblox Studio place. Re-importing replaces the previous copy in place.",
        schema: z.object({
          id,
          parent: z.string().optional().describe("dot path, e.g. Workspace, ReplicatedStorage, StarterGui"),
          placement: z.enum(["camera", "origin", "keep"]).optional().describe("models: in front of camera (default), at origin, or spec coordinates"),
          optimize: z.boolean().optional().describe("merge identical touching blocks (default true)"),
        }),
        run: async ({ id: assetId, ...opts }, ctx) => {
          const r = await importAsset(this.deps.bridge, this.deps.getSettings(), assetId, opts, ctx.progress);
          return text(importLine(r), !r.ok);
        },
      },
      {
        name: "studio_pull_selection",
        description: "Read the current Roblox Studio selection (Parts/Models or a ScreenGui/GUI objects) into a new editable asset.",
        schema: z.object({}),
        run: async (_args, ctx) => {
          const r = await pullSelection(this.deps.bridge, ctx.progress);
          if (!r.ok || !r.asset) return text(r.error ?? "Pull failed.", true);
          const skipped = r.skipped?.length ? ` Skipped unsupported: ${r.skipped.slice(0, 10).join(", ")}${r.skipped.length > 10 ? "…" : ""}.` : "";
          return text(`Pulled ${r.asset.kind} "${r.asset.name}" as ${r.asset.id} (${sizeLabel(r.asset.kind, summarize(r.asset).size)}).${skipped} Use get_asset to read it.`);
        },
      },
      {
        name: "studio_execute_luau",
        description: "Run Luau in Roblox Studio (plugin security) and return the chunk's return value. Changes are undoable.",
        schema: z.object({
          code: z.string().describe("Luau; end with `return <compact value>` to get a result"),
          datamodel: z.enum(["Edit", "Client", "Server"]).optional().describe("default Edit; Client/Server only while play-testing"),
        }),
        run: async ({ code, datamodel }, ctx) => {
          ctx.progress(`Running in Studio (${datamodel ?? "Edit"})…`);
          const out = await this.deps.bridge.runLuau(code, datamodel ?? "Edit");
          return text(clip(out || "nil"));
        },
      },
      {
        name: "studio_search_tree",
        description: "Search the Studio instance tree (by path, class, keywords).",
        schema: z.object({
          path: z.string().optional().describe("start path, e.g. game.Workspace"),
          instance_type: z.string().optional().describe("ClassName filter"),
          keywords: z.string().optional(),
          max_depth: z.number().int().optional(),
          head_limit: z.number().int().optional().describe("max results"),
        }),
        run: async (args) => {
          this.requireBuiltin("Tree search");
          return this.studio("search_game_tree", { ...args, datamodel_type: "Edit" });
        },
      },
      {
        name: "studio_inspect",
        description: "Show an instance's properties, attributes and children.",
        schema: z.object({ path: z.string().describe("e.g. game.Workspace.Model") }),
        run: async ({ path }) => {
          this.requireBuiltin("Inspect");
          return this.studio("inspect_instance", { path });
        },
      },
      {
        name: "studio_script_read",
        description: "Read a script's source from Studio.",
        schema: z.object({
          path: z.string().describe("e.g. game.ServerScriptService.Main"),
          start_line: z.number().int().optional(),
          end_line: z.number().int().optional(),
        }),
        run: async ({ path, start_line, end_line }) => {
          this.requireBuiltin("Script reading");
          const args: Record<string, unknown> = { target_file: path, should_read_entire_file: start_line === undefined };
          if (start_line !== undefined) args.start_line_one_indexed = start_line;
          if (end_line !== undefined) args.end_line_one_indexed_inclusive = end_line;
          return this.studio("script_read", args);
        },
      },
      {
        name: "studio_script_edit",
        description: "Edit a script in Studio with exact string replacements (creates the script if it doesn't exist).",
        schema: z.object({
          path: z.string().describe("e.g. game.ServerScriptService.Main"),
          edits: z.array(z.object({ old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() })).min(1),
          class_name: z.enum(["Script", "LocalScript", "ModuleScript"]).optional().describe("when creating"),
        }),
        run: async ({ path, edits, class_name }) => {
          this.requireBuiltin("Script editing");
          return this.studio("multi_edit", { file_path: path, edits, ...(class_name ? { className: class_name } : {}) });
        },
      },
      {
        name: "studio_screenshot",
        description: "Capture the Studio viewport as an image (optionally from a camera position looking at a point).",
        schema: z.object({
          camera_position: z.array(z.number()).length(3).optional(),
          look_at_position: z.array(z.number()).length(3).optional(),
        }),
        run: async (args) => {
          this.requireBuiltin("Screenshots");
          return this.studio("screen_capture", { capture_id: shortId("cap_"), ...args });
        },
      },
      {
        name: "studio_console",
        description: "Read Studio's Output window (prints, warnings, errors).",
        schema: z.object({}),
        run: async () => this.studio("get_console_output", {}),
      },
      {
        name: "studio_state",
        description: "Studio mode (Edit/Play) and available data models.",
        schema: z.object({}),
        run: async () => {
          if (this.deps.bridge.status.flavor === "legacy") return this.studio("get_studio_mode", {});
          return this.studio("get_studio_state", {});
        },
      },
      {
        name: "studio_play",
        description: "Start or stop a play-test in Studio.",
        schema: z.object({ start: z.boolean() }),
        run: async ({ start }) => {
          if (this.deps.bridge.status.flavor === "legacy") return this.studio("start_stop_play", { mode: start ? "start_play" : "stop" });
          return this.studio("start_stop_play", { is_start: start });
        },
      },
      {
        name: "permission_prompt",
        description: "Internal hook used by the host to ask the user for permission. Never call this tool yourself.",
        schema: z.object({ tool_name: z.string(), input: z.any(), tool_use_id: z.string().optional() }),
        run: async ({ tool_name, input }, ctx) => {
          const allow = await this.askUser(ctx.convId, tool_name, input);
          return text(JSON.stringify(allow
            ? { behavior: "allow", updatedInput: input ?? {} }
            : { behavior: "deny", message: "The user declined this action in Studio Forge." }));
        },
      },
    ];
  }

  private askUser(convId: string, toolName: string, input: unknown): Promise<boolean> {
    if (this.alwaysAllow.has(toolName)) return Promise.resolve(true);
    this.progressSink?.(convId, toolName, "Waiting for your approval…");
    const request: PermissionRequest = { id: shortId("p_"), convId, toolName, input, createdAt: Date.now() };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.resolvePermission(request.id, false), 15 * 60_000);
      this.pending.set(request.id, {
        request,
        resolve: (allow) => {
          clearTimeout(timer);
          resolve(allow);
        },
      });
      bus.emitEvent({ type: "permission", request });
    });
  }
}

/** Tools that run arbitrary code in Studio ask for permission unless auto-approve is on. */
const GATED = new Set(["studio_execute_luau", "studio_script_edit"]);

function clip(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `\n… [truncated ${s.length - MAX_TEXT} chars]` : s;
}

function forward(res: ToolCallResult): ToolResult {
  const content: ToolResult["content"] = [];
  for (const c of res.content ?? []) {
    if (c.type === "text") content.push({ type: "text", text: clip(c.text ?? "") });
    else if (c.type === "image" && c.data) content.push({ type: "image", data: c.data, mimeType: c.mimeType ?? "image/png" });
  }
  if (!content.length) content.push({ type: "text", text: resultText(res) || "(empty result)" });
  return { content, ...(res.isError ? { isError: true } : {}) };
}
