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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bus, conversations, shortId } from "./store.ts";
import { DATA_DIR, MCP_TOKEN } from "./config.ts";
import { FORGE_SYSTEM_PROMPT } from "./system-prompt.ts";
import type { ForgeMcp } from "./forge-mcp.ts";
import { compactEnv } from "../shared/context.ts";
import type {
  Block, ChatMessage, ClaudeStatus, ContextState, Conversation, ConvStatus, PlanUsage, QueuedMessage, Settings, TurnUsage, UsageWindow,
} from "../shared/protocol.ts";

const IDLE_KILL_MS = 20 * 60_000;
const LIMITS_FILE = join(DATA_DIR, "plan-usage.json");

function readLimits(): PlanUsage | null {
  try {
    return JSON.parse(readFileSync(LIMITS_FILE, "utf8"));
  } catch {
    return null;
  }
}
const RUN_DIR = join(DATA_DIR, "run");
const PROMPT_FILE = join(RUN_DIR, "system-prompt.md");

export interface ClaudeDeps {
  getSettings: () => Settings;
  forge: ForgeMcp;
  port: number;
  /** Claude Code reported subscription usage (rate_limit_event). */
  onLimits?: (info: unknown) => void;
  /** A compact line about the open Studio place (selection, view), sent along with messages. */
  studioContext?: () => Promise<string | null>;
}

const toMs = (v: unknown) => (typeof v === "number" && v > 0 ? (v < 1e12 ? v * 1000 : v) : undefined);

/** Normalize Claude Code's rate_limit_info; windows missing from this event keep their previous values. */
export function parsePlanUsage(raw: any, previous: PlanUsage | null = null): PlanUsage | null {
  if (!raw || typeof raw !== "object") return previous;
  const windows: Record<string, UsageWindow> = { ...(previous?.windows ?? {}) };
  for (const [key, value] of Object.entries(raw.unifiedWindows ?? {})) {
    const w = value as any;
    if (typeof w?.utilization === "number") windows[key] = { utilization: w.utilization, resetsAt: toMs(w.resetsAt) };
  }
  if (typeof raw.utilization === "number" && raw.rateLimitType) {
    windows[raw.rateLimitType] = { utilization: raw.utilization, resetsAt: toMs(raw.resetsAt) };
  }
  return {
    status: String(raw.status ?? "allowed"),
    limitType: raw.rateLimitType ?? undefined,
    resetsAt: toMs(raw.resetsAt),
    windows,
    overage: { status: raw.overageStatus ?? undefined, disabledReason: raw.overageDisabledReason ?? undefined, inUse: !!raw.isUsingOverage },
    updatedAt: Date.now(),
  };
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
  for (const [k, v] of Object.entries(compactEnv(settings.autoCompact))) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
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
  /** Restart the CLI before the next message (it was updated mid-turn). */
  restartNext = false;
  /** Auto-compact state Claude Code reported for this conversation. */
  context: ContextState | null = null;
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
    const compact = p.text.trim().match(/^\/compact(?:\s+([\s\S]*))?$/);
    if (compact && !p.images?.length) {
      this.compactNow(compact[1]?.trim() ?? "");
      return;
    }
    const user: ChatMessage = {
      id: shortId("msg_"),
      role: "user",
      blocks: [{ type: "text", text: p.text }],
      createdAt: Date.now(),
    };
    if (conv.messages.length === 0 && conv.title === "New chat") conv.title = p.text.replace(/^(?:@[musavb]_[a-z0-9]{6}\s+)+/, "").replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
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
    // The Studio selection and view ride along (when they changed), so "this" needs no lookup
    // call. It is read while Claude Code starts, so it costs no extra wait.
    if (!this.ensureProc()) return;
    if (this.status === "idle") this.setStatus("running");
    void this.withStudioContext(content).then((c) => {
      if (this.turn?.msg === assistant) this.deliver(c);
    });
  }

  private lastContext = "";

  private async withStudioContext(content: unknown[]): Promise<unknown[]> {
    const get = this.deps.studioContext;
    if (!get) return content;
    const line = await Promise.race([get().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    if (!line || line === this.lastContext) return content;
    this.lastContext = line;
    return [...content, { type: "text", text: `<studio>${line}</studio>` }];
  }

  /** Start Claude Code ahead of the first message (the user is typing): saves its start-up time. */
  warm() {
    if (this.status !== "idle" || !this.conv) return;
    const settings = this.deps.getSettings();
    const fp = fingerprint(settings);
    if (this.proc && this.fingerprint === fp && !this.restartNext) return;
    this.kill();
    try {
      this.spawn(settings, fp);
      this.touch();
    } catch {
      // The next message reports the problem.
    }
  }

  /** Summarize the conversation so far (Claude Code's /compact), shown as a divider in the chat. */
  private compactNow(instructions: string) {
    const conv = this.conv!;
    if (!conv.claudeSessionId && !conv.messages.some((m) => m.role === "user")) {
      bus.emitEvent({ type: "toast", level: "info", message: "Nothing to compact yet: this chat has no Claude context." });
      this.next();
      return;
    }
    const msg: ChatMessage = {
      id: shortId("msg_"),
      role: "assistant",
      blocks: [{ type: "compact", trigger: "manual", status: "running", startedAt: Date.now() }],
      createdAt: Date.now(),
      model: this.deps.getSettings().model,
    };
    conv.messages.push(msg);
    this.turn = new TurnState(msg);
    conversations.save(conv);
    this.emitMessage(true);
    this.setContext({ compacting: true });
    // The summary may drop the last Studio context line: send it again next time.
    this.lastContext = "";
    this.deliver([{ type: "text", text: instructions ? `/compact ${instructions}` : "/compact" }]);
  }

  private deliver(content: unknown[]) {
    const line = JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null }) + "\n";
    if (!this.ensureProc()) return;
    this.setStatus("running");
    this.proc!.stdin!.write(line);
    this.touch();
  }

  /** A Claude Code process with the current settings (restarted when they changed). */
  private ensureProc(): boolean {
    const settings = this.deps.getSettings();
    const fp = fingerprint(settings);
    if (this.proc && (this.fingerprint !== fp || this.restartNext)) this.kill();
    if (this.proc) return true;
    this.setStatus("starting");
    try {
      this.spawn(settings, fp);
      return true;
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  private spawn(settings: Settings, fp: string) {
    const conv = this.conv!;
    if (!conv.claudeSessionId) this.lastContext = "";
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
      // A pre-warmed process failing to start is reported when a message is actually sent.
      if (!this.turn) return;
      const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `Claude Code CLI not found ("${settings.claudePath}"). Install it (npm i -g @anthropic-ai/claude-code) or set its path in Settings.`
        : err.message;
      this.fail(msg);
    });
    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      const tail = this.stderr.join("\n").trim();
      if (this.status === "idle") {
        // A pre-warmed process whose saved session is gone: the next one starts fresh.
        if (!this.sawOutput && conv.claudeSessionId && /no conversation found/i.test(tail)) conv.claudeSessionId = undefined;
        return;
      }
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

  private setContext(patch: Partial<ContextState>) {
    const base = this.context ?? { enabled: true, threshold: 0, window: 0 };
    this.context = { ...base, ...patch };
    bus.emitEvent({ type: "context", convId: this.convId, state: this.context });
  }

  private onEvent(obj: any) {
    if (obj.type === "rate_limit_event") {
      this.deps.onLimits?.(obj.rate_limit_info);
      return;
    }
    if (obj.type === "autocompact_state" && obj.value) {
      const v = obj.value;
      this.setContext({ enabled: !!v.enabled, threshold: Number(v.threshold) || 0, window: Number(v.effective_window) || 0, compacting: false });
      return;
    }
    const conv = this.conv;
    if (!conv) return;
    if (obj.type === "system" && obj.subtype === "status") {
      const compacting = obj.status === "compacting";
      if (compacting && this.turn && !this.turn.msg.blocks.some((b) => b.type === "compact" && b.status === "running")) {
        this.turn.msg.blocks.push({ type: "compact", trigger: "auto", status: "running", startedAt: Date.now() });
        this.emitMessage(true);
      }
      if (compacting !== !!this.context?.compacting) this.setContext({ compacting });
      return;
    }
    if (obj.type === "system" && obj.subtype === "compact_boundary") {
      const m = obj.compact_metadata ?? {};
      if (this.turn) {
        const blocks = this.turn.msg.blocks;
        let b = [...blocks].reverse().find((x): x is Extract<Block, { type: "compact" }> => x.type === "compact" && x.status === "running");
        if (!b) blocks.push((b = { type: "compact", trigger: "auto", status: "running", startedAt: Date.now() - (m.duration_ms ?? 0) }));
        b.trigger = m.trigger === "manual" ? "manual" : b.trigger;
        b.status = "done";
        b.preTokens = m.pre_tokens;
        b.postTokens = m.post_tokens;
        b.endedAt = Date.now();
        if (typeof m.post_tokens === "number") this.turn.contextTokens = m.post_tokens;
        this.emitMessage(true);
      }
      this.setContext({ compacting: false });
      return;
    }
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
      // Claude Code also prints API errors as a reply; show them once, as the error.
      const last = turn.msg.blocks[turn.msg.blocks.length - 1];
      if (last?.type === "text" && last.text.trim() === String(turn.msg.error).trim()) turn.msg.blocks.pop();
    } else if (!turn.msg.blocks.some((b) => b.type === "text") && typeof r.result === "string" && r.result.trim()) {
      turn.msg.blocks.push({ type: "text", text: r.result });
    }
    for (const b of turn.msg.blocks) {
      if ((b.type !== "tool" && b.type !== "compact") || b.status !== "running") continue;
      // A compaction that never reached its boundary did not happen ("No messages to compact").
      b.status = b.type === "compact" ? "error" : "done";
      b.endedAt ??= Date.now();
      if (b.type === "tool") delete b.progress;
    }
    if (this.context?.compacting) this.setContext({ compacting: false });
    this.emitMessage(true);
    this.turn = null;
    this.resumeRetried = false;
    conversations.save(conv, true);
    this.setStatus("idle");
    this.touch();
    this.next();
  }

  private next() {
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
      for (const b of this.turn.msg.blocks) if (b.type !== "text" && b.type !== "thinking" && b.status === "running") b.status = "error";
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
      for (const b of this.turn.msg.blocks) if (b.type !== "text" && b.type !== "thinking" && b.status === "running") b.status = "error";
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
    this.restartNext = false;
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
  return JSON.stringify([s.model, s.effort, s.toolMode, s.autoApproveLuau, s.longCache, s.autoCompact, s.claudePath, s.workspaceDir]);
}

// ---------------------------------------------------------------------------

export class ClaudeManager {
  status: ClaudeStatus = { cli: "unknown" };
  private sessions = new Map<string, ClaudeSession>();
  private loginProc: ChildProcess | null = null;
  /** Subscription usage last reported by Claude Code (kept across restarts). */
  limits: PlanUsage | null = readLimits();

  constructor(private deps: ClaudeDeps) {
    deps.onLimits = (info) => {
      const next = parsePlanUsage(info, this.limits);
      if (!next) return;
      this.limits = next;
      try {
        writeFileSync(LIMITS_FILE, JSON.stringify(next));
      } catch {
        // Not critical: it is refreshed on the next reply.
      }
      bus.emitEvent({ type: "limits", limits: next });
    };
  }

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

  private probe: Promise<PlanUsage | null> | null = null;

  /**
   * Fresh plan usage without waiting for the next chat turn. Claude Code only reports usage
   * alongside a model request, so this sends one tiny Haiku request with no tools or MCP
   * servers and stops it as soon as the usage arrives.
   */
  checkLimits(): Promise<PlanUsage | null> {
    if (this.probe) return this.probe;
    const settings = this.deps.getSettings();
    mkdirSync(RUN_DIR, { recursive: true });
    const args = ["-p", "Reply with OK.", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "stream-json", "--verbose"];
    this.probe = new Promise<PlanUsage | null>((resolve, reject) => {
      const proc = spawnCli(settings.claudePath, args, { cwd: RUN_DIR, env: cliEnv(settings), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let got = false;
      let err = "";
      const timer = setTimeout(() => proc.kill(), 60_000);
      createInterface({ input: proc.stdout! }).on("line", (line) => {
        if (got || !line.includes('"rate_limit_event"')) return;
        try {
          const obj = JSON.parse(line);
          if (obj.type !== "rate_limit_event") return;
          got = true;
          this.deps.onLimits?.(obj.rate_limit_info);
          proc.kill();
        } catch {
          // ignore partial or unrelated lines
        }
      });
      proc.stderr!.on("data", (d) => (err += d));
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`Claude Code CLI not found ("${settings.claudePath}").`) : e);
      });
      proc.on("exit", () => {
        clearTimeout(timer);
        if (got) resolve(this.limits);
        else reject(new Error(err.trim().split("\n").pop() || "Claude Code didn't report plan usage. Plan limits only apply when it is signed in with a Claude subscription."));
      });
    }).finally(() => (this.probe = null));
    return this.probe;
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

  warm(convId: string) {
    if (conversations.get(convId)) this.session(convId).warm();
  }

  /** Compact a conversation now (queued behind a running reply). */
  compact(convId: string, instructions = "") {
    if (!conversations.get(convId)) throw new Error("Unknown conversation");
    this.session(convId).send({ text: instructions ? `/compact ${instructions}` : "/compact" });
  }

  contexts(): Record<string, ContextState> {
    const out: Record<string, ContextState> = {};
    for (const [id, s] of this.sessions) if (s.context) out[id] = s.context;
    return out;
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

  private updating: Promise<{ ok: boolean; output: string; before?: string; version?: string }> | null = null;

  /**
   * Run `claude update`. New models need recent Claude Code versions ("Claude Code X does not
   * support this model"). Chats switch to the new version with their next message.
   */
  updateCli() {
    this.updating ??= (async () => {
      const settings = this.deps.getSettings();
      const before = this.status.version;
      let ok = true;
      let output = "";
      try {
        output = await runCapture(settings.claudePath, ["update"], cliEnv(settings), 300_000);
      } catch (err) {
        ok = false;
        output = err instanceof Error ? err.message : String(err);
      }
      const { version } = await this.refreshStatus();
      if (version && version !== before) {
        for (const s of this.sessions.values()) {
          if (s.status === "idle") s.kill();
          else s.restartNext = true;
        }
      }
      return { ok, output: stripAnsi(output).trim().slice(-2000), before, version };
    })().finally(() => (this.updating = null));
    return this.updating;
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
