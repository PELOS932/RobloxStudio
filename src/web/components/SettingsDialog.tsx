import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { Icon } from "../lib/icons.tsx";
import { toast, updateClaudeCode, updateSettings, useStore } from "../store.ts";
import { MODELS } from "./Chat.tsx";
import { PlanUsageCard } from "./PlanUsage.tsx";
import type { Settings } from "../../shared/protocol.ts";
import { COMPACT_MAX, COMPACT_MIN, COMPACT_PRESETS, clampCompact, compactPlan, type AutoCompact } from "../../shared/context.ts";

type Section = "general" | "account" | "studio" | "import" | "advanced";

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.settings);
  const close = () => useStore.setState({ settingsOpen: false });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open || !settings) return null;
  const section = open as Section;
  const nav: [Section, string][] = [
    ["general", "General"],
    ["account", "Claude account"],
    ["studio", "Roblox Studio"],
    ["import", "Import"],
    ["advanced", "Advanced"],
  ];
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" style={{ height: "min(86vh, 680px)" }}>
        <div className="modal-head">
          <Icon name="settings" />
          <h2>Settings</h2>
          <button className="icon-btn" onClick={close} title="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav">
            {nav.map(([id, label]) => (
              <button key={id} className={section === id ? "active" : ""} onClick={() => useStore.setState({ settingsOpen: id })}>
                {label}
              </button>
            ))}
          </nav>
          <div className="modal-body">
            {section === "general" && <General s={settings} />}
            {section === "account" && <Account />}
            {section === "studio" && <StudioSettings s={settings} />}
            {section === "import" && <ImportSettings s={settings} />}
            {section === "advanced" && <Advanced s={settings} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({ on, onChange, title, children }: { on: boolean; onChange: (v: boolean) => void; title: string; children?: ReactNode }) {
  return (
    <div className="toggle-row">
      <div className="text">
        <b>{title}</b>
        {children && <span>{children}</span>}
      </div>
      <button className={`switch ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={title} onClick={() => onChange(!on)} />
    </div>
  );
}

function General({ s }: { s: Settings }) {
  return (
    <>
      <div className="field">
        <label>Model</label>
        <div className="choice-grid">
          {MODELS.map((m) => (
            <button key={m.id} className={`choice ${s.model === m.id ? "active" : ""}`} onClick={() => void updateSettings({ model: m.id })}>
              <b>{m.label}</b>
              <span>{m.id === "claude-opus-5-5" ? "Best quality (default)" : m.id === "claude-sonnet-5-5" ? "Fast and capable" : m.id === "claude-fable-5-1" ? "Newest family" : "Fastest, lowest usage"}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Tools Claude can use</label>
        <div className="choice-grid">
          <button className={`choice ${s.toolMode === "studio" ? "active" : ""}`} onClick={() => void updateSettings({ toolMode: "studio" })}>
            <b>Studio (lean)</b>
            <span>Only Studio Forge + Roblox tools. Smallest prompt, lowest usage.</span>
          </button>
          <button className={`choice ${s.toolMode === "full" ? "active" : ""}`} onClick={() => void updateSettings({ toolMode: "full" })}>
            <b>Full Claude Code</b>
            <span>Adds files, shell and web tools in the workspace folder (asks before risky actions).</span>
          </button>
        </div>
      </div>
      <AutoCompactField value={s.autoCompact} />
      <Toggle on={s.autoImport} onChange={(v) => void updateSettings({ autoImport: v })} title="Auto-import into Studio">
        When Studio is connected, every model, UI, animation and effect Claude creates or edits is pushed into the place immediately (scripts always go straight in).
      </Toggle>
      <Toggle on={s.autoApproveLuau} onChange={(v) => void updateSettings({ autoApproveLuau: v })} title="Let Claude run Luau in Studio without asking">
        Off: you approve each Luau snippet and script edit. Imports of assets never need approval.
      </Toggle>
      <Toggle on={s.studioContext} onChange={(v) => void updateSettings({ studioContext: v })} title="Tell Claude what you have selected in Studio">
        Each message carries one short line about your Studio selection and what the camera looks at, so "make this red" works without a lookup.
      </Toggle>
      <Toggle on={s.longCache} onChange={(v) => void updateSettings({ longCache: v })} title="1-hour prompt cache">
        Keeps the conversation cached while you test in Studio, so coming back after a break doesn't re-send the whole context.
      </Toggle>
    </>
  );
}

const k = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`);

function AutoCompactField({ value }: { value: AutoCompact }) {
  const [custom, setCustom] = useState(typeof value === "number" && !COMPACT_PRESETS.includes(value) ? String(value / 1000) : "");
  const set = (v: AutoCompact) => {
    // The reported thresholds belong to the old setting until Claude Code restarts.
    useStore.setState({ contexts: {} });
    void updateSettings({ autoCompact: v });
  };
  const applyCustom = () => {
    const n = Number(custom);
    if (!custom.trim() || !Number.isFinite(n) || n <= 0) return;
    const t = clampCompact(n * 1000);
    setCustom(String(t / 1000));
    set(t);
  };
  const options: [AutoCompact, string][] = [["off", "Off"], ...COMPACT_PRESETS.map((n): [AutoCompact, string] => [n, k(n)]), ["auto", "Claude default"]];
  return (
    <div className="field">
      <label>Auto-compact</label>
      <div className="seg seg-wrap" role="group" aria-label="Auto-compact">
        {options.map(([v, label]) => (
          <button key={String(v)} className={value === v ? "active" : ""} onClick={() => (setCustom(""), set(v))}>
            {label}
          </button>
        ))}
        <span className="seg-custom">
          <input
            className="input"
            inputMode="numeric"
            placeholder="Custom"
            aria-label="Custom threshold in thousands of tokens"
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ""))}
            onBlur={applyCustom}
            onKeyDown={(e) => e.key === "Enter" && applyCustom()}
          />
          k
        </span>
      </div>
      <span className="hint">
        {value === "off"
          ? "Never compacts on its own: replies re-read the whole conversation until it hits the model's limit. "
          : value === "auto"
            ? "Claude Code's default: about 784k tokens on 1M-token models (Opus, Sonnet), 144k on Haiku. "
            : `Summarizes the conversation when it reaches about ${compactPlan(value).threshold.toLocaleString()} tokens. `}
        Smaller keeps replies faster and lighter on your plan; larger keeps more detail. Range {k(COMPACT_MIN)}–{k(COMPACT_MAX)}. Type <span className="kbd">/compact</span> in a chat, or click its token meter, to compact any time.
      </span>
    </div>
  );
}

function Account() {
  const claude = useStore((s) => s.claude);
  const updating = useStore((s) => s.claudeUpdating);
  const lines = useStore((s) => s.loginLines);
  const running = useStore((s) => s.loginRunning);
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [lines]);

  const start = async (method: "claudeai" | "console") => {
    useStore.setState({ loginLines: [], loginRunning: true });
    await api("/claude/login", { body: { method } }).catch((e) => toast(String(e), "error"));
  };

  const linkify = (line: string) => {
    const parts = line.split(/(https?:\/\/\S+)/g);
    return parts.map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a> : p));
  };

  return (
    <>
      <div className="card">
        <h3>
          <span className={`dot ${claude.cli === "ok" ? (claude.loggedIn ? "ok" : "err") : claude.cli === "missing" ? "err" : ""}`} />
          Claude Code
          <span style={{ flex: 1 }} />
          {claude.cli === "ok" && (
            <button className="btn small" disabled={updating} title="Run claude update: new models need a recent Claude Code" onClick={() => void updateClaudeCode()}>
              {updating ? <span className="spinner" /> : <Icon name="download" size={13} />} {updating ? "Updating…" : "Update"}
            </button>
          )}
          <button className="btn small" onClick={() => void api("/claude/refresh", { method: "POST" })}>
            <Icon name="refresh" size={13} /> Re-check
          </button>
        </h3>
        {claude.cli === "missing" && (
          <p>
            The Claude Code CLI wasn't found. Install it with <span className="kbd">npm i -g @anthropic-ai/claude-code</span> (or the native installer), then re-check.
            {claude.detail && <span className="muted"> ({claude.detail})</span>}
          </p>
        )}
        {claude.cli === "ok" && (
          <p>
            Version {claude.version}. {claude.loggedIn ? <>Signed in{claude.authMethod ? ` (${claude.authMethod})` : ""}. Studio Forge runs Claude Code in the background with this account.</> : <>Not signed in.</>}
          </p>
        )}
      </div>

      {claude.cli === "ok" && claude.loggedIn && <PlanUsageCard />}

      <div className="card">
        <h3><Icon name="user" /> Connect your Claude account</h3>
        <p>
          Studio Forge uses the local Claude Code CLI, so your Claude Pro/Max subscription works directly. Sign-in happens in Claude's own login flow; Studio Forge never sees your password or tokens.
        </p>
        <div className="row">
          <button className="btn primary" disabled={running} onClick={() => void start("claudeai")}>
            <Icon name="user" /> Sign in with Claude subscription
          </button>
          <button className="btn" disabled={running} onClick={() => void start("console")}>Use Anthropic Console (API billing)</button>
          {running && <button className="btn ghost" onClick={() => void api("/claude/login/cancel", { method: "POST" })}>Cancel</button>}
          {claude.loggedIn && !running && (
            <button className="btn ghost danger" onClick={() => confirm("Sign Claude Code out on this computer?") && void api("/claude/logout", { method: "POST" })}>
              <Icon name="logout" /> Sign out
            </button>
          )}
        </div>
        {lines.length > 0 && (
          <>
            <pre className="login-log" ref={logRef}>
              {lines.map((l, i) => <div key={i}>{linkify(l)}</div>)}
            </pre>
            {running && (
              <div className="row">
                <input className="input" style={{ flex: 1 }} placeholder="Paste a code here if the login page gives you one" value={input} onChange={(e) => setInput(e.target.value)} />
                <button className="btn" disabled={!input.trim()} onClick={() => void api("/claude/login/input", { body: { text: input.trim() } }).then(() => setInput(""))}>Send</button>
              </div>
            )}
          </>
        )}
        <p className="muted">
          Prefer a terminal? Run <span className="kbd">claude auth login</span> once, or put <span className="kbd">CLAUDE_CODE_OAUTH_TOKEN</span> (from <span className="kbd">claude setup-token</span>) or <span className="kbd">ANTHROPIC_API_KEY</span> in a <span className="kbd">.env</span> file next to Studio Forge, then press Re-check.
        </p>
      </div>
    </>
  );
}

function StudioSettings({ s }: { s: Settings }) {
  const [command, setCommand] = useState(s.studio.command);
  const [args, setArgs] = useState(s.studio.args.join(" "));
  const studio = useStore((st) => st.studio);
  return (
    <>
      <div className="field">
        <label>StudioMCP command</label>
        <input className="input" placeholder="Auto-detect (recommended)" value={command} onChange={(e) => setCommand(e.target.value)} />
        <span className="hint">
          Leave empty to auto-detect Roblox Studio's built-in MCP server (Windows: %LOCALAPPDATA%\Roblox\Versions\…\StudioMCP.exe, macOS: /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP).
          For the legacy plugin use the path to rbx-studio-mcp with argument --stdio.
        </span>
      </div>
      <div className="field">
        <label>Arguments</label>
        <input className="input" placeholder="e.g. --stdio" value={args} onChange={(e) => setArgs(e.target.value)} />
      </div>
      <div className="row" style={{ display: "flex", gap: 8 }}>
        <button
          className="btn primary"
          onClick={() => void updateSettings({ studio: { ...s.studio, command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : [] } }).then(() => api("/studio/connect", { method: "POST" }))}
        >
          Save & reconnect
        </button>
        {studio.command && <span className="muted" style={{ alignSelf: "center", overflowWrap: "anywhere" }}>Current: {studio.command}</span>}
      </div>
      <Toggle on={s.studio.autoConnect} onChange={(v) => void updateSettings({ studio: { ...s.studio, autoConnect: v } })} title="Connect automatically">
        Start the Studio MCP connection when Studio Forge starts and whenever Claude needs Studio.
      </Toggle>
    </>
  );
}

function ImportSettings({ s }: { s: Settings }) {
  const set = (patch: Partial<Settings["import"]>) => void updateSettings({ import: { ...s.import, ...patch } });
  return (
    <>
      <div className="field">
        <label>Where new models are placed</label>
        <div className="choice-grid">
          {([
            ["camera", "Where you're looking", "On the surface in the middle of the Studio view"],
            ["origin", "At the origin", "Bottom-center at 0, 0, 0"],
            ["keep", "Spec coordinates", "Exactly as designed"],
          ] as const).map(([id, title, sub]) => (
            <button key={id} className={`choice ${s.import.placement === id ? "active" : ""}`} onClick={() => set({ placement: id })}>
              <b>{title}</b>
              <span>{sub}</span>
            </button>
          ))}
        </div>
      </div>
      {s.import.placement === "camera" && (
        <Toggle on={s.import.faceCamera} onChange={(v) => set({ faceCamera: v })} title="Face the camera">
          Turns new models so their front faces you (in 90° steps), snapped to whole studs.
        </Toggle>
      )}
      <Toggle on={s.import.replace} onChange={(v) => set({ replace: v })} title="Update in place">
        Re-importing an asset replaces its previous copy (keeping its position) instead of adding a duplicate.
      </Toggle>
      <Toggle on={s.import.optimize} onChange={(v) => set({ optimize: v })} title="Merge parts">
        Combines touching blocks that look identical into one part — same look, fewer parts, faster games.
      </Toggle>
      <Toggle on={s.import.performance} onChange={(v) => set({ performance: v })} title="Static-geometry performance flags">
        Anchors parts, turns off CanTouch, and skips shadows for tiny/neon parts.
      </Toggle>
    </>
  );
}

function Advanced({ s }: { s: Settings }) {
  const [claudePath, setClaudePath] = useState(s.claudePath);
  const [workspace, setWorkspace] = useState(s.workspaceDir);
  return (
    <>
      <div className="field">
        <label>Claude Code CLI</label>
        <input className="input" value={claudePath} onChange={(e) => setClaudePath(e.target.value)} />
        <span className="hint">Command or full path of the claude executable.</span>
      </div>
      <div className="field">
        <label>Workspace folder</label>
        <input className="input" value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
        <span className="hint">Claude Code's working directory. In “Full Claude Code” mode it can read and write files here — point it at your Rojo project if you use one.</span>
      </div>
      <div>
        <button className="btn primary" onClick={() => void updateSettings({ claudePath: claudePath.trim() || "claude", workspaceDir: workspace.trim() || s.workspaceDir })}>
          Save
        </button>
      </div>
    </>
  );
}
