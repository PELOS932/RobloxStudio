// The "forge" MCP server that Claude Code connects to (streamable HTTP, one URL per conversation).
// It exposes compact asset tools plus a curated, studio_id-free view of Roblox Studio's own tools.
// The tool list is static so Claude Code's prompt prefix (and cache) stays stable.

import { z } from "zod";
import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { assets, bus, shortId } from "./store.ts";
import { importAsset, pullSelection } from "./importer.ts";
import { resultText, type StudioBridge, type ToolCallResult } from "./studio-bridge.ts";
import { MCP_TOKEN } from "./config.ts";
import {
  applyModelEdit, ModelEditSchema, ModelSpecSchema, sanitizeModelSpec, toNativeModel,
} from "../shared/model.ts";
import { applyUiEdit, sanitizeUiSpec, UiEditSchema, UiSpecSchema } from "../shared/ui.ts";
import { ScriptSpecSchema } from "../shared/script.ts";
import { sizeLabel, summarize, type Asset } from "../shared/assets.ts";
import type { ImportResult, PermissionRequest, Settings } from "../shared/protocol.ts";

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject;
  run: (args: any, ctx: Ctx) => Promise<ToolResult>;
}

interface Ctx {
  convId: string;
}

export interface ForgeDeps {
  bridge: StudioBridge;
  getSettings: () => Settings;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
const MAX_TEXT = 20_000;

function jsonSchema(schema: z.ZodObject) {
  const s = z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete s.$schema;
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

  constructor(private deps: ForgeDeps) {
    this.tools = this.defineTools();
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
    const ctx: Ctx = { convId: String(req.params.convId ?? "") };
    const server = new Server({ name: "forge", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchema(t.schema) as any })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = this.tools.find((t) => t.name === request.params.name);
      if (!tool) return text(`Unknown tool ${request.params.name}`, true);
      const parsed = tool.schema.safeParse(request.params.arguments ?? {});
      if (!parsed.success) return text(`Invalid arguments: ${z.prettifyError(parsed.error)}`, true);
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

  private async afterSave(asset: Asset, verb: string, warnings: string[] = []): Promise<ToolResult> {
    const lines = [`${verb} ${asset.kind} "${asset.name}" (id ${asset.id}, v${asset.version}, ${sizeLabel(asset.kind, summarize(asset).size)}${dims(asset)}). Shown in the preview.`];
    if (warnings.length) lines.push(`Notes: ${warnings.slice(0, 8).join("; ")}`);
    const s = this.deps.getSettings();
    if (s.autoImport && this.deps.bridge.connected && this.deps.bridge.status.studioId) {
      lines.push(importLine(await importAsset(this.deps.bridge, s, asset.id)));
    }
    return text(lines.join("\n"));
  }

  private save<K extends Asset["kind"]>(kind: K, spec: Extract<Asset, { kind: K }>["spec"], replaceId?: string): Asset {
    const now = Date.now();
    const prev = replaceId ? assets.get(replaceId) : undefined;
    if (replaceId && (!prev || prev.kind !== kind)) throw new Error(`No ${kind} asset with id ${replaceId}.`);
    const asset = {
      id: prev?.id ?? shortId(kind === "model" ? "m_" : kind === "ui" ? "u_" : "s_"),
      kind,
      name: spec.name,
      description: (spec as { description?: string }).description,
      spec,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      version: (prev?.version ?? 0) + 1,
      origin: "claude",
      lastImport: prev?.lastImport,
    } as Asset;
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
        description: "Create (or fully replace, with id) a 3D model made of Roblox parts. Prefer edit_model for changes.",
        schema: ModelSpecSchema.extend({ id: id.optional().describe("replace this existing model") }),
        run: async ({ id: replaceId, ...spec }) => {
          const asset = this.save("model", sanitizeModelSpec(spec), replaceId);
          return this.afterSave(asset, replaceId ? "Replaced" : "Created");
        },
      },
      {
        name: "edit_model",
        description: "Change an existing model: add parts, update parts by name (partial fields), remove by name, move or scale everything.",
        schema: ModelEditSchema.extend({ id }),
        run: async ({ id: assetId, ...edit }) => {
          const prev = assets.get(assetId);
          if (!prev || prev.kind !== "model") return text(`No model with id ${assetId}.`, true);
          const { spec, missing } = applyModelEdit(prev.spec, edit);
          const asset = this.save("model", spec, assetId);
          return this.afterSave(asset, "Edited", missing.length ? [`not found: ${missing.join(", ")}`] : []);
        },
      },
      {
        name: "create_ui",
        description: "Create (or fully replace, with id) a ScreenGui from a flat list of Roblox GUI nodes. Prefer edit_ui for changes.",
        schema: UiSpecSchema.extend({ id: id.optional().describe("replace this existing UI") }),
        run: async ({ id: replaceId, ...raw }) => {
          const { spec, warnings } = sanitizeUiSpec(raw);
          const asset = this.save("ui", spec, replaceId);
          return this.afterSave(asset, replaceId ? "Replaced" : "Created", warnings);
        },
      },
      {
        name: "edit_ui",
        description: "Change an existing UI: add nodes, update nodes by name (partial fields), remove nodes (with descendants).",
        schema: UiEditSchema.extend({ id }),
        run: async ({ id: assetId, ...edit }) => {
          const prev = assets.get(assetId);
          if (!prev || prev.kind !== "ui") return text(`No UI with id ${assetId}.`, true);
          const { spec, missing, warnings } = applyUiEdit(prev.spec, edit);
          const asset = this.save("ui", spec, assetId);
          return this.afterSave(asset, "Edited", [...(missing.length ? [`not found: ${missing.join(", ")}`] : []), ...warnings]);
        },
      },
      {
        name: "create_script",
        description: "Create (or replace, with id) a Script/LocalScript/ModuleScript that is inserted at a path in the place.",
        schema: ScriptSpecSchema.extend({ id: id.optional().describe("replace this existing script") }),
        run: async ({ id: replaceId, ...spec }) => this.afterSave(this.save("script", spec, replaceId), replaceId ? "Replaced" : "Created"),
      },
      {
        name: "list_assets",
        description: "List assets in the library (id, kind, name, size, version, last Studio import).",
        schema: z.object({}),
        run: async () => {
          const list = assets.list();
          if (!list.length) return text("No assets yet.");
          return text(list.slice(0, 60).map((a) => `${a.id} ${a.kind} "${a.name}" v${a.version} ${sizeLabel(a.kind, a.size)}${a.lastImport ? ` → ${a.lastImport.path}` : ""}`).join("\n"));
        },
      },
      {
        name: "get_asset",
        description: "Return an asset's full spec as JSON (needed before editing assets made outside this conversation).",
        schema: z.object({ id }),
        run: async ({ id: assetId }) => {
          const a = assets.get(assetId);
          if (!a) return text(`No asset with id ${assetId}.`, true);
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
        run: async ({ id: assetId, ...opts }) => {
          const r = await importAsset(this.deps.bridge, this.deps.getSettings(), assetId, opts);
          return text(importLine(r), !r.ok);
        },
      },
      {
        name: "studio_pull_selection",
        description: "Read the current Roblox Studio selection (Parts/Models or a ScreenGui/GUI objects) into a new editable asset.",
        schema: z.object({}),
        run: async () => {
          const r = await pullSelection(this.deps.bridge);
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
        run: async ({ code, datamodel }) => {
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
