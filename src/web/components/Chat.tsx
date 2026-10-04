import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  importAsset, openAsset, renameConversation, sendMessage, startNewChat, stopConversation, toast, updateSettings, useStore,
} from "../store.ts";
import { Icon, KindIcon, type IconName } from "../lib/icons.tsx";
import { highlightLuau } from "./ScriptView.tsx";
import { sizeLabel, type AssetKind } from "../../shared/assets.ts";
import type { Block, ChatMessage, Effort, TurnUsage } from "../../shared/protocol.ts";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5", hint: "Highest quality" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", hint: "Balanced speed and quality" },
  { id: "claude-fable-5-1", label: "Fable 5.1", hint: "Claude Fable" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "Fastest, lowest usage" },
];

const EFFORTS: { id: Effort; label: string; hint: string }[] = [
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
      if (!s.settingsOpen && !s.htmlImportOpen && !s.permissions.length) stopConversation(activeId);
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
            <Icon name="arrowDown" size={14} /> {status ? "Following reply" : "Jump to latest"}
          </button>
        )}
      </Composer>
      {dragging && (
        <div className="drop-overlay">
          <div>
            <Icon name="image" size={28} />
            <b>Drop images to attach</b>
            <span>Reference art, screenshots or sketches</span>
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
            <Icon name="pencil" size={13} />
          </button>
        )
      ) : (
        <span className="chat-title muted-title">New chat</span>
      )}
      <span className={`run-pill ${running ? "on" : ""}`}>
        <span className={`dot ${running ? "busy" : "ok"}`} />
        {running ? "Working" : "Ready"}
      </span>
      <span style={{ flex: 1 }} />
      {lastUsage && lastUsage.contextTokens > 0 && (
        <span className="ctx-pill hide-mobile" title="Tokens in the conversation context (most are served from the prompt cache)">
          <Icon name="brain" size={13} /> {fmtTokens(lastUsage.contextTokens)} context
        </span>
      )}
      <button className="icon-btn" title="New chat" onClick={startNewChat}>
        <Icon name="plus" />
      </button>
    </header>
  );
}

// ---------------------------------------------------------------------------

function Welcome() {
  const claude = useStore((s) => s.claude);
  const studio = useStore((s) => s.studio);
  const studioReady = studio.state === "connected" && !!studio.studioId;
  return (
    <div className="hero">
      <div className="hero-orb">
        <span className="brand-mark" />
      </div>
      <h1>What are we building today?</h1>
      <p>Describe a model, a UI or a script. You'll see it here instantly, and it can go into Roblox Studio with one click.</p>
      <div className="hero-status">
        <span className={`hero-chip ${claude.cli === "ok" && claude.loggedIn !== false ? "ok" : "warn"}`}>
          <span className="dot" /> {claude.cli === "missing" ? "Claude Code not installed" : claude.loggedIn === false ? "Claude not signed in" : "Claude ready"}
        </span>
        <button className={`hero-chip ${studioReady ? "ok" : "warn"}`} onClick={() => useStore.setState({ rightTab: "studio", mobileView: "panel" })}>
          <span className="dot" /> {studioReady ? "Studio connected" : "Studio not connected"}
        </button>
      </div>
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
      <div className="starters">
        {STARTERS.map((s) => (
          <button key={s.title} className="starter" onClick={() => void sendMessage(s.prompt).catch((e) => toast(String(e), "error"))}>
            <span className={`starter-icon kind-${s.kind}`}>
              {s.kind === "studio" ? <Icon name="plug" size={16} /> : <KindIcon kind={s.kind} size={16} />}
            </span>
            <span className="starter-text">
              <b>{s.title}</b>
              <small>{s.sub}</small>
            </span>
            <Icon name="arrowUp" size={14} className="starter-go" />
          </button>
        ))}
      </div>
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
      <Icon name={done ? "check" : "copy"} size={14} />
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
      <div className="avatar" aria-hidden="true">
        <span />
      </div>
      <div className="msg-main">
        <div className="msg-head">
          <b>Claude</b>
          {model && <span className="model-tag">{model}</span>}
          <time>{timeOf(message.createdAt)}</time>
        </div>
        <div className="msg-body">
          {segs.map((s, i) =>
            s.kind === "text" ? (
              <Markdown key={i} text={s.text} live={streamingText && i === segs.length - 1} />
            ) : s.kind === "thinking" ? (
              <Thinking key={i} text={s.text} live={live && i === segs.length - 1} />
            ) : (
              <Steps key={i} tools={s.tools} live={live} />
            ),
          )}
          {assetIds.map((id) => <AssetCard key={id} id={id} />)}
          {live && !streamingText && <LiveStatus message={message} />}
          {message.error && (
            <div className="msg-error">
              <Icon name="x" size={14} />
              <span>{message.error}</span>
            </div>
          )}
          {message.interrupted && <div className="msg-note">Stopped by you.</div>}
        </div>
        {!live && (
          <div className="msg-foot">
            {message.usage && <UsageLine usage={message.usage} />}
            <span className="msg-actions">
              {text && <CopyButton text={text} label="Copy reply" />}
              {isLast && onRetry && (message.error || message.interrupted) && (
                <button className="act-btn" title="Retry" onClick={onRetry}>
                  <Icon name="refresh" size={14} />
                </button>
              )}
            </span>
          </div>
        )}
      </div>
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
      {mentions.length > 0 && (
        <div className="mention-row">
          {mentions.map((id) => <MentionChip key={id} id={id} />)}
        </div>
      )}
      <div className="user-bubble">{text}</div>
      <div className="msg-actions user-actions">
        <time>{timeOf(message.createdAt)}</time>
        <CopyButton text={text} />
        <button className="act-btn" title="Edit and resend" onClick={() => useStore.setState({ composerInsert: { text, nonce: Date.now(), replace: true } })}>
          <Icon name="pencil" size={14} />
        </button>
      </div>
    </article>
  );
}

function MentionChip({ id }: { id: string }) {
  const asset = useStore((s) => s.assets.find((a) => a.id === id));
  return (
    <button className="mention" onClick={() => asset && openAsset(id)} disabled={!asset}>
      {asset ? <KindIcon kind={asset.kind} size={12} /> : <Icon name="link" size={12} />}
      {asset?.name ?? id}
    </button>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  return (
    <details className="thinking">
      <summary>
        <Icon name="brain" size={14} />
        <span className={live ? "shimmer" : ""}>{live ? "Thinking…" : "Thought process"}</span>
        <Icon name="chevronRight" size={13} className="chev" />
      </summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}

function liveLabel(message: ChatMessage): string {
  const running = [...message.blocks].reverse().find((b): b is Extract<Block, { type: "tool" }> => b.type === "tool" && b.status === "running");
  if (!running) return message.blocks.length ? "Thinking…" : "Starting…";
  const n = running.name.replace(/^mcp__forge__/, "");
  if (n === "create_model" || n === "edit_model") return "Building the model…";
  if (n.includes("ui")) return "Designing the UI…";
  if (n === "create_script") return "Writing the script…";
  if (n === "import_to_studio") return "Importing into Studio…";
  if (n.startsWith("studio_")) return "Working in Studio…";
  if (n === "permission_prompt") return "Waiting for your approval…";
  return "Working…";
}

function LiveStatus({ message }: { message: ChatMessage }) {
  return (
    <div className="live-status">
      <span className="orbit" />
      <span className="shimmer">{liveLabel(message)}</span>
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
  const rate = cacheRate(usage);
  return (
    <span
      className="usage"
      title={`Input ${usage.inputTokens} · cache read ${usage.cacheReadTokens} · cache write ${usage.cacheWriteTokens} · output ${usage.outputTokens}${usage.costUsd ? ` · $${usage.costUsd.toFixed(4)} API-equivalent (subscriptions aren't billed per token)` : ""}`}
    >
      <span className={rate >= 70 ? "good" : ""}>
        <Icon name="zap" size={12} /> {rate}% cached
      </span>
      <span>
        <Icon name="clock" size={12} /> {(usage.durationMs / 1000).toFixed(1)}s
      </span>
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
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="lang">{luau ? "Luau" : lang}</span>
        <button
          className="btn ghost small"
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{luau ? highlightLuau(code).map((l, i) => <div key={i}>{l.length ? l : " "}</div>) : code}</code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------

const TOOL_META: Record<string, { icon: IconName; title: string }> = {
  create_model: { icon: "cube", title: "Built model" },
  edit_model: { icon: "cube", title: "Edited model" },
  create_ui: { icon: "layout", title: "Designed UI" },
  edit_ui: { icon: "layout", title: "Edited UI" },
  create_ui_html: { icon: "layout", title: "Designed UI (HTML)" },
  edit_ui_html: { icon: "layout", title: "Edited UI (HTML)" },
  create_script: { icon: "code", title: "Wrote script" },
  list_assets: { icon: "grid", title: "Listed assets" },
  get_asset: { icon: "eye", title: "Read asset" },
  import_to_studio: { icon: "upload", title: "Imported to Studio" },
  studio_pull_selection: { icon: "download", title: "Pulled Studio selection" },
  studio_execute_luau: { icon: "terminal", title: "Ran Luau in Studio" },
  studio_search_tree: { icon: "search", title: "Searched the place" },
  studio_inspect: { icon: "eye", title: "Inspected instance" },
  studio_script_read: { icon: "code", title: "Read script" },
  studio_script_edit: { icon: "code", title: "Edited script in Studio" },
  studio_screenshot: { icon: "camera", title: "Studio snapshot" },
  studio_console: { icon: "terminal", title: "Read Studio output" },
  studio_state: { icon: "plug", title: "Checked Studio state" },
  studio_play: { icon: "play", title: "Play-test" },
};

function toolSubject(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (input.name && typeof input.name === "string") return input.name;
  if (name === "studio_execute_luau" && typeof input.code === "string") return input.code.split("\n")[0].slice(0, 80);
  if (input.path) return String(input.path);
  if (input.file_path) return String(input.file_path);
  if (input.command) return String(input.command).slice(0, 80);
  if (input.id) return String(input.id);
  if (input.pattern) return String(input.pattern);
  return "";
}

function Steps({ tools, live }: { tools: Extract<Block, { type: "tool" }>[]; live: boolean }) {
  const running = tools.some((t) => t.status === "running");
  const failed = tools.filter((t) => t.status === "error" || t.status === "denied").length;
  const done = tools.filter((t) => t.status === "done").length;
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (running || tools.length <= 2);
  const title = running
    ? `Working · step ${Math.min(tools.length, done + failed + 1)} of ${tools.length}`
    : `${tools.length} step${tools.length > 1 ? "s" : ""}${failed ? ` · ${failed} failed` : ""}`;
  return (
    <div className={`step-group ${running ? "running" : ""}`}>
      <button className="steps-head" onClick={() => setOpen(!expanded)}>
        <span className={`step-state ${running ? "running" : failed ? "error" : "done"}`}>
          {running ? <span className="spinner" /> : <Icon name={failed ? "x" : "check"} size={12} />}
        </span>
        <span className="steps-title">{title}</span>
        <span className="steps-preview">
          {!expanded && tools.map((t, i) => <Icon key={i} name={(TOOL_META[t.name.replace(/^mcp__forge__/, "")] ?? { icon: "wrench" }).icon} size={13} />)}
        </span>
        <Icon name={expanded ? "chevronDown" : "chevronRight"} size={14} />
      </button>
      {expanded && (
        <ol className="step-list">
          {tools.map((t) => <StepRow key={t.id} block={t} live={live} />)}
        </ol>
      )}
    </div>
  );
}

function StepRow({ block }: { block: Extract<Block, { type: "tool" }>; live: boolean }) {
  const [open, setOpen] = useState(false);
  const short = block.name.replace(/^mcp__forge__/, "");
  const isForge = short !== block.name;
  const meta = TOOL_META[short] ?? { icon: "wrench" as IconName, title: isForge ? short.replace(/_/g, " ") : block.name };
  const input = block.input as any;
  const subject = toolSubject(short, input);
  const note = block.result?.text.split("\n").find((l) => /Imported|Updated in Studio|failed|not applied|No /i.test(l));
  let detail: ReactNode = null;
  if (open) {
    let inputView: ReactNode = null;
    if (short === "studio_execute_luau" && typeof input?.code === "string") {
      inputView = <pre>{highlightLuau(input.code).map((l, i) => <div key={i}>{l.length ? l : " "}</div>)}</pre>;
    } else if (input && Object.keys(input).length) {
      const json = JSON.stringify(input, null, 2);
      inputView = <pre>{json.length > 6000 ? json.slice(0, 6000) + "\n…" : json}</pre>;
    }
    detail = (
      <div className="step-detail">
        {inputView && <span className="tool-label">Input</span>}
        {inputView}
        {block.inputPartial && <pre>{block.inputPartial.slice(-2000)}</pre>}
        {block.result?.text && (
          <>
            <span className="tool-label">Result</span>
            <pre>{block.result.text}</pre>
          </>
        )}
      </div>
    );
  }
  return (
    <li className={`step ${block.status}`}>
      <span className={`step-state ${block.status}`}>
        {block.status === "running" ? <span className="spinner" /> : <Icon name={block.status === "done" ? meta.icon : block.status === "denied" ? "shield" : "x"} size={12} />}
      </span>
      <div className="step-main">
        <button className="step-line" onClick={() => setOpen((v) => !v)}>
          <b>{meta.title}</b>
          {subject && <span className="step-subject">{subject}</span>}
          {block.status === "denied" && <span className="step-tag bad">declined</span>}
          {block.status === "error" && <span className="step-tag bad">failed</span>}
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} className="chev" />
        </button>
        {note && !open && <div className={`step-note ${/fail|not applied|No /i.test(note) ? "bad" : ""}`}>{note.replace(/\.$/, "")}</div>}
        {block.result?.images?.map((src, i) => <img key={i} className="step-image" src={src} alt="Studio viewport" />)}
        {detail}
      </div>
    </li>
  );
}

function AssetCard({ id }: { id: string }) {
  const asset = useStore((s) => s.assets.find((a) => a.id === id));
  const importing = useStore((s) => !!s.importing[id]);
  const active = useStore((s) => s.activeAssetId === id);
  if (!asset) return null;
  const inStudio = asset.lastImport && asset.lastImport.version === asset.version;
  return (
    <div className={`asset-card ${active ? "active" : ""}`}>
      <button className={`asset-thumb ${asset.kind}`} onClick={() => openAsset(id)} title="Open preview">
        <KindIcon kind={asset.kind} size={22} />
      </button>
      <div className="asset-info">
        <b>{asset.name}</b>
        <span>
          {asset.kind === "model" ? "3D model" : asset.kind === "ui" ? (asset.fromHtml ? "UI · from HTML" : "UI") : "Script"} · {sizeLabel(asset.kind, asset.size)} · v{asset.version}
        </span>
        <span className={`asset-studio ${inStudio ? "ok" : ""}`}>
          <span className="dot" />
          {inStudio ? `In Studio · ${asset.lastImport!.path}` : asset.lastImport ? "Studio copy is outdated" : "Not in Studio yet"}
        </span>
      </div>
      <div className="asset-actions">
        <button className="btn small" onClick={() => openAsset(id)}>
          <Icon name="eye" size={13} /> Preview
        </button>
        <button className="btn small primary" disabled={importing} onClick={() => void importAsset(id)}>
          {importing ? <span className="spinner light" /> : <Icon name="upload" size={13} />} {inStudio ? "Re-import" : asset.lastImport ? "Update" : "Import"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Menu<T extends string>({ value, options, onChange, icon, label, title }: {
  value: T;
  options: { id: T; label: string; hint: string }[];
  onChange: (v: T) => void;
  icon: IconName;
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
      <button className={`pill-btn ${open ? "open" : ""}`} title={title} onClick={() => setOpen((v) => !v)}>
        <Icon name={icon} size={13} />
        <span>{label}</span>
        <Icon name="chevronDown" size={12} />
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

  const submit = async () => {
    const t = text.trim();
    if (!t || running) return;
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
      <div className={`composer ${running ? "is-running" : ""}`}>
        {(images.length > 0 || activeAsset || attachedAsset) && (
          <div className="composer-context">
            {attachedAsset ? (
              <span className="ctx-chip on" title="Claude will know which asset you mean">
                <KindIcon kind={attachedAsset.kind} size={12} />
                {attachedAsset.name}
                <button aria-label="Remove asset" onClick={() => setAttached(null)}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            ) : activeAsset ? (
              <button className="ctx-chip" onClick={() => (setAttached(activeAsset.id), focusEnd())} title="Refer to the asset open in the preview">
                <Icon name="plus" size={12} /> {activeAsset.name}
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
          placeholder={running ? "Claude is working… you can type your next message" : "Ask for a model, a UI or a script…"}
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
              <Menu value={settings.model} options={modelOptions} onChange={(v) => void updateSettings({ model: v })} icon="cpu" label={model?.label ?? settings.model} title="Model" />
              <span className="hide-mobile">
                <Menu value={settings.effort} options={EFFORTS} onChange={(v) => void updateSettings({ effort: v })} icon="gauge" label={effort?.label ?? "Auto"} title="Effort" />
              </span>
            </>
          )}
          <span className="spacer" />
          <span className="kbd-hint hide-mobile">
            {running ? <><kbd>Esc</kbd> to stop</> : <><kbd>↵</kbd> send · <kbd>⇧↵</kbd> new line</>}
          </span>
          {running ? (
            <button className="send-btn stop" title="Stop (Esc)" onClick={() => convId && stopConversation(convId)}>
              <span className="stop-square" />
            </button>
          ) : (
            <button className="send-btn" title="Send (Enter)" disabled={!text.trim()} onClick={() => void submit()}>
              <Icon name="arrowUp" size={17} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-foot hide-mobile">Claude Code runs on this computer with your own account · Studio Forge never stores your credentials</div>
    </div>
  );
}
