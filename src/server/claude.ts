// Runs Claude Code headless (`claude -p --input-format stream-json --output-format stream-json`)
// as one long-lived background process per conversation. Keeping the process alive keeps
// the prompt prefix identical between turns, so Anthropic's prompt cache serves almost all
// input tokens. Sessions are resumed with --resume after restarts or settings changes.
//
// Authentication is whatever the local Claude Code CLI is signed in with (a Claude
// subscription via `claude auth login`, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_API_KEY).
// Studio Forge never sees or stores those credentials.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bus, conversations, shortId } from "./store.ts";
import { DATA_DIR, MCP_TOKEN } from "./config.ts";
import { FORGE_SYSTEM_PROMPT } from "./system-prompt.ts";
import type { ForgeMcp } from "./forge-mcp.ts";
import type {
  Block, ChatMessage, ClaudeStatus, Conversation, ConvStatus, QueuedMessage, Settings, TurnUsage,
} from "../shared/protocol.ts";

const IDLE_KILL_MS = 20 * 60_000;
const RUN_DIR = join(DATA_DIR, "run");
const PROMPT_FILE = join(RUN_DIR, "system-prompt.md");

export interface ClaudeDeps {
  getSettings: () => Settings;
  forge: ForgeMcp;
  port: number;
}

interface Pending {
  id?: string;
  text: string;
  images?: { mediaType: string; data: string }[];
}

/** Spawn the CLI; on Windows npm installs are .cmd shims that need a shell. */
export function spawnCli(cmd: string, args: string[], opts: Parameters<typeof spawn>[2]): ChildProcess {
  if (process.platform === "win32" && !/\.exe$/i.test(cmd)) {
    const q = (s: string) => (/[\s"&|<>^]/.test(s) || s === "" ? `"${s.replace(/"/g, '\\"')}"` : s);
    return spawn(q(cmd), args.map(q), { ...opts, shell: true });
  }
  return spawn(cmd, args, opts);
}

/**
 * Variables that tie a process to a *running* Claude Code session. If Studio Forge was started
 * from inside Claude Code they would make the background CLI impersonate that session, so they
 * are dropped. Auth and provider variables (ANTHROPIC_*, CLAUDE_CODE_OAUTH_TOKEN, ...) are kept.
 */
const SESSION_SCOPED_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AFTER_LAST_COMPACT|CLAUDE_CODE_(SESSION_ID|ENTRYPOINT|CHILD_SESSION|REMOTE_SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|TEE_SDK_STDOUT|DIAGNOSTICS_FILE|WORKER_EPOCH|SESSION_ATTENDED|SYNC_SESSION_REFS|EXECPATH))$/;

export function cliEnv(settings: Settings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SESSION_SCOPED_ENV.test(k)) env[k] = v;
  env.MCP_TOOL_TIMEOUT = "900000"; // permission prompts and Studio imports can take a while
  if (settings.longCache) env.ENABLE_PROMPT_CACHING_1H = "1";
  else delete env.ENABLE_PROMPT_CACHING_1H;
  return env;
}

// ---------------------------------------------------------------------------

class TurnState {
  msg: ChatMessage;
  indexMap = new Map<number, number>();
  streamed = new Set<string>();
  startedAt = Date.now();
  contextTokens = 0;
  constructor(msg: ChatMessage) {
    this.msg = msg;
  }
  toolBlock(id: string) {
    return this.msg.blocks.find((b): b is Extract<Block, { type: "tool" }> => b.type === "tool" && b.id === id);
  }
}

class ClaudeSession {
  proc: ChildProcess | null = null;
  status: ConvStatus = "idle";
  turn: TurnState | null = null;
  queue: Pending[] = [];
  fingerprint = "";
  stderr: string[] = [];
  private emitTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private resumeRetried = false;
  private sawOutput = false;

  constructor(readonly convId: string, private deps: ClaudeDeps) {}

  private get conv(): Conversation | undefined {
    return conversations.get(this.convId);
  }

  private setStatus(status: ConvStatus, error?: string) {
    this.status = status;
    bus.emitEvent({ type: "status", convId: this.convId, status, error });
  }

  private emitMessage(immediate = false) {
    const send = () => {
      this.emitTimer = null;
      if (!this.turn) return;
      // While a tool input streams, the UI gets its tail plus its size and item count
      // (parts or UI nodes so far), so it can show live progress without the whole payload.
      const msg = this.turn.msg;
      const message = msg.blocks.some((b) => b.type === "tool" && b.inputPartial)
        ? {
            ...msg,
            blocks: msg.blocks.map((b) => {
              if (b.type !== "tool" || !b.inputPartial) return b;
              const p = b.inputPartial;
              return {
                ...b,
                inputPartial: p.length > 4000 ? "…" + p.slice(-2000) : p,
                inputChars: p.length,
                inputItems: (p.match(/"(?:pos|type)"\s*:/g) ?? []).length,
              };
            }),
          }
        : msg;
      bus.emitEvent({ type: "message", convId: this.convId, message });
    };
    if (immediate) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      send();
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(send, 40);
    }
  }

  /** The visible part of the queue (images stay server-side). */
  get queued(): QueuedMessage[] {
    return this.queue.map((q) => ({ id: q.id!, text: q.text }));
  }

  private emitQueue() {
    bus.emitEvent({ type: "queue", convId: this.convId, items: this.queued });
  }

  /** Show a live status line on the newest running call of a tool. */
  toolProgress(toolName: string, text: string) {
    const blocks = this.turn?.msg.blocks ?? [];
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.type === "tool" && b.name === toolName && b.status === "running") {
        b.progress = text;
        this.emitMessage();
        return;
      }
    }
  }

  unqueue(id: string) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.id !== id);
    if (this.queue.length !== before) this.emitQueue();
  }

  send(p: Pending) {
    if (this.status !== "idle") {
      this.queue.push({ ...p, id: p.id ?? shortId("q_") });
      this.emitQueue();
      return;
    }
    const conv = this.conv;
    if (!conv) return;
    const user: ChatMessage = {
      id: shortId("msg_"),
      role: "user",
      blocks: [{ type: "text", text: p.text }],
      createdAt: Date.now(),
    };
    if (conv.messages.length === 0 && conv.title === "New chat") conv.title = p.text.replace(/^(?:@[mus]_[a-z0-9]{6}\s+)+/, "").replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
    conv.messages.push(user);
    bus.emitEvent({ type: "message", convId: this.convId, message: user });
    const assistant: ChatMessage = { id: shortId("msg_"), role: "assistant", blocks: [], createdAt: Date.now(), model: this.deps.getSettings().model };
    conv.messages.push(assistant);
    this.turn = new TurnState(assistant);
    conversations.save(conv);
    this.emitMessage(true);

    const content: unknown[] = [{ type: "text", text: p.text }];
    for (const img of p.images ?? []) {
      content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
    }
    const line = JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null }) + "\n";

    const settings = this.deps.getSettings();
    const fp = fingerprint(settings);
    if (this.proc && this.fingerprint !== fp) this.kill();
    if (!this.proc) {
      this.setStatus("starting");
      try {
        this.spawn(settings, fp);
      } catch (err) {
        this.fail(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    this.setStatus("running");
    this.proc!.stdin!.write(line);
    this.touch();
  }

  private spawn(settings: Settings, fp: string) {
    const conv = this.conv!;
    mkdirSync(settings.workspaceDir, { recursive: true });
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(PROMPT_FILE, FORGE_SYSTEM_PROMPT);
    const mcpFile = join(RUN_DIR, `mcp-${this.convId}.json`);
    writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          forge: {
            type: "http",
            url: `http://127.0.0.1:${this.deps.port}/mcp/${this.convId}`,
            headers: { Authorization: `Bearer ${MCP_TOKEN}` },
          },
        },
      }),
    );

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", settings.model,
      "--mcp-config", mcpFile,
      "--strict-mcp-config",
      "--append-system-prompt-file", PROMPT_FILE,
      "--exclude-dynamic-system-prompt-sections",
      "--setting-sources", "user",
      "--permission-prompt-tool", "mcp__forge__permission_prompt",
      "--allowedTools", this.deps.forge.allowedToolNames().join(","),
    ];
    if (settings.toolMode === "studio") args.push("--tools", "");
    else args.push("--permission-mode", "acceptEdits");
    if (settings.effort !== "default") args.push("--effort", settings.effort);
    if (conv.claudeSessionId) args.push("--resume", conv.claudeSessionId);

    this.stderr = [];
    this.sawOutput = false;
    const proc = spawnCli(settings.claudePath, args, {
      cwd: settings.workspaceDir,
      env: cliEnv(settings),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    this.fingerprint = fp;

    createInterface({ input: proc.stdout! }).on("line", (l) => {
      if (this.proc !== proc) return;
      this.sawOutput = true;
      let obj: any;
      try {
        obj = JSON.parse(l);
      } catch {
        return;
      }
      this.onEvent(obj);
    });
    createInterface({ input: proc.stderr! }).on("line", (l) => {
      this.stderr.push(l);
      if (this.stderr.length > 40) this.stderr.shift();
    });
    proc.on("error", (err) => {
      if (this.proc !== proc) return;
      this.proc = null;
      const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `Claude Code CLI not found ("${settings.claudePath}"). Install it (npm i -g @anthropic-ai/claude-code) or set its path in Settings.`
        : err.message;
      this.fail(msg);
    });
    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.status === "idle") return;
      const tail = this.stderr.join("\n").trim();
      // A stale --resume id: retry once as a fresh session.
      if (!this.sawOutput && conv.claudeSessionId && !this.resumeRetried && /no conversation found|session/i.test(tail)) {
        this.resumeRetried = true;
        conv.claudeSessionId = undefined;
        bus.emitEvent({ type: "toast", level: "info", message: "Previous Claude session could not be resumed; starting a fresh one." });
        const pending = this.turn;
        if (pending) {
          // Re-send the last user message.
          const lastUser = [...conv.messages].reverse().find((m) => m.role === "user");
          conv.messages = conv.messages.filter((m) => m !== pending.msg && m !== lastUser);
          this.turn = null;
          this.setStatus("idle");
          const text = lastUser?.blocks.find((b) => b.type === "text");
          if (text && text.type === "text") this.send({ text: text.text });
        }
        return;
      }
      this.fail(tail ? `Claude Code exited (code ${code}): ${tail.slice(-1200)}` : `Claude Code exited (code ${code}).`);
    });
  }

  private onEvent(obj: any) {
    const conv = this.conv;
    if (!conv) return;
    if (obj.type === "system" && obj.subtype === "init") {
      if (obj.session_id) conv.claudeSessionId = obj.session_id;
      const forge = (obj.mcp_servers ?? []).find((s: any) => s.name === "forge");
      if (forge && forge.status !== "connected") {
        bus.emitEvent({ type: "toast", level: "error", message: `Claude Code could not reach Studio Forge's tools (${forge.status}).` });
      }
      return;
    }
    const turn = this.turn;
    if (!turn) return;
    if (obj.parent_tool_use_id) return; // subagent internals
    switch (obj.type) {
      case "stream_event":
        this.onStream(turn, obj.event);
        break;
      case "assistant":
        this.onAssistant(turn, obj.message);
        break;
      case "user":
        this.onUser(turn, obj.message);
        break;
      case "result":
        this.onResult(turn, obj);
        break;
    }
  }

  private onStream(turn: TurnState, ev: any) {
    const blocks = turn.msg.blocks;
    switch (ev?.type) {
      case "message_start": {
        turn.indexMap.clear();
        if (ev.message?.id) turn.streamed.add(ev.message.id);
        const u = ev.message?.usage;
        if (u) turn.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        break;
      }
      case "content_block_start": {
        const cb = ev.content_block ?? {};
        let block: Block | null = null;
        if (cb.type === "text") block = { type: "text", text: cb.text ?? "" };
        else if (cb.type === "thinking") block = { type: "thinking", text: cb.thinking ?? "" };
        else if (cb.type === "tool_use" || cb.type === "server_tool_use" || cb.type === "mcp_tool_use") {
          block = { type: "tool", id: cb.id, name: cb.name, input: cb.input ?? {}, inputPartial: "", status: "running", startedAt: Date.now() };
        }
        if (block) {
          blocks.push(block);
          turn.indexMap.set(ev.index, blocks.length - 1);
        }
        break;
      }
      case "content_block_delta": {
        const i = turn.indexMap.get(ev.index);
        if (i === undefined) break;
        const b = blocks[i];
        const d = ev.delta ?? {};
        if (d.type === "text_delta" && b.type === "text") b.text += d.text ?? "";
        else if (d.type === "thinking_delta" && b.type === "thinking") b.text += d.thinking ?? "";
        else if (d.type === "input_json_delta" && b.type === "tool") b.inputPartial = (b.inputPartial ?? "") + (d.partial_json ?? "");
        break;
      }
      case "content_block_stop": {
        const i = turn.indexMap.get(ev.index);
        const b = i === undefined ? undefined : blocks[i];
        if (b?.type === "tool") {
          if (b.inputPartial) {
            try {
              b.input = JSON.parse(b.inputPartial);
            } catch {
              // Keep partial text; the final assistant message carries the parsed input.
            }
          }
          delete b.inputPartial;
        }
        break;
      }
      default:
        return;
    }
    this.emitMessage();
  }

  private onAssistant(turn: TurnState, message: any) {
    if (!message) return;
    const content: any[] = Array.isArray(message.content) ? message.content : [];
    const streamed = message.id && turn.streamed.has(message.id);
    for (const c of content) {
      if (c.type === "tool_use" || c.type === "server_tool_use" || c.type === "mcp_tool_use") {
        const existing = turn.toolBlock(c.id);
        if (existing) {
          existing.input = c.input ?? existing.input;
          delete existing.inputPartial;
        } else {
          turn.msg.blocks.push({ type: "tool", id: c.id, name: c.name, input: c.input ?? {}, status: "running", startedAt: Date.now() });
        }
      } else if (!streamed) {
        if (c.type === "text" && c.text) turn.msg.blocks.push({ type: "text", text: c.text });
        else if (c.type === "thinking" && c.thinking) turn.msg.blocks.push({ type: "thinking", text: c.thinking });
      }
    }
    this.emitMessage();
  }

  private onUser(turn: TurnState, message: any) {
    const content: any[] = Array.isArray(message?.content) ? message.content : [];
    for (const c of content) {
      if (c.type !== "tool_result") continue;
      const b = turn.toolBlock(c.tool_use_id);
      if (!b) continue;
      const parts: any[] = typeof c.content === "string" ? [{ type: "text", text: c.content }] : Array.isArray(c.content) ? c.content : [];
      const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      const images = parts
        .filter((p) => p.type === "image" && p.source?.data && p.source.data.length < 3_000_000)
        .slice(0, 2)
        .map((p) => `data:${p.source.media_type ?? "image/png"};base64,${p.source.data}`);
      const isError = !!c.is_error;
      b.result = { text: text.slice(0, 50_000), images: images.length ? images : undefined, isError };
      b.status = isError ? (/declined|denied|permission/i.test(text) ? "denied" : "error") : "done";
      b.endedAt = Date.now();
      delete b.progress;
    }
    this.emitMessage();
  }

  private onResult(turn: TurnState, r: any) {
    const conv = this.conv;
    if (!conv) return;
    if (r.session_id) conv.claudeSessionId = r.session_id;
    const u = r.usage ?? {};
    const usage: TurnUsage = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      costUsd: r.total_cost_usd ?? 0,
      turns: r.num_turns ?? 1,
      durationMs: r.duration_ms ?? Date.now() - turn.startedAt,
      contextTokens: turn.contextTokens,
    };
    turn.msg.usage = usage;
    for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "turns"] as const) {
      conv.usage[k] += usage[k];
    }
    if (r.is_error || (typeof r.subtype === "string" && r.subtype.startsWith("error"))) {
      turn.msg.error = typeof r.result === "string" && r.result ? r.result : r.subtype;
    } else if (!turn.msg.blocks.some((b) => b.type === "text") && typeof r.result === "string" && r.result.trim()) {
      turn.msg.blocks.push({ type: "text", text: r.result });
    }
    for (const b of turn.msg.blocks) {
      if (b.type !== "tool" || b.status !== "running") continue;
      b.status = "done";
      b.endedAt ??= Date.now();
      delete b.progress;
    }
    this.emitMessage(true);
    this.turn = null;
    this.resumeRetried = false;
    conversations.save(conv, true);
    this.setStatus("idle");
    this.touch();
    const next = this.queue.shift();
    if (next) {
      this.emitQueue();
      this.send(next);
    }
  }

  private fail(message: string) {
    const conv = this.conv;
    if (this.turn) {
      this.turn.msg.error = message;
      for (const b of this.turn.msg.blocks) if (b.type === "tool" && b.status === "running") b.status = "error";
      this.emitMessage(true);
    }
    this.turn = null;
    if (this.queue.length) {
      this.queue = [];
      this.emitQueue();
    }
    if (conv) conversations.save(conv, true);
    this.setStatus("idle", message);
  }

  stop() {
    if (this.queue.length) {
      this.queue = [];
      this.emitQueue();
    }
    this.deps.forge.cancelPermissions(this.convId);
    if (this.turn) {
      this.turn.msg.interrupted = true;
      for (const b of this.turn.msg.blocks) if (b.type === "tool" && b.status === "running") b.status = "error";
      this.emitMessage(true);
      this.turn = null;
    }
    this.kill();
    const conv = this.conv;
    if (conv) conversations.save(conv, true);
    this.setStatus("idle");
  }

  kill() {
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) {
      p.stdin?.end();
      p.kill();
    }
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.status === "idle") this.kill();
    }, IDLE_KILL_MS);
  }
}

function fingerprint(s: Settings): string {
  return JSON.stringify([s.model, s.effort, s.toolMode, s.autoApproveLuau, s.longCache, s.claudePath, s.workspaceDir]);
}

// ---------------------------------------------------------------------------

export class ClaudeManager {
  status: ClaudeStatus = { cli: "unknown" };
  private sessions = new Map<string, ClaudeSession>();
  private loginProc: ChildProcess | null = null;

  constructor(private deps: ClaudeDeps) {}

  private session(convId: string) {
    let s = this.sessions.get(convId);
    if (!s) this.sessions.set(convId, (s = new ClaudeSession(convId, this.deps)));
    return s;
  }

  queues(): Record<string, QueuedMessage[]> {
    const out: Record<string, QueuedMessage[]> = {};
    for (const [id, s] of this.sessions) if (s.queue.length) out[id] = s.queued;
    return out;
  }

  unqueue(convId: string, id: string) {
    this.sessions.get(convId)?.unqueue(id);
  }

  toolProgress(convId: string, toolName: string, text: string) {
    this.sessions.get(convId)?.toolProgress(toolName, text);
  }

  running(): Record<string, ConvStatus> {
    const out: Record<string, ConvStatus> = {};
    for (const [id, s] of this.sessions) if (s.status !== "idle") out[id] = s.status;
    return out;
  }

  send(convId: string, text: string, images?: Pending["images"]) {
    if (!conversations.get(convId)) throw new Error("Unknown conversation");
    this.session(convId).send({ text, images });
  }

  stop(convId: string) {
    this.sessions.get(convId)?.stop();
  }

  forget(convId: string) {
    this.sessions.get(convId)?.stop();
    this.sessions.delete(convId);
  }

  shutdown() {
    for (const s of this.sessions.values()) s.kill();
    this.loginProc?.kill();
  }

  private setStatus(s: ClaudeStatus) {
    this.status = s;
    bus.emitEvent({ type: "claude", status: s });
  }

  /** Check that the CLI exists and whether it is signed in. */
  async refreshStatus(): Promise<ClaudeStatus> {
    const settings = this.deps.getSettings();
    const version = await runCapture(settings.claudePath, ["--version"], cliEnv(settings)).catch((e) => e as Error);
    if (version instanceof Error) {
      this.setStatus({ cli: "missing", detail: version.message });
      return this.status;
    }
    // `auth status` exits non-zero when signed out but still prints JSON.
    const auth = await runCapture(settings.claudePath, ["auth", "status", "--json"], cliEnv(settings)).catch((e: Error) => e.message);
    let parsed: any = {};
    try {
      parsed = JSON.parse(auth);
    } catch {
      // Older CLIs may not have `auth status`.
    }
    this.setStatus({
      cli: "ok",
      version: version.trim().split(/\s+/)[0],
      loggedIn: parsed.loggedIn,
      authMethod: parsed.authMethod,
      apiProvider: parsed.apiProvider,
    });
    return this.status;
  }

  /** Run `claude auth login` and stream its output (sign-in URL, prompts) to the browser. */
  startLogin(method: "claudeai" | "console") {
    if (this.loginProc) return;
    const settings = this.deps.getSettings();
    const proc = spawnCli(settings.claudePath, ["auth", "login", method === "console" ? "--console" : "--claudeai"], {
      env: { ...cliEnv(settings), BROWSER: process.env.BROWSER ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.loginProc = proc;
    const onLine = (line: string) => bus.emitEvent({ type: "login", line: stripAnsi(line) });
    createInterface({ input: proc.stdout! }).on("line", onLine);
    createInterface({ input: proc.stderr! }).on("line", onLine);
    const done = (line: string) => {
      if (this.loginProc !== proc) return;
      this.loginProc = null;
      bus.emitEvent({ type: "login", line, done: true });
      void this.refreshStatus();
    };
    proc.on("error", (e) => done(`Could not start login: ${e.message}`));
    proc.on("exit", (code) => done(code === 0 ? "Login finished." : `Login process exited (code ${code}).`));
  }

  loginInput(text: string) {
    this.loginProc?.stdin?.write(text + "\n");
  }

  cancelLogin() {
    this.loginProc?.kill();
  }

  async logout() {
    const settings = this.deps.getSettings();
    await runCapture(settings.claudePath, ["auth", "logout"], cliEnv(settings)).catch(() => "");
    return this.refreshStatus();
  }
}

function runCapture(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const p = spawnCli(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`${cmd} ${args.join(" ")} timed out`));
    }, timeoutMs);
    p.stdout!.on("data", (d) => (out += d));
    p.stderr!.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`"${cmd}" was not found on PATH.`) : e);
    });
    p.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || out.trim() || `exit code ${code}`));
    });
  });
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}
