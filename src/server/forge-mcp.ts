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
import { resultText, unquote, type StudioBridge, type ToolCallResult } from "./studio-bridge.ts";
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
import { animationLength, AnimationEditSchema, AnimationSpecSchema, applyAnimationEdit, checkAnimation, RIGS, sanitizeAnimationSpec, unsupportedJoints } from "../shared/animation.ts";
import { POSE_NAMES } from "../shared/poses.ts";
import { applyVfxEdit, PARTICLE_PRESET_NAMES, VfxEditSchema, vfxSummary, TEXTURE_PRESETS } from "../shared/vfx.ts";
import { scriptsToLuau } from "../shared/to-luau.ts";
import { AbilityEditSchema, AbilitySpecInputSchema, applyAbilityEdit, ATTACH_POINTS, expandAbilityInput, sanitizeAbilitySpec } from "../shared/ability.ts";
import { EFFECT_PRESET_NAMES, expandVfxInput, VfxInputSchema } from "../shared/vfx-presets.ts";
import { resolveStored } from "./importer.ts";
import {
  auditLuau, editLuau, LIGHTING_PRESETS, lightingLuau, parseScriptRead, queryLuau, scriptPatchLuau, scriptReadLuau, scriptSearchLuau, terrainLuau, undoLuau,
  type EditOp, type TerrainOp,
} from "../shared/studio-ops.ts";
import { ID_PREFIX, sizeLabel, summarize, type Asset, type HtmlSource } from "../shared/assets.ts";
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

/**
 * Tools that only read. Claude Code runs read-only tools of one reply in parallel instead of
 * one after another, so several lookups cost one wait.
 */
const READ_ONLY = new Set(["list_assets", "get_asset", "studio_query", "studio_scripts", "studio_inspect", "studio_screenshot", "studio_console", "studio_state", "studio_audit"]);

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
      // Fixed-length tuples whose description already spells out the shape ("[x,y,z]").
      const n = node as JsonSchema;
      if ((k === "minItems" || k === "maxItems") && n.minItems === n.maxItems && typeof n.description === "string" && /\[[^\]]*,[^\]]*\]/.test(n.description)) continue;
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

/** Show a property as "anything" with a description (e.g. an asset id or an inline spec). */
function loose(s: JsonSchema, props: Record<string, string>): JsonSchema {
  for (const [key, description] of Object.entries(props)) if (s.properties?.[key]) s.properties[key] = { description };
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
  private listed: { name: string; description: string; inputSchema: any; annotations?: { readOnlyHint: boolean } }[];

  constructor(private deps: ForgeDeps) {
    this.tools = this.defineTools();
    this.byName = new Map(this.tools.map((t) => [t.name, t]));
    this.listed = this.tools.map((t) => {
      const schema = jsonSchema(t.schema);
      const inputSchema = t.advertise ? t.advertise(schema) : schema;
      return { name: t.name, description: t.description, inputSchema, ...(READ_ONLY.has(t.name) ? { annotations: { readOnlyHint: true } } : {}) };
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
    let extra = asset.kind === "animation"
      ? `, ${asset.spec.rig}, ${Math.round(animationLength(asset.spec) * 100) / 100}s`
      : asset.kind === "vfx" ? `: ${vfxSummary(asset.spec)}` : dims(asset);
    if (asset.kind === "ability") {
      const r = resolveStored(asset.spec);
      extra = `, ${asset.spec.rig}, ${r.length}s`;
      if (r.missing.length) warnings = [...warnings, `missing assets: ${r.missing.join(", ")}`];
    }
    const lines = [`${verb} ${asset.kind} "${asset.name}" (id ${asset.id}, v${asset.version}, ${sizeLabel(asset.kind, summarize(asset).size)}${extra}). Shown in the preview.`];
    if (warnings.length) lines.push(`Notes: ${warnings.slice(0, 8).join("; ")}`);
    // Problems Claude can fix before the user notices (floating parts, flicker, bent-back knees…).
    if (asset.kind === "model") lines.push(...describeIssues(checkModel(asset.spec)));
    if (asset.kind === "animation") lines.push(...checkAnimation(asset.spec).map((l) => `Check: ${l}`));
    if (asset.kind === "ability") {
      const r = resolveStored(asset.spec);
      if (r.animation && typeof asset.spec.animation !== "string") lines.push(...checkAnimation(r.animation).map((l) => `Check (animation): ${l}`));
    }
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
      id: prev?.id ?? shortId(ID_PREFIX[kind]),
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

  /** Run one generated Luau job in Studio and return its text result. */
  private async job(code: string, ctx: Ctx, what: string): Promise<ToolResult> {
    ctx.progress(`${what} in Studio…`);
    const out = unquote(await this.deps.bridge.runLuau(code));
    return text(clip(out || "nil"), out.startsWith("error:"));
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
        description: "Change an existing model: add parts, update parts by name (partial fields), bulk-change parts by filter (updateWhere), swap colors (recolor), remove by name, move or scale everything.",
        schema: ModelEditSchema.extend({
          id,
          add: z.array(PartInputSchema).optional(),
          styles: ModelSpecInputSchema.shape.styles,
        }),
        advertise: (s) => looseItems(s, {
          add: "new parts: same fields as create_model parts (style/repeat/copies allowed)",
          update: "partial updates matched by name: {name, ...any create_model part fields}; only listed fields change",
          styles: "styles for the added parts, as in create_model",
          updateWhere: "[{where: {name?, group?, material?, color?, shape?}, set?: {part fields}, move?: [x,y,z]}]: every part matching all filters (name: exact, base of numbered copies, or * wildcard; group includes subgroups)",
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
        description: "Change an existing UI: add nodes, update nodes by name (partial fields), bulk-change nodes by filter (updateWhere), swap colors (recolor), remove nodes (with descendants).",
        schema: UiEditSchema.extend({ id, add: z.array(UiNodeInputSchema).optional(), styles: UiStylesSchema }),
        advertise: (s) => looseItems(s, {
          add: "new nodes (appended; set parent): same fields as create_ui nodes (style allowed)",
          update: "partial updates matched by name: {name, ...any create_ui node fields}; only listed fields change",
          styles: "styles for the added nodes, as in create_ui",
          updateWhere: "[{where: {name?, type?, under? (node name), bg?, textColor?}, set: {node fields}}]: every node matching all filters (name: exact, base of numbered copies, or * wildcard)",
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
          "Create (or replace, with id) a character animation for an R15 or R6 rig. It plays live in the preview; importing saves a KeyframeSequence the Animation Editor can load onto a dummy rig. The result checks for bent-back joints, feet in the floor and loop jumps.",
        schema: AnimationSpecSchema.extend({ id: id.optional().describe("replace this existing animation") }),
        advertise: (s) => looseItems(s, {
          keyframes: `[{t: seconds, pose?: named pose (${POSE_NAMES.join("|")}), from?: t of a keyframe to copy, mirror?: flip pose/from left↔right, poses?: {joint: [x,y,z] degrees | {rot, pos}} (tweaks on top), ease?: linear|constant|cubic|elastic|bounce, dir?: in|out|inOut, name?}] — joints: root waist neck left/right Shoulder Elbow Wrist Hip Knee Ankle (hips/knees/… set both sides inside named poses only)`,
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
        description: "Change an animation: merge keyframes by time (only the joints you list change; a pose/from/mirror rebuilds that keyframe), remove keyframes or joints, retime with speed, set overlap, or switch rig/loop/priority.",
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
        description:
          "Write Script/LocalScript/ModuleScript(s) straight into Studio (not kept in the library). A script with the same name under the same parent is updated in place. Pass scripts to write several in one call.",
        schema: ScriptSpecSchema.partial().omit({ description: true }).extend({
          scripts: z.array(ScriptSpecSchema.omit({ description: true })).max(30).optional().describe("several scripts at once"),
        }),
        advertise: (s) => looseItems(s, { scripts: "[{name, kind, parent?, source}] like the single-script fields" }),
        run: async ({ scripts, ...one }, ctx) => {
          const list = [...(scripts ?? [])];
          if (one.name && one.kind && one.source !== undefined) list.push({ name: one.name, kind: one.kind, parent: one.parent, source: one.source });
          if (!list.length) return text("Give name, kind and source (or scripts).", true);
          ctx.progress(`Writing ${list.length} script${list.length > 1 ? "s" : ""} into Studio…`);
          type Written = { path: string; class: string; lines: number; updated: boolean };
          const r = await this.deps.bridge.runLuauJson<{ ok: boolean; error?: string; scripts?: Written[] | Record<string, Written> }>(scriptsToLuau(list).code);
          if (!r.ok) return text(`Studio: ${r.error}`, true);
          // forgeJson writes arrays as {"1": …}.
          const items: Written[] = Array.isArray(r.scripts) ? r.scripts : Object.values(r.scripts ?? {});
          return text(items.map((x) => `${x.updated ? "Updated" : "Created"} ${x.class} ${x.path} (${x.lines} lines)`).join("\n"));
        },
      },
      {
        name: "create_vfx",
        description:
          "Create (or replace, with id) a visual effect: particle emitters, beams, trails, fire, smoke, sparkles and lights around one root. Previews live in the browser; importing builds a Model (inside a BasePart parent it is welded on). One-shots: rate 0 + burst; play with require(effect.Play)(). Save tokens with presets: a whole effect ({preset, tint, scale}) or per emitter ({type: particles, preset, ...overrides}).",
        schema: VfxInputSchema.extend({ id: id.optional().describe("replace this existing effect") }),
        advertise: (s) => looseItems(s, {
          emitters: `[{name, type: particles|beam|trail|light|fire|smoke|sparkles, pos?: [x,y,z] studs from the root (y up)}]. particles: preset (${PARTICLE_PRESET_NAMES.join("|")}) then only fields to change, or texture (${TEXTURE_PRESETS.join("|")} or rbxassetid://), color ("#hex" | ["#a","#b"] | [[t,"#hex"],…]), size/transparency/squash (n | [from,to] | [[t,v,env?],…]), lifetime/speed/rotation/spin ([min,max] or n), rate, burst, delay, spread (deg), direction (up|down|left|right|front|back), accel [x,y,z], drag, lightEmission 0..1, brightness, orientation (camera|cameraUp|velocity|velocityPerp), shape (box|sphere|cylinder|disc) + shapeSize + surface/inward, flipbook {grid,mode,fps}, locked, zOffset. beam: from, to, width ([w0,w1]), curve [c0,c1], color, transparency, texture, textureLength, textureSpeed, textureMode, segments, faceCamera. trail: from, to (attachment offsets), lifetime, color, transparency, widthScale. light: kind point|spot, color, brightness, range, angle, face. fire: color, secondaryColor, heat, size. smoke: color, opacity, riseVelocity, size. sparkles: color.`,
        }),
        run: async ({ id: replaceId, ...raw }, ctx) => {
          const spec = expandVfxInput(raw);
          const asset = this.save("vfx", spec, replaceId);
          return this.afterSave(asset, replaceId ? "Replaced" : "Created", ctx);
        },
      },
      {
        name: "edit_vfx",
        description: "Change an effect: update emitters by name (only listed fields; null removes one; rename with rename), add or remove emitters, scale everything, tint (recolor everything to a hue), or change the preview motion.",
        schema: VfxEditSchema.extend({ id }),
        advertise: (s) => looseItems(s, {
          add: "new emitters, same format as create_vfx",
          update: "[{name, ...fields to change}]",
        }),
        run: async ({ id: assetId, ...edit }, ctx) => {
          const prev = assets.get(assetId);
          if (!prev || prev.kind !== "vfx") return text(`No effect with id ${assetId}.`, true);
          const { spec, missing } = applyVfxEdit(prev.spec, edit);
          const asset = this.save("vfx", spec, assetId);
          return this.afterSave(asset, "Edited", ctx, missing.length ? [`not found: ${missing.join(", ")}`] : []);
        },
      },
      {
        name: "create_ability",
        description:
          "Create (or replace, with id) an ability: an animation plus effects timed to it (fireballs, slams, auras, slashes), summons (a Stand behind the player, clones, spirits) and props (a sword in the hand, rock walls, thrown objects), previewed on an R15/R6 dummy. Import adds ReplicatedStorage.Abilities.<name> (require(...Play)(character) casts it) and a StarterPack Tool to try it.",
        schema: AbilitySpecInputSchema.extend({ id: id.optional().describe("replace this existing ability") }),
        advertise: (s) => looseItems(loose(s, { animation: "animation id (a_…) or inline {keyframes, loop?, priority?} as in create_animation" }), {
          summons: `[{at, duration?, name?, animation?: "caster" (mimics the caster in sync) | a_ id | inline keyframes, offset?: [x,y,z] from the caster (default [1.6,1,2.2]: behind the right shoulder; forward is -z), path?: [{t: s after it appears, offset}] (e.g. rush in front), turn?, color?, material?: ForceField|Neon|Glass|SmoothPlastic|Plastic, transparency?, scale? (1.15), appear?: fade|grow|pop, fade?, hover?, vfx?: aura (effect id or inline)}]`,
          props: `[{at, duration?, name?, model: m_ id | inline {parts} like create_model (origin = the grip; in a hand -y runs past the fingers, -z forward), attach? (default rightHand; ground/world for walls), offset?, rot?, follow?: part|character, scale?, appear?: fade|grow|pop|rise, vanish?: fade|shrink|pop|sink, fade?, spin? deg/s, travel?, impact?}]`,
          events: `[{at: seconds, vfx: effect id (v_…) or inline create_vfx input (e.g. {preset: ${EFFECT_PRESET_NAMES.slice(0, 3).join("|")}…, tint?, scale?} or {emitters}), attach?: ${ATTACH_POINTS.join("|")} (default root), offset?: [x,y,z] in the character's frame (x right, y up, z back; forward is -z), follow?: character|part, duration?: s (default 1), travel?: {velocity: [x,y,z] studs/s in the character's frame, gravity?, stopOnHit?}, impact?: effect id or inline effect played where it lands, scale?, name?}]`,
        }),
        run: async ({ id: replaceId, ...raw }, ctx) => {
          const spec = sanitizeAbilitySpec(expandAbilityInput(raw));
          const asset = this.save("ability", spec, replaceId);
          return this.afterSave(asset, replaceId ? "Replaced" : "Created", ctx);
        },
      },
      {
        name: "edit_ability",
        description: "Change an ability: update events by index (only listed fields; null removes one), add or remove events, replace summons or props (same format as create_ability), tint everything, or change rig, animation, length or cooldown.",
        schema: AbilityEditSchema.extend({ id }),
        advertise: (s) => looseItems(loose(s, { animation: "animation id or inline keyframes, as in create_ability" }), {
          add: "new events, same format as create_ability events",
          update: "[{index, ...fields to change}] (indexes as in get_asset, sorted by at)",
          summons: "replaces all summons; same format as create_ability ([] removes them)",
          props: "replaces all props; same format as create_ability ([] removes them)",
        }),
        run: async ({ id: assetId, ...edit }, ctx) => {
          const prev = assets.get(assetId);
          if (!prev || prev.kind !== "ability") return text(`No ability with id ${assetId}.`, true);
          const { spec, missing } = applyAbilityEdit(prev.spec, edit);
          const asset = this.save("ability", spec, assetId);
          return this.afterSave(asset, "Edited", ctx, missing.length ? [`no event at index ${missing.join(", ")}`] : []);
        },
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
          // Older script assets stay on disk but aren't part of the library anymore.
          const everything = assets.list().filter((a) => a.kind !== "script");
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
        description: "Import an asset into the open Roblox Studio place. Re-importing replaces the previous copy in place. Effects (vfx) imported with a BasePart parent are welded to it and follow it.",
        schema: z.object({
          id,
          parent: z.string().optional().describe("dot path, e.g. Workspace, ReplicatedStorage, StarterGui; effects: a part path or @selection to attach"),
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
        name: "studio_query",
        description:
          "Find instances in Studio and read properties in one call. Filters: path (root, default Workspace; \"@selection\": the selection and its contents), class (IsA), name (substring or Lua pattern), tag, attr, depth. props: properties to show, plus Pivot, Tags, Attributes, Children, Bounds (size at center), Parts (count), Lines. tree: true prints an outline instead (depth default 2) with class counts for collapsed branches.",
        schema: z.object({
          path: z.string().optional().describe("dot path, e.g. Workspace.Map; game for everything; @selection"),
          class: z.string().optional().describe("e.g. BasePart, Model, Script"),
          name: z.string().optional(),
          tag: z.string().optional(),
          attr: z.string().optional().describe("has this attribute"),
          depth: z.number().int().min(1).max(50).optional(),
          props: z.array(z.string()).max(20).optional(),
          limit: z.number().int().min(1).max(500).optional().describe("default 60 (tree 300)"),
          tree: z.boolean().optional(),
        }),
        run: async (q, ctx) => this.job(queryLuau(q), ctx, q.tree ? "Reading the tree" : "Searching"),
      },
      {
        name: "studio_edit",
        description:
          "Change Studio in one undoable step. target = path (\"@selection\": all selected), paths, or query (studio_query filters). Ops: set {target, props} (JSON converted to each property's type: Vector3 [x,y,z], Color3 \"#hex\", UDim2 [xs,xo,ys,yo], CFrame {pos,rot}, enum names, \"@Path\" refs; pseudo-props Pivot, Tags, Attributes, Parent). create {class, parent?, name?, props?, children?: [{class,name,props,children}]} (parts anchored by default). delete {target}. clone {path, count?, offset? per copy, parent?, name?}. move {target, by?, rotate? degrees, to? {pos,rot}, parent?}. group {target, name?, class? Model|Folder}, ungroup {target}. weld {target, to?, unanchor?}: one rigid body. scale {target, factor}. focus {path?}: aim the user's camera. insert {assetId, at? ground point (default: camera focus), parent?}: Creator Store model. select {target}.",
        schema: z.object({
          ops: z.array(z.object({ op: z.enum(["set", "create", "delete", "clone", "move", "group", "ungroup", "weld", "scale", "focus", "insert", "select"]) }).catchall(z.any())).min(1).max(200),
        }),
        advertise: (s) => looseItems(s, { ops: "[{op, ...fields as described}]" }),
        run: async ({ ops }, ctx) => this.job(editLuau(ops as EditOp[]), ctx, `Applying ${ops.length} change${ops.length > 1 ? "s" : ""}`),
      },
      {
        name: "studio_undo",
        description: "Undo (or redo) the last changes in Studio, like Ctrl+Z. Each create/import/studio_edit call is one step.",
        schema: z.object({ steps: z.number().int().min(1).max(20).optional(), redo: z.boolean().optional() }),
        run: async ({ steps, redo }, ctx) => this.job(undoLuau(steps ?? 1, !!redo), ctx, redo ? "Redoing" : "Undoing"),
      },
      {
        name: "studio_scripts",
        description: "Scripts in the place. read: numbered source of scripts, each \"Path\" or \"Path:from-to\". pattern: search all sources (case-insensitive text, or Lua pattern with regex) for path:line matches with optional context lines. Neither: list scripts with line counts.",
        schema: z.object({
          read: z.array(z.string()).max(20).optional().describe('e.g. ["ServerScriptService.Main", "ReplicatedStorage.Util:40-90"]'),
          pattern: z.string().optional(),
          regex: z.boolean().optional(),
          path: z.string().optional().describe("search under this path (default whole game)"),
          context: z.number().int().min(0).max(3).optional(),
          limit: z.number().int().min(1).max(300).optional(),
        }),
        run: async ({ read, ...q }, ctx) => {
          if (!read?.length) return this.job(scriptSearchLuau(q), ctx, q.pattern ? "Searching scripts" : "Listing scripts");
          const reading = await this.job(scriptReadLuau(read.map(parseScriptRead)), ctx, `Reading ${read.length} script${read.length > 1 ? "s" : ""}`);
          if (!q.pattern) return reading;
          const found = await this.job(scriptSearchLuau(q), ctx, "Searching scripts");
          return { content: [...reading.content, ...found.content] };
        },
      },
      {
        name: "studio_script_patch",
        description:
          "Edit several scripts in one call (one undo step). Each: path plus edits [{old, new, all?}] (exact text without line numbers; old must match once unless all) or source (whole script; creates it if missing, with class). Prefer edits for changes.",
        schema: z.object({
          scripts: z.array(z.object({
            path: z.string().describe("e.g. ServerScriptService.Main"),
            edits: z.array(z.object({ old: z.string(), new: z.string(), all: z.boolean().optional() })).optional(),
            source: z.string().optional(),
            class: z.enum(["Script", "LocalScript", "ModuleScript"]).optional().describe("when creating"),
          })).min(1).max(30),
        }),
        run: async ({ scripts }, ctx) => this.job(scriptPatchLuau(scripts), ctx, `Editing ${scripts.length} script${scripts.length > 1 ? "s" : ""}`),
      },
      {
        name: "studio_audit",
        description: "Check the place (or one path) for what breaks or slows a game: parts that will fall or vanish at play, scripts in places they never run, LocalPlayer in server scripts, deprecated APIs (wait, spawn, :connect, BodyMovers), invisible colliders, duplicate parts, heavy models, missing SpawnLocation, shadow-casting lights.",
        schema: z.object({ path: z.string().optional().describe("default the whole place") }),
        run: async ({ path }, ctx) => this.job(auditLuau(path ?? "game"), ctx, "Auditing the place"),
      },
      {
        name: "studio_lighting",
        description: `Set the mood in one call: a preset (${Object.keys(LIGHTING_PRESETS).join(", ")}) and/or Lighting properties (ClockTime, Brightness, Ambient, OutdoorAmbient, FogEnd…) plus Atmosphere, Bloom, ColorCorrection, SunRays and DepthOfField properties (false removes the effect).`,
        schema: z.object({
          preset: z.enum(Object.keys(LIGHTING_PRESETS) as [keyof typeof LIGHTING_PRESETS, ...(keyof typeof LIGHTING_PRESETS)[]]).optional(),
          lighting: z.record(z.string(), z.any()).optional(),
          atmosphere: z.union([z.record(z.string(), z.any()), z.literal(false)]).optional(),
          bloom: z.union([z.record(z.string(), z.any()), z.literal(false)]).optional(),
          colorCorrection: z.union([z.record(z.string(), z.any()), z.literal(false)]).optional(),
          sunRays: z.union([z.record(z.string(), z.any()), z.literal(false)]).optional(),
          depthOfField: z.union([z.record(z.string(), z.any()), z.literal(false)]).optional(),
        }),
        advertise: (s) => {
          const props: Record<string, JsonSchema> = { preset: s.properties.preset, lighting: { type: "object", description: "Lighting properties" } };
          for (const k of ["atmosphere", "bloom", "colorCorrection", "sunRays", "depthOfField"]) props[k] = { type: ["object", "boolean"] };
          return { ...s, properties: props };
        },
        run: async (input, ctx) => this.job(lightingLuau(input), ctx, "Setting the lighting"),
      },
      {
        name: "studio_terrain",
        description:
          "Sculpt terrain with a list of ops: block|wedge {material, pos, size, rot?}, ball {material, pos, radius}, cylinder {material, pos, radius, height, rot?}, clear {min?, max?} (no region = everything), replace {from, to, min, max}, hills {center [x,y,z], size [x,z], height, material?, under?, seed?, scale?, water? (level)} generates rolling ground. Materials are Enum.Material names (Grass, Rock, Sand, Water, Snow, Mud, Ground, LeafyGrass, Basalt…).",
        schema: z.object({
          ops: z.array(z.object({ op: z.enum(["block", "wedge", "ball", "cylinder", "clear", "replace", "hills"]) }).catchall(z.any())).min(1).max(100),
        }),
        advertise: (s) => looseItems(s, { ops: "[{op, ...fields as described}]" }),
        run: async ({ ops }, ctx) => this.job(terrainLuau(ops as TerrainOp[]), ctx, "Sculpting terrain"),
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
        name: "studio_playtest",
        description:
          "Play-test in one call: start, let it run for seconds, collect the Output (errors and warnings first), then stop. keep: true leaves it running (inspect with studio_execute_luau datamodel Server/Client, stop with mode stop). mode start/stop only starts or stops.",
        schema: z.object({
          seconds: z.number().min(1).max(60).optional().describe("default 5"),
          keep: z.boolean().optional(),
          mode: z.enum(["test", "start", "stop"]).optional(),
        }),
        run: async ({ seconds, keep, mode }, ctx) => {
          const legacy = this.deps.bridge.status.flavor === "legacy";
          const play = (start: boolean) => this.deps.bridge.callTool("start_stop_play", legacy ? { mode: start ? "start_play" : "stop" } : { is_start: start });
          if (mode === "start" || mode === "stop") return forward(await play(mode === "start"));
          const consoleText = () => this.deps.bridge.callTool("get_console_output", {}).then(resultText, (e) => String(e));
          const before = await consoleText();
          const started = await play(true);
          if (started.isError) return forward(started);
          const wait = Math.round((seconds ?? 5) * 1000);
          for (let t = 0; t < wait; t += 1000) {
            ctx.progress(`Play-testing… ${Math.ceil((wait - t) / 1000)}s left`);
            await new Promise((r) => setTimeout(r, Math.min(1000, wait - t)));
          }
          const output = await consoleText();
          if (!keep) await play(false).catch(() => undefined);
          return text(summarizeOutput(output, before) + (keep ? "\n(still running: stop with mode stop)" : "\n(stopped)"));
        },
      },
      {
        name: "permission_prompt",
        description: "Internal (permission prompts). Never call it.",
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
const GATED = new Set(["studio_execute_luau", "studio_script_patch"]);

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

/** The Output lines of this run (what was already there before is skipped), problems first, kept short. */
export function summarizeOutput(output: string, before = ""): string {
  // Studio may clear the Output when play starts; otherwise drop what was there before.
  const fresh = before && output.startsWith(before) ? output.slice(before.length) : output;
  const lines = fresh.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const problems = lines.filter((l) => /error|exception|warn|stack|infinite yield|attempt to|nil value|failed/i.test(l));
  const tail = lines.slice(-30);
  const parts = [`Output: ${lines.length} line${lines.length === 1 ? "" : "s"}, ${problems.length} problem${problems.length === 1 ? "" : "s"}.`];
  if (problems.length) parts.push("Problems:", ...problems.slice(0, 30).map((l) => l.slice(0, 300)));
  if (tail.length) parts.push("Last lines:", ...tail.filter((l) => !problems.slice(0, 30).includes(l)).map((l) => l.slice(0, 300)));
  return parts.join("\n");
}
