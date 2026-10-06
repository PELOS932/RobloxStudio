// Single MCP client connection to Roblox Studio.
//
// Primary target: the MCP server built into Roblox Studio (StudioMCP; tools such as
// execute_luau, list_roblox_studios, screen_capture). The deprecated
// studio-rust-mcp-server (run_code, ...) is supported as a fallback.
// Studio Forge is the only process that talks to Studio; Claude reaches Studio
// through Forge's own MCP tools, which forward here.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bus } from "./store.ts";
import { detectStudioCommand } from "./config.ts";
import type { Settings, StudioStatus } from "../shared/protocol.ts";

export interface ToolContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolCallResult {
  content: ToolContent[];
  isError: boolean;
}

export class StudioError extends Error {}

const LUAU_TIMEOUT_MS = 120_000;

export class StudioBridge {
  status: StudioStatus = { state: "disconnected", studios: [] };
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private connecting: Promise<void> | null = null;
  private stderrTail: string[] = [];

  constructor(private getSettings: () => Settings) {}

  private setStatus(patch: Partial<StudioStatus>) {
    this.status = { ...this.status, ...patch };
    bus.emitEvent({ type: "studio", status: this.status });
  }

  resolveCommand(): { command: string; args: string[] } | null {
    const s = this.getSettings().studio;
    if (s.command.trim()) return { command: s.command.trim(), args: s.args };
    return detectStudioCommand();
  }

  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async doConnect() {
    await this.disconnect(false);
    const cmd = this.resolveCommand();
    if (!cmd) {
      this.setStatus({
        state: "unconfigured",
        detail: "Roblox Studio's MCP server was not found. Install Roblox Studio, or set the StudioMCP command in Settings.",
        studios: [],
        studioId: undefined,
      });
      return;
    }
    const label = [cmd.command, ...cmd.args].join(" ");
    this.setStatus({ state: "connecting", detail: undefined, command: label });
    try {
      const transport = new StdioClientTransport({
        command: cmd.command,
        args: cmd.args,
        env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")),
        stderr: "pipe",
      });
      // Drain stderr (an unread pipe can fill up and stall the server); keep the tail for errors.
      const stderrTail: string[] = [];
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderrTail.push(...String(chunk).split(/\r?\n/).filter(Boolean));
        stderrTail.splice(0, Math.max(0, stderrTail.length - 20));
      });
      this.stderrTail = stderrTail;
      const client = new Client({ name: "studio-forge", version: "0.1.0" });
      transport.onclose = () => {
        if (this.transport === transport) {
          this.client = null;
          this.transport = null;
          this.stopPolling();
          this.setStatus({ state: "disconnected", detail: "Studio MCP process exited.", studios: [], studioId: undefined });
        }
      };
      await withTimeout(client.connect(transport), 20_000, "Timed out starting the Studio MCP server.");
      this.client = client;
      this.transport = transport;
      const { tools } = await client.listTools();
      this.tools = new Set(tools.map((t) => t.name));
      const flavor = this.tools.has("execute_luau") ? "builtin" : this.tools.has("run_code") ? "legacy" : undefined;
      if (!flavor) throw new StudioError(`Connected, but the server exposes no Luau tool (tools: ${[...this.tools].join(", ")}).`);
      this.setStatus({ state: "connected", flavor, detail: undefined });
      if (flavor === "builtin") {
        await this.refreshStudios();
        this.startPolling();
      } else {
        this.setStatus({ studios: [{ id: "legacy", name: "Roblox Studio (legacy plugin)" }], studioId: "legacy" });
      }
    } catch (err) {
      await this.disconnect(false);
      const tail = this.stderrTail.slice(-3).join(" | ");
      this.setStatus({ state: "error", detail: errorText(err) + (tail ? ` (${tail})` : ""), studios: [], studioId: undefined });
    }
  }

  async disconnect(report = true) {
    this.stopPolling();
    const t = this.transport;
    this.client = null;
    this.transport = null;
    if (t) await t.close().catch(() => {});
    if (report) this.setStatus({ state: "disconnected", detail: undefined, studios: [], studioId: undefined });
  }

  private startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.refreshStudios().catch(() => {}), 10_000);
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Built-in server: which Studio windows (places) are available. */
  async refreshStudios() {
    if (!this.client || this.status.flavor !== "builtin") return;
    const res = (await this.client.callTool({ name: "list_roblox_studios", arguments: {} })) as ToolCallResult;
    const text = res.content.map((c) => c.text ?? "").join("\n");
    const studios = parseStudios(text);
    const keep = studios.find((s) => s.id === this.status.studioId);
    const studioId = keep?.id ?? studios[0]?.id;
    const changed = JSON.stringify(studios) !== JSON.stringify(this.status.studios) || studioId !== this.status.studioId;
    if (changed) {
      this.setStatus({
        studios,
        studioId,
        detail: studios.length ? undefined : "Connected — open a place in Roblox Studio and enable “Studio as MCP server” in the Assistant settings.",
      });
    }
  }

  selectStudio(id: string) {
    if (this.status.studios.some((s) => s.id === id)) this.setStatus({ studioId: id });
  }

  get connected() {
    return this.status.state === "connected" && !!this.client;
  }

  hasTool(name: string) {
    return this.tools.has(name);
  }

  /** Call a native Studio tool. Built-in tools get studio_id filled in automatically. */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs = LUAU_TIMEOUT_MS): Promise<ToolCallResult> {
    if (!this.client) {
      if (this.getSettings().studio.autoConnect && this.status.state !== "unconfigured") await this.connect();
      if (!this.client) throw new StudioError(this.status.detail ?? "Roblox Studio is not connected.");
    }
    if (!this.tools.has(name)) throw new StudioError(`This Studio MCP server has no "${name}" tool.`);
    const run = async () => {
      const finalArgs = { ...args };
      if (this.status.flavor === "builtin" && name !== "list_roblox_studios") {
        if (!this.status.studioId) await this.refreshStudios();
        if (!this.status.studioId) throw new StudioError("No Roblox Studio place is open (or Studio's MCP server toggle is off).");
        finalArgs.studio_id = this.status.studioId;
      }
      return (await withTimeout(
        this.client!.callTool({ name, arguments: finalArgs }, undefined, { timeout: timeoutMs }),
        timeoutMs + 5_000,
        `Studio did not answer "${name}" within ${Math.round(timeoutMs / 1000)}s.`,
      )) as ToolCallResult;
    };
    let res = await run();
    // Stale studio_id (Studio restarted): refresh once and retry.
    if (res.isError && /out of date|studio_id|studio instance/i.test(resultText(res)) && this.status.flavor === "builtin") {
      await this.refreshStudios();
      res = await run();
    }
    return res;
  }

  /** Run Luau in the Edit data model and return its result text. Throws on Luau errors. */
  async runLuau(code: string, datamodel: "Edit" | "Client" | "Server" = "Edit"): Promise<string> {
    if (this.status.flavor === "legacy") {
      const res = await this.callTool("run_code", { command: code });
      const text = resultText(res);
      const err = text.match(/\[UNEXPECTED ERROR\]\s*([\s\S]*)/);
      if (res.isError || err) throw new StudioError(err?.[1]?.trim() || text);
      const ret = text.match(/\[RETURNED RESULTS\]\s*([\s\S]*?)(?:\n\[(?:OUTPUT|WARNING)\]|$)/);
      return (ret?.[1] ?? text).trim();
    }
    const res = await this.callTool("execute_luau", { code, datamodel_type: datamodel });
    const text = resultText(res);
    if (res.isError) throw new StudioError(text || "execute_luau failed");
    return text;
  }

  /** Run Luau that returns a JSON string and parse it. */
  async runLuauJson<T = Record<string, unknown>>(code: string): Promise<T> {
    return extractJson(await this.runLuau(code)) as T;
  }
}

export function resultText(res: ToolCallResult): string {
  return (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

/** execute_luau serializes return values; accept raw JSON, a quoted JSON string, or JSON embedded in text. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const attempts = [t];
  const first = t.indexOf("{"), last = t.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(t.slice(first, last + 1));
  for (const a of attempts) {
    try {
      let v = JSON.parse(a);
      if (typeof v === "string") v = JSON.parse(v);
      if (v && typeof v === "object") return v;
    } catch {
      // Try the next form.
    }
  }
  throw new StudioError(`Unexpected response from Studio: ${t.slice(0, 300)}`);
}

export function parseStudios(text: string): { id: string; name: string }[] {
  try {
    const v = JSON.parse(text);
    const list: unknown[] = Array.isArray(v) ? v : Array.isArray(v?.studios) ? v.studios : [];
    return list
      .map((s) => {
        const o = s as Record<string, unknown>;
        const id = String(o.id ?? o.studio_id ?? o.studioId ?? "");
        const place = o.placeId ?? o.place_id;
        const name = String(o.name ?? (place ? `Place ${place}` : id));
        return { id, name };
      })
      .filter((s) => s.id);
  } catch {
    return [];
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new StudioError(message)), ms))),
  ]);
}

/** execute_luau may hand back a returned string JSON-quoted; show it as plain text. */
export function unquote(out: string): string {
  const t = out.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const v = JSON.parse(t);
      if (typeof v === "string") return v;
    } catch {
      // Not JSON: keep as is.
    }
  }
  return t;
}
