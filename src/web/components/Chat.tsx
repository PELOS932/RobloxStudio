import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  importAsset, openAsset, sendMessage, stopConversation, toast, updateSettings, useStore,
} from "../store.ts";
import { Icon, type IconName } from "../lib/icons.tsx";
import { highlightLuau } from "./ScriptView.tsx";
import type { Block, ChatMessage, TurnUsage } from "../../shared/protocol.ts";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

const SUGGESTIONS = [
  { title: "Low-poly campfire", sub: "Logs, ring of stones, glowing embers", prompt: "Build a low-poly campfire: crossed logs, a ring of stones, and glowing neon embers with a warm point light." },
  { title: "Medieval watchtower", sub: "Stone base, timber top, torches", prompt: "Build a medieval watchtower about 30 studs tall: cobblestone base, wooden plank upper floor with railings, a clay-tile roof and two torches." },
  { title: "Item shop UI", sub: "Grid of items, prices, buy buttons", prompt: "Design a modern dark item shop ScreenGui: centered window with a title bar and close button, a scrolling grid of 8 item cards (icon area, name, price with a coin label, green Buy button)." },
  { title: "Health & coins HUD", sub: "Bars and counters, bottom left", prompt: "Design a HUD: bottom-left panel with a health bar (red gradient), a stamina bar (blue) and a coin counter. Clean, rounded, readable on phone and desktop." },
  { title: "Proximity door", sub: "Model + script that opens it", prompt: "Make a wooden door with a frame, then a server Script that slides it open when a player gets within 10 studs and closes it after." },
  { title: "Edit my Studio selection", sub: "Pull what's selected and improve it", prompt: "Pull my current Studio selection and make it look more polished — better materials, colors and small details — then update it in Studio." },
];

// ---------------------------------------------------------------------------

export function Chat() {
  const activeId = useStore((s) => s.activeConvId);
  const conv = useStore((s) => (s.activeConvId ? s.convs[s.activeConvId] : undefined));
  const status = useStore((s) => (s.activeConvId ? s.running[s.activeConvId] : undefined));
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const messages = conv?.messages ?? [];
  const lastLen = messages.length ? JSON.stringify(messages[messages.length - 1]).length : 0;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastLen, activeId]);

  useEffect(() => {
    stick.current = true;
  }, [activeId]);

  return (
    <section className="chat">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages.length === 0 ? (
          <Welcome />
        ) : (
          <div className="chat-inner">
            {messages.map((m, i) => (
              <MessageView key={m.id} message={m} live={!!status && i === messages.length - 1} />
            ))}
          </div>
        )}
      </div>
      <Composer convId={activeId} running={!!status} />
    </section>
  );
}

function Welcome() {
  const claude = useStore((s) => s.claude);
  return (
    <div className="welcome">
      <div className="brand-mark" />
      <h1>What should we build in Roblox?</h1>
      <p>
        Describe a model, a UI or a script. Claude builds it, you see it here in 3D or pixel-accurate UI preview, and it
        goes into Roblox Studio with one click — or automatically.
      </p>
      {claude.cli === "missing" && (
        <div className="msg-error" style={{ marginBottom: 18, textAlign: "left" }}>
          Claude Code CLI was not found. Install it with <code>npm i -g @anthropic-ai/claude-code</code> and sign in from Settings → Claude account.
        </div>
      )}
      {claude.cli === "ok" && claude.loggedIn === false && (
        <div className="msg-error" style={{ marginBottom: 18, textAlign: "left" }}>
          Claude Code is not signed in. Open <button className="btn small" onClick={() => useStore.setState({ settingsOpen: "account" })}>Settings → Claude account</button> to connect your subscription.
        </div>
      )}
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s.title} className="suggestion" onClick={() => void sendMessage(s.prompt).catch((e) => toast(String(e), "error"))}>
            <span>{s.title}</span>
            <small>{s.sub}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const MessageView = memo(function MessageView({ message, live }: { message: ChatMessage; live: boolean }) {
  if (message.role === "user") {
    const text = message.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    return <div className="msg-user">{text}</div>;
  }
  const visible = message.blocks.filter((b) => !(b.type === "thinking" && !b.text.trim()) && !(b.type === "text" && !b.text.trim()));
  return (
    <div className="msg-assistant">
      {visible.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
      {live && (visible.length === 0 || visible[visible.length - 1].type !== "text") && (
        <div className="typing"><span /><span /><span /></div>
      )}
      {message.error && <div className="msg-error">{message.error}</div>}
      {message.interrupted && <div className="msg-meta">Stopped.</div>}
      {message.usage && <UsageLine usage={message.usage} />}
    </div>
  );
});

function BlockView({ block }: { block: Block }) {
  if (block.type === "text") return <Markdown text={block.text} />;
  if (block.type === "thinking") {
    return (
      <details className="thinking">
        <summary>Thinking…</summary>
        {block.text}
      </details>
    );
  }
  return <ToolCard block={block} />;
}

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
    <div className="msg-meta" title="Token usage for this turn. Cost is the API-equivalent price; Claude subscriptions are not billed per token.">
      {usage.contextTokens > 0 && <span>{fmtTokens(usage.contextTokens)} context</span>}
      <span className="cache">{cacheRate(usage)}% cached</span>
      <span>{fmtTokens(usage.outputTokens)} out</span>
      {usage.costUsd > 0 && <span>${usage.costUsd.toFixed(usage.costUsd < 0.1 ? 3 : 2)}</span>}
      <span>{(usage.durationMs / 1000).toFixed(1)}s</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
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
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang}</span>
        <button
          className="btn ghost small"
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            toast("Copied", "success");
          }}
        >
          <Icon name="copy" size={13} /> Copy
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

function ToolCard({ block }: { block: Extract<Block, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const short = block.name.replace(/^mcp__forge__/, "");
  const isForge = short !== block.name;
  const meta = TOOL_META[short] ?? { icon: "wrench" as IconName, title: isForge ? short : block.name };
  const input = block.input as any;
  const subject = toolSubject(short, input);
  const assetId = block.result?.text.match(/\b([mus]_[a-z0-9]{6})\b/)?.[1] ?? (typeof input?.id === "string" ? input.id : undefined);
  const assetTool = ["create_model", "edit_model", "create_ui", "edit_ui", "create_script", "import_to_studio", "studio_pull_selection"].includes(short);
  const firstLine = block.result?.text.split("\n").find((l) => /Imported|Updated in Studio|failed/i.test(l));

  let detail: ReactNode = null;
  if (open) {
    let inputView: ReactNode;
    if (short === "studio_execute_luau" && typeof input?.code === "string") {
      inputView = <pre>{highlightLuau(input.code).map((l, i) => <div key={i}>{l.length ? l : " "}</div>)}</pre>;
    } else if (input && Object.keys(input).length) {
      const json = JSON.stringify(input, null, 2);
      inputView = <pre>{json.length > 6000 ? json.slice(0, 6000) + "\n…" : json}</pre>;
    }
    detail = (
      <div className="tool-body">
        {inputView && (
          <>
            <span className="tool-label">Input</span>
            {inputView}
          </>
        )}
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
    <div className="tool">
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-icon"><Icon name={meta.icon} size={14} /></span>
        <span className="tool-title">
          <b>{meta.title}</b>
          {subject && <> · {subject}</>}
          {firstLine && <span className="muted"> — {firstLine.replace(/\.$/, "")}</span>}
        </span>
        <span className={`status-chip ${block.status}`}>{block.status === "running" ? "working…" : block.status}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
      </button>
      {block.result?.images?.map((src, i) => (
        <div key={i} style={{ padding: "0 12px 10px" }}>
          <img src={src} alt="Tool output" style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid var(--border)" }} />
        </div>
      ))}
      {assetTool && assetId && block.status === "done" && (
        <div className="tool-actions" style={{ padding: "0 12px 10px" }}>
          <button className="btn small" onClick={() => openAsset(assetId)}>
            <Icon name="eye" size={13} /> Open preview
          </button>
          <button className="btn small" onClick={() => void importAsset(assetId)}>
            <Icon name="upload" size={13} /> Import to Studio
          </button>
        </div>
      )}
      {detail}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Composer({ convId, running }: { convId: string | null; running: boolean }) {
  const settings = useStore((s) => s.settings);
  const insert = useStore((s) => s.composerInsert);
  const [text, setText] = useState("");
  const [images, setImages] = useState<{ mediaType: string; data: string; url: string }[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(240, el.scrollHeight) + "px";
  }, [text]);

  useEffect(() => {
    if (!insert) return;
    setText((t) => (t ? `${t}\n${insert.text}` : insert.text));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [insert]);

  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
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
  };

  const submit = async () => {
    const t = text.trim();
    if (!t || running) return;
    try {
      await sendMessage(t, images.length ? images.map(({ mediaType, data }) => ({ mediaType, data })) : undefined);
      setText("");
      setImages([]);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  };

  return (
    <div className="composer-wrap">
      <div
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
      >
        {images.length > 0 && (
          <div className="attachments">
            {images.map((img, i) => (
              <div className="attachment" key={i}>
                <img src={img.url} alt="" />
                <button onClick={() => setImages((l) => l.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder="Describe a model, UI or script… (paste reference images too)"
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
            }
          }}
        />
        <div className="composer-bar">
          <label className="icon-btn" title="Attach image" style={{ cursor: "pointer" }}>
            <Icon name="attach" />
            <input type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} />
          </label>
          {settings && (
            <>
              <select value={settings.model} onChange={(e) => void updateSettings({ model: e.target.value })} title="Model">
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
                {!MODELS.some((m) => m.id === settings.model) && <option value={settings.model}>{settings.model}</option>}
              </select>
              <select value={settings.effort} onChange={(e) => void updateSettings({ effort: e.target.value as typeof settings.effort })} title="Effort" className="hide-mobile">
                <option value="default">Effort: auto</option>
                <option value="low">Effort: low</option>
                <option value="medium">Effort: medium</option>
                <option value="high">Effort: high</option>
                <option value="xhigh">Effort: x-high</option>
                <option value="max">Effort: max</option>
              </select>
            </>
          )}
          <span className="spacer" />
          {running ? (
            <button className="send-btn stop" title="Stop" onClick={() => convId && stopConversation(convId)}>
              <Icon name="stop" />
            </button>
          ) : (
            <button className="send-btn" title="Send (Enter)" disabled={!text.trim()} onClick={() => void submit()}>
              <Icon name="arrowUp" />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint hide-mobile">Enter to send · Shift+Enter for a new line · Claude Code runs locally with your account</div>
    </div>
  );
}
