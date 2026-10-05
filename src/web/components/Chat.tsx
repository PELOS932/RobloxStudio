import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CLI_OUTDATED, deleteConversation, exportConversation, importAsset, openAsset, renameConversation, sendMessage, startNewChat, stopConversation, toast, unqueueMessage,
  updateClaudeCode, updateSettings, useStore,
} from "../store.ts";
import { Icon, type IconName } from "../lib/icons.tsx";
import { api } from "../lib/api.ts";
import { highlightLuau } from "./ScriptView.tsx";
import { AssetThumb } from "./AssetThumb.tsx";
import { LimitNotice } from "./PlanUsage.tsx";
import { approxTokens, describeCall, fmtDuration, ToolCalls, useNow } from "./ToolCall.tsx";
import { sizeLabel, type AssetKind } from "../../shared/assets.ts";
import type { Block, ChatMessage, Effort, TurnUsage } from "../../shared/protocol.ts";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5", hint: "Highest quality" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", hint: "Balanced speed and quality" },
  { id: "claude-fable-5-1", label: "Fable 5.1", hint: "Claude Fable" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "Fastest, lowest usage" },
];

export const EFFORTS: { id: Effort; label: string; hint: string }[] = [
  { id: "default", label: "Auto", hint: "Let Claude decide" },
  { id: "low", label: "Low", hint: "Quick answers, least usage" },
  { id: "medium", label: "Medium", hint: "Good for most edits" },
  { id: "high", label: "High", hint: "More careful designs" },
  { id: "xhigh", label: "Extra high", hint: "Complex builds" },
  { id: "max", label: "Max", hint: "Hardest problems" },
];

const STARTERS: { kind: AssetKind | "studio"; title: string; sub: string; prompt: string }[] = [
  { kind: "model", title: "Low-poly campfire", sub: "Logs, stones and glowing embers", prompt: "Build a low-poly campfire: crossed logs, a ring of stones, and glowing neon embers with a warm point light." },
  { kind: "model", title: "Medieval watchtower", sub: "Stone base, timber top, torches", prompt: "Build a medieval watchtower about 30 studs tall: cobblestone base, wooden plank upper floor with railings, a clay-tile roof and two torches." },
  { kind: "ui", title: "Item shop", sub: "Tabs, item grid, buy buttons", prompt: "Design a modern dark item shop UI in HTML: centered window with a title bar, coin counter and close button, category tabs, and a scrolling grid of 8 item cards with rarity badges and green Buy buttons." },
  { kind: "ui", title: "Game HUD", sub: "Health, coins and hotbar", prompt: "Design a game HUD in HTML: currency pills top-right, health/stamina bars bottom-left, a 5-slot hotbar bottom-center and a quest tracker on the right. Readable on phone and desktop." },
  { kind: "script", title: "Proximity door", sub: "Model plus the script that opens it", prompt: "Make a wooden door with a frame, then a server Script that slides it open when a player gets within 10 studs and closes it after." },
  { kind: "studio", title: "Polish my selection", sub: "Improve what's selected in Studio", prompt: "Pull my current Studio selection and make it look more polished — better materials, colors and small details — then update it in Studio." },
];

const ASSET_TOOLS = new Set(["create_model", "edit_model", "create_ui", "edit_ui", "create_ui_html", "edit_ui_html", "create_script", "import_to_studio", "studio_pull_selection"]);
const MENTION = /^((?:@[mus]_[a-z0-9]{6}\s+)+)/;

// ---------------------------------------------------------------------------

export function Chat() {
  const activeId = useStore((s) => s.activeConvId);
  const conv = useStore((s) => (s.activeConvId ? s.convs[s.activeConvId] : undefined));
  const status = useStore((s) => (s.activeConvId ? s.running[s.activeConvId] : undefined));
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [dropped, setDropped] = useState<{ files: File[]; nonce: number } | null>(null);

  const messages = conv?.messages ?? [];
  const last = messages[messages.length - 1];
  const lastSize = last ? last.blocks.reduce((n, b) => n + (b.type === "tool" ? (b.result?.text.length ?? 0) + 50 : b.text.length), 0) : 0;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!messages.length) el.scrollTop = 0;
    else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastSize, activeId, status]);

  useEffect(() => {
    stick.current = true;
    setAtBottom(true);
  }, [activeId]);

  // Esc stops a running reply.
  useEffect(() => {
    if (!status || !activeId) return;
    const onKey = (e: KeyboardEvent) => {
      // Inputs and menus that use Esc themselves mark the event handled.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const s = useStore.getState();
      if (!s.settingsOpen && !s.htmlImportOpen && !s.paletteOpen && !s.shortcutsOpen && !s.permissions.length) stopConversation(activeId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, activeId]);

  const lastUserText = [...messages].reverse().find((m) => m.role === "user")?.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n") ?? "";

  return (
    <section
      className="chat"
      onDragEnter={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (e.dataTransfer.files.length) setDropped({ files: [...e.dataTransfer.files], nonce: Date.now() });
      }}
    >
      <ChatHeader running={!!status} />
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = bottom;
          if (bottom !== atBottom) setAtBottom(bottom);
        }}
      >
        {messages.length === 0 ? (
          <Welcome />
        ) : (
          <div className="thread">
            {messages.map((m, i) => {
              const isLast = i === messages.length - 1;
              // Only the last message gets a retry callback, so the memoised history skips re-rendering while a reply streams.
              return (
                <MessageView
                  key={m.id}
                  message={m}
                  live={!!status && isLast}
                  isLast={isLast}
                  onRetry={isLast && lastUserText ? () => void sendMessage(lastUserText).catch((e) => toast(String(e), "error")) : undefined}
                />
              );
            })}
          </div>
        )}
      </div>
      <Composer convId={activeId} running={!!status} dropped={dropped} lastUserText={lastUserText}>
        {!atBottom && messages.length > 0 && (
          <button
            className="jump-latest"
            onClick={() => {
              const el = scrollRef.current;
              stick.current = true;
              setAtBottom(true);
              el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            }}
          >
            <Icon name="arrowDown" size={13} /> Latest
          </button>
        )}
      </Composer>
      {dragging && (
        <div className="drop-overlay">
          <div>
            <b>Drop images to attach</b>
            <span>PNG, JPG or WebP, up to 5 MB each</span>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function ChatHeader({ running }: { running: boolean }) {
  const meta = useStore((s) => s.conversations.find((c) => c.id === s.activeConvId));
  const conv = useStore((s) => (s.activeConvId ? s.convs[s.activeConvId] : undefined));
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const lastUsage = conv ? [...conv.messages].reverse().find((m) => m.usage)?.usage : undefined;

  const commit = () => {
    setEditing(false);
    if (meta && title.trim() && title.trim() !== meta.title) void renameConversation(meta.id, title);
  };

  return (
    <header className="chat-header">
      {meta ? (
        editing ? (
          <input
            className="chat-title-input"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
          />
        ) : (
          <button className="chat-title" title="Rename chat" onClick={() => (setTitle(meta.title), setEditing(true))}>
            <span>{meta.title}</span>
            <Icon name="pencil" size={12} />
          </button>
        )
      ) : (
        <span className="chat-title muted-title">New chat</span>
      )}
      <span className="spacer" />
      {running && (
        <span className="run-state">
          <span className="spinner" /> working
        </span>
      )}
      {lastUsage && lastUsage.contextTokens > 0 && (
        <span className="ctx-stat hide-mobile" title="Tokens in the conversation context (most are served from the prompt cache)">
          {fmtTokens(lastUsage.contextTokens)} ctx
        </span>
      )}
      {meta && (
        <ChatMenu
          onRename={() => (setTitle(meta.title), setEditing(true))}
          onExport={() => void exportConversation(meta.id)}
          onDelete={() => {
            if (confirm(`Delete "${meta.title}"?`)) void deleteConversation(meta.id);
          }}
        />
      )}
      <button className="icon-btn" title="New chat" onClick={startNewChat}>
        <Icon name="plus" />
      </button>
    </header>
  );
}

function ChatMenu({ onRename, onExport, onDelete }: { onRename: () => void; onExport: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  const item = (label: string, icon: IconName, run: () => void, danger = false) => (
    <button
      className={danger ? "danger" : ""}
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      <Icon name={icon} size={13} /> {label}
    </button>
  );
  return (
    <div className="dropdown" ref={ref}>
      <button className={`icon-btn ${open ? "active" : ""}`} title="Chat options" onClick={() => setOpen((v) => !v)}>
        <Icon name="dots" />
      </button>
      {open && (
        <div className="menu menu-compact">
          {item("Rename", "pencil", onRename)}
          {item("Export as Markdown", "download", onExport)}
          {item("Delete chat", "trash", onDelete, true)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const KIND_LABEL: Record<AssetKind | "studio", string> = { model: "model", ui: "ui", script: "script", studio: "studio" };

function Welcome() {
  const claude = useStore((s) => s.claude);
  const studio = useStore((s) => s.studio);
  const settings = useStore((s) => s.settings);
  const studioReady = studio.state === "connected" && !!studio.studioId;
  const place = studio.studios.find((s) => s.id === studio.studioId)?.name.replace(/\s*\(placeId:.*\)$/, "");
  const model = MODELS.find((m) => m.id === settings?.model)?.label ?? settings?.model;
  const claudeOk = claude.cli === "ok" && claude.loggedIn !== false;
  return (
    <div className="welcome">
      <h1>Describe a model, a UI or a script.</h1>
      <p>It appears in the preview as soon as Claude makes it. One click puts it in your open Roblox Studio place.</p>
      <dl className="readout">
        <div>
          <dt>Claude Code</dt>
          <dd>
            <i className={`sq ${claudeOk ? "ok" : "warn"}`} />
            {claude.cli === "missing" ? "not installed" : claude.loggedIn === false ? "not signed in" : `ready${model ? ` · ${model}` : ""}`}
          </dd>
        </div>
        <div>
          <dt>Roblox Studio</dt>
          <dd>
            <i className={`sq ${studioReady ? "ok" : "warn"}`} />
            <button className="link-btn" onClick={() => useStore.setState({ rightTab: "studio", mobileView: "panel" })}>
              {studioReady ? place ?? "connected" : studio.state === "connected" ? "no place open" : "not connected"}
            </button>
          </dd>
        </div>
      </dl>
      {claude.cli === "missing" && (
        <div className="notice">
          Install the Claude Code CLI with <code>npm i -g @anthropic-ai/claude-code</code>, then sign in from Settings → Claude account.
        </div>
      )}
      {claude.cli === "ok" && claude.loggedIn === false && (
        <div className="notice">
          Claude Code isn't signed in yet.{" "}
          <button className="btn small" onClick={() => useStore.setState({ settingsOpen: "account" })}>Connect your Claude account</button>
        </div>
      )}
      <div className="section-label">Examples</div>
      <ul className="starters">
        {STARTERS.map((s) => (
          <li key={s.title}>
            <button className="starter" onClick={() => void sendMessage(s.prompt).catch((e) => toast(String(e), "error"))}>
              <span className="starter-kind">{KIND_LABEL[s.kind]}</span>
              <span className="starter-title">{s.title}</span>
              <span className="starter-sub">{s.sub}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

function timeOf(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function plainText(m: ChatMessage): string {
  return m.blocks.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n\n");
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="act-btn"
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      <Icon name={done ? "check" : "copy"} size={13} />
    </button>
  );
}

type Segment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "steps"; tools: Extract<Block, { type: "tool" }>[] };

function segments(blocks: Block[]): Segment[] {
  const out: Segment[] = [];
  for (const b of blocks) {
    if (b.type === "tool") {
      const prev = out[out.length - 1];
      if (prev?.kind === "steps") prev.tools.push(b);
      else out.push({ kind: "steps", tools: [b] });
    } else if (b.text.trim()) out.push({ kind: b.type, text: b.text });
  }
  return out;
}

/** The local Claude Code is too old for the chosen model: offer `claude update` right here. */
function CliOutdated({ model, error, onRetry }: { model?: string; error: string; onRetry?: () => void }) {
  const updating = useStore((s) => s.claudeUpdating);
  const version = useStore((s) => s.claude.version);
  const old = error.match(/Claude Code (\S+) does not support/)?.[1];
  if (old && version && version !== old) {
    return (
      <div className="msg-fix">
        <span>Claude Code is now {version}.</span>
        {onRetry && (
          <button className="btn small primary" onClick={onRetry}>
            <Icon name="refresh" size={13} /> Try again
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="msg-fix">
      <span>
        Claude Code{old ? ` ${old}` : version ? ` ${version}` : ""} on this computer is too old for {model ?? "this model"}. Update it, then send your message again.
      </span>
      <button className="btn small primary" disabled={updating} onClick={() => void updateClaudeCode()}>
        {updating ? <span className="spinner" /> : <Icon name="download" size={13} />} {updating ? "Updating…" : "Update Claude Code"}
      </button>
    </div>
  );
}

const MessageView = memo(function MessageView({ message, live, isLast, onRetry }: { message: ChatMessage; live: boolean; isLast: boolean; onRetry?: () => void }) {
  if (message.role === "user") return <UserMessage message={message} />;

  const segs = segments(message.blocks);
  const lastSeg = segs[segs.length - 1];
  const streamingText = live && lastSeg?.kind === "text";
  const model = MODELS.find((m) => m.id === message.model)?.label ?? message.model;
  const text = plainText(message);
  // Assets touched in this turn, newest result per asset.
  const assetIds = [
    ...new Set(
      message.blocks.flatMap((b) => {
        if (b.type !== "tool" || b.status !== "done") return [];
        if (!ASSET_TOOLS.has(b.name.replace(/^mcp__forge__/, ""))) return [];
        const id = b.result?.text.match(/\b([mus]_[a-z0-9]{6})\b/)?.[1];
        return id ? [id] : [];
      }),
    ),
  ];

  return (
    <article className="msg msg-ai">
      {segs.map((s, i) =>
        s.kind === "text" ? (
          <Markdown key={i} text={s.text} live={streamingText && i === segs.length - 1} />
        ) : s.kind === "thinking" ? (
          <Thinking key={i} text={s.text} live={live && i === segs.length - 1} />
        ) : (
          <ToolCalls key={i} tools={s.tools} />
        ),
      )}
      {assetIds.map((id) => <AssetCard key={id} id={id} />)}
      {live && <LiveStatus message={message} />}
      {message.error && (
        <div className="msg-error">
          <Icon name="x" size={13} />
          <span>{message.error}</span>
        </div>
      )}
      {isLast && !live && CLI_OUTDATED.test(`${message.error ?? ""}\n${text}`) && <CliOutdated model={model} error={`${message.error ?? ""}\n${text}`} onRetry={onRetry} />}
      {message.interrupted && <div className="msg-note">Stopped.</div>}
      {!live && (
        <div className="msg-meta">
          {model && <span>{model}</span>}
          <time>{timeOf(message.createdAt)}</time>
          {message.usage && <UsageLine usage={message.usage} />}
          <span className="msg-actions">
            {text && <CopyButton text={text} label="Copy reply" />}
            {isLast && onRetry && (message.error || message.interrupted) && (
              <button className="act-btn" title="Retry" onClick={onRetry}>
                <Icon name="refresh" size={13} />
              </button>
            )}
          </span>
        </div>
      )}
    </article>
  );
});

function UserMessage({ message }: { message: ChatMessage }) {
  const raw = plainText(message);
  const m = raw.match(MENTION);
  const mentions = m ? m[1].trim().split(/\s+/).map((t) => t.slice(1)) : [];
  const text = m ? raw.slice(m[1].length) : raw;
  return (
    <article className="msg msg-user">
      <div className="user-box">
        <div className="msg-actions user-actions">
          <time>{timeOf(message.createdAt)}</time>
          <CopyButton text={text} />
          <button className="act-btn" title="Edit and resend" onClick={() => useStore.setState({ composerInsert: { text, nonce: Date.now(), replace: true } })}>
            <Icon name="pencil" size={13} />
          </button>
        </div>
        {mentions.length > 0 && (
          <div className="mention-row">
            {mentions.map((id) => <MentionChip key={id} id={id} />)}
          </div>
        )}
        <div className="user-text">{text}</div>
      </div>
    </article>
  );
}

function MentionChip({ id }: { id: string }) {
  const asset = useStore((s) => s.assets.find((a) => a.id === id));
  return (
    <button className="mention" onClick={() => asset && openAsset(id)} disabled={!asset}>
      @{asset?.name ?? id}
    </button>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  // While Claude thinks, the newest lines stream in (like Claude Code); afterwards it folds away.
  if (live) {
    return (
      <div className="thinking live">
        <div className="thinking-head">
          <span className="spinner" /> Thinking…
        </div>
        <div className="thinking-live">{text.split("\n").slice(-6).join("\n")}</div>
      </div>
    );
  }
  return (
    <details className="thinking">
      <summary>
        <Icon name="chevronRight" size={12} className="chev" />
        Thought process
      </summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}

function liveLabel(message: ChatMessage): string {
  const running = [...message.blocks].reverse().find((b): b is Extract<Block, { type: "tool" }> => b.type === "tool" && b.status === "running");
  const last = message.blocks[message.blocks.length - 1];
  if (!running) return !last ? "Starting" : last.type === "text" ? "Writing" : "Thinking";
  const n = running.name.replace(/^mcp__forge__/, "");
  if (running.inputPartial !== undefined) return n === "create_model" || n === "edit_model" ? "Designing the model" : /ui/.test(n) ? "Designing the UI" : "Preparing the next step";
  if (n === "create_model" || n === "edit_model") return "Building the model";
  if (n.includes("ui")) return "Building the UI";
  if (n === "create_script") return "Writing the script";
  if (n === "import_to_studio") return "Importing into Studio";
  if (n.startsWith("studio_")) return running.progress?.startsWith("Waiting for your approval") ? "Waiting for your approval" : "Working in Studio";
  if (n === "Bash") return "Running a command";
  if (n === "TodoWrite") return "Planning";
  return `Running ${describeCall(running).label}`;
}

/** Claude Code-style status line: what's happening, elapsed time, output so far, how to stop. */
function LiveStatus({ message }: { message: ChatMessage }) {
  const now = useNow(true);
  const tokens = approxTokens(message.blocks);
  return (
    <div className="live-status">
      <span className="live-mark">✻</span>
      <span>{liveLabel(message)}…</span>
      <span className="live-meta">
        {fmtDuration(Math.max(0, now - message.createdAt))}
        {tokens > 0 && ` · ↓ ${fmtTokens(tokens)} tokens`}
        {" · esc to interrupt"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function cacheRate(u: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  const total = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return total ? Math.round((u.cacheReadTokens / total) * 100) : 0;
}

function UsageLine({ usage }: { usage: TurnUsage }) {
  return (
    <span
      className="usage"
      title={`Input ${usage.inputTokens} · cache read ${usage.cacheReadTokens} · cache write ${usage.cacheWriteTokens} · output ${usage.outputTokens}${usage.costUsd ? ` · $${usage.costUsd.toFixed(4)} API-equivalent (subscriptions aren't billed per token)` : ""}`}
    >
      <span>{(usage.durationMs / 1000).toFixed(1)}s</span>
      <span>{cacheRate(usage)}% cached</span>
      <span>{fmtTokens(usage.outputTokens)} out</span>
    </span>
  );
}

// ---------------------------------------------------------------------------

function Markdown({ text, live }: { text: string; live?: boolean }) {
  return (
    <div className={`markdown ${live ? "live" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ className, children }) => {
            const lang = /language-(\w+)/.exec(className ?? "")?.[1];
            const content = String(children ?? "");
            if (!lang && !content.includes("\n")) return <code>{children}</code>;
            return <CodeBlock lang={lang ?? "text"} code={content.replace(/\n$/, "")} />;
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const luau = /^(lua|luau)$/i.test(lang);
  const studioReady = useStore((s) => s.studio.state === "connected" && !!s.studio.studioId);
  const [copied, setCopied] = useState(false);
  const [run, setRun] = useState<{ busy: boolean; ok?: boolean; output?: string } | null>(null);
  const runInStudio = async () => {
    setRun({ busy: true });
    try {
      const r = await api<{ ok: boolean; output: string }>("/studio/run", { body: { code } });
      setRun({ busy: false, ok: r.ok, output: r.output });
    } catch (err) {
      setRun({ busy: false, ok: false, output: String(err) });
    }
  };
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="lang">{luau ? "luau" : lang}</span>
        <span className="codeblock-actions">
          {luau && (
            <button
              className="btn ghost small"
              disabled={!studioReady || run?.busy}
              title={studioReady ? "Run this code in the open Studio place (edit mode)" : "Connect Roblox Studio to run code"}
              onClick={() => void runInStudio()}
            >
              {run?.busy ? <span className="spinner" /> : <Icon name="play" size={12} />} Run in Studio
            </button>
          )}
          <button
            className="btn ghost small"
            onClick={() => {
              void navigator.clipboard?.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
          >
            <Icon name={copied ? "check" : "copy"} size={12} /> {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      <pre>
        <code>{luau ? highlightLuau(code).map((l, i) => <div key={i}>{l.length ? l : " "}</div>) : code}</code>
      </pre>
      {run && !run.busy && (
        <div className={`codeblock-out ${run.ok ? "ok" : "err"}`}>
          <span className="tool-label">{run.ok ? "studio output" : "studio error"}</span>
          <button className="act-btn" title="Dismiss" onClick={() => setRun(null)}>
            <Icon name="x" size={12} />
          </button>
          <pre>{run.output?.trim() || "(no output)"}</pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function AssetCard({ id }: { id: string }) {
  const asset = useStore((s) => s.assets.find((a) => a.id === id));
  const importing = useStore((s) => !!s.importing[id]);
  const active = useStore((s) => s.activeAssetId === id);
  if (!asset) return null;
  const inStudio = asset.lastImport && asset.lastImport.version === asset.version;
  return (
    <div className={`asset-card ${active ? "active" : ""}`}>
      <button className="asset-thumb" onClick={() => openAsset(id)} title="Open in the preview">
        <AssetThumb id={id} kind={asset.kind} version={asset.version} width={112} height={70} />
      </button>
      <div className="asset-info">
        <button className="asset-name" onClick={() => openAsset(id)}>{asset.name}</button>
        <span className="asset-meta">
          {asset.kind === "model" ? "model" : asset.kind === "ui" ? (asset.fromHtml ? "ui · html" : "ui") : "script"} · {sizeLabel(asset.kind, asset.size)} · v{asset.version}
        </span>
        <span className={`asset-studio ${inStudio ? "ok" : asset.lastImport ? "stale" : ""}`}>
          <i className="sq" />
          {inStudio ? asset.lastImport!.path : asset.lastImport ? "Studio copy is out of date" : "not in Studio"}
        </span>
      </div>
      <div className="asset-actions">
        {!active && (
          <button className="btn small ghost" onClick={() => openAsset(id)}>
            Open
          </button>
        )}
        <button className={`btn small ${inStudio ? "" : "primary"}`} disabled={importing} onClick={() => void importAsset(id)}>
          {importing ? <span className="spinner" /> : <Icon name="upload" size={13} />} {inStudio ? "Re-import" : asset.lastImport ? "Update" : "Import"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Menu<T extends string>({ value, options, onChange, prefix, label, title }: {
  value: T;
  options: { id: T; label: string; hint: string }[];
  onChange: (v: T) => void;
  prefix: string;
  label: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={`select-btn ${open ? "open" : ""}`} title={title} onClick={() => setOpen((v) => !v)}>
        <span className="select-key">{prefix}</span>
        <span>{label}</span>
        <Icon name="chevronDown" size={11} />
      </button>
      {open && (
        <div className="popover" role="menu">
          <div className="popover-title">{title}</div>
          {options.map((o) => (
            <button
              key={o.id}
              role="menuitemradio"
              aria-checked={o.id === value}
              className={`pop-item ${o.id === value ? "active" : ""}`}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
            >
              <span>
                <b>{o.label}</b>
                <small>{o.hint}</small>
              </span>
              {o.id === value && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({ convId, running, dropped, lastUserText, children }: {
  convId: string | null;
  running: boolean;
  dropped: { files: File[]; nonce: number } | null;
  lastUserText: string;
  children?: ReactNode;
}) {
  const settings = useStore((s) => s.settings);
  const insert = useStore((s) => s.composerInsert);
  const activeAsset = useStore((s) => s.assets.find((a) => a.id === s.activeAssetId));
  const [text, setText] = useState("");
  const [images, setImages] = useState<{ mediaType: string; data: string; url: string }[]>([]);
  const [attached, setAttached] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const attachedAsset = useStore((s) => s.assets.find((a) => a.id === attached));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(260, el.scrollHeight) + "px";
  }, [text]);

  useEffect(() => {
    if (!insert) return;
    setText((t) => (insert.replace || !t ? insert.text : `${t}\n${insert.text}`));
    focusEnd();
  }, [insert]);

  useEffect(() => {
    if (dropped) void addFiles(dropped.files);
  }, [dropped]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (attached && !attachedAsset) setAttached(null);
  }, [attached, attachedAsset]);

  // "/" anywhere outside a text field jumps to the composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector(".modal-backdrop")) return;
      e.preventDefault();
      focusEnd();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function focusEnd() {
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  async function addFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) {
        toast(`${f.name} isn't an image`, "error");
        continue;
      }
      if (f.size > 5 * 1024 * 1024) {
        toast(`${f.name} is larger than 5 MB`, "error");
        continue;
      }
      const url = await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.readAsDataURL(f);
      });
      setImages((list) => [...list, { mediaType: f.type, data: url.split(",")[1], url }].slice(0, 4));
    }
  }

  const queue = useStore((s) => (convId ? s.queues[convId] : undefined)) ?? [];

  // While Claude works, sending queues the message; it runs when the current reply ends.
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      const body = attached ? `@${attached} ${t}` : t;
      await sendMessage(body, images.length ? images.map(({ mediaType, data }) => ({ mediaType, data })) : undefined);
      setText("");
      setImages([]);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const model = settings ? MODELS.find((m) => m.id === settings.model) : undefined;
  const effort = settings ? EFFORTS.find((e) => e.id === settings.effort) : undefined;
  const modelOptions = settings && !model ? [...MODELS, { id: settings.model, label: settings.model, hint: "Custom model" }] : MODELS;

  return (
    <div className="composer-dock">
      {children}
      <LimitNotice />
      {queue.length > 0 && (
        <ol className="queue" aria-label="Queued messages">
          {queue.map((q, i) => (
            <li key={q.id}>
              <span className="queue-n">{i === 0 ? "next" : `+${i}`}</span>
              <span className="queue-text">{q.text.replace(MENTION, "")}</span>
              <button className="act-btn" title="Remove from queue" onClick={() => convId && unqueueMessage(convId, q.id)}>
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className={`composer ${running ? "is-running" : ""}`}>
        {(images.length > 0 || activeAsset || attachedAsset) && (
          <div className="composer-context">
            {attachedAsset ? (
              <span className="ctx-chip on" title="Claude will know which asset you mean">
                @{attachedAsset.name}
                <button aria-label="Remove asset" onClick={() => setAttached(null)}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            ) : activeAsset ? (
              <button className="ctx-chip" onClick={() => (setAttached(activeAsset.id), focusEnd())} title="Refer to the asset open in the preview">
                <Icon name="plus" size={11} /> @{activeAsset.name}
              </button>
            ) : null}
            {images.map((img, i) => (
              <span className="thumb-chip" key={i}>
                <img src={img.url} alt="" />
                <button aria-label="Remove image" onClick={() => setImages((l) => l.filter((_, j) => j !== i))}>
                  <Icon name="x" size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={running ? "Claude is working. Messages you send now run next." : "Ask for a model, a UI or a script"}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              void addFiles(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            } else if (e.key === "ArrowUp" && !text && lastUserText) {
              e.preventDefault();
              setText(lastUserText.replace(MENTION, ""));
              focusEnd();
            }
          }}
        />
        <div className="composer-bar">
          <label className="icon-btn" title="Attach images" style={{ cursor: "pointer" }}>
            <Icon name="attach" />
            <input type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} />
          </label>
          {settings && (
            <>
              <Menu value={settings.model} options={modelOptions} onChange={(v) => void updateSettings({ model: v })} prefix="model" label={model?.label ?? settings.model} title="Model" />
              <span className="hide-mobile">
                <Menu value={settings.effort} options={EFFORTS} onChange={(v) => void updateSettings({ effort: v })} prefix="effort" label={effort?.label ?? "Auto"} title="Effort" />
              </span>
            </>
          )}
          <span className="spacer" />
          <span className="kbd-hint hide-mobile">
            {running ? <><kbd>enter</kbd> queue <kbd>esc</kbd> stop</> : <><kbd>enter</kbd> send <kbd>shift+enter</kbd> newline</>}
          </span>
          {running && (
            <button className="send-btn stop" title="Stop (Esc)" onClick={() => convId && stopConversation(convId)}>
              <span className="stop-square" />
            </button>
          )}
          {(!running || text.trim()) && (
            <button className="send-btn" title={running ? "Queue (Enter): runs after the current reply" : "Send (Enter)"} disabled={!text.trim()} onClick={() => void submit()}>
              <Icon name={running ? "clock" : "arrowUp"} size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
