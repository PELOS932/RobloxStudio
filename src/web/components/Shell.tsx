import { useMemo } from "react";
import {
  deleteConversation, openConversation, respondPermission, startNewChat, useStore,
} from "../store.ts";
import { Icon } from "../lib/icons.tsx";
import { MODELS, cacheRate, fmtTokens } from "./Chat.tsx";
import { highlightLuau } from "./ScriptView.tsx";

export function TopBar() {
  const claude = useStore((s) => s.claude);
  const studio = useStore((s) => s.studio);
  const settings = useStore((s) => s.settings);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const model = MODELS.find((m) => m.id === settings?.model)?.label ?? settings?.model ?? "";

  const claudeDot = claude.cli === "missing" || claude.loggedIn === false ? "err" : claude.cli === "ok" ? "ok" : "";
  const claudeLabel = claude.cli === "missing" ? "Claude Code not installed" : claude.loggedIn === false ? "Sign in to Claude" : `Claude · ${model}`;
  const studioDot = studio.state === "connected" ? (studio.studioId ? "ok" : "warn") : studio.state === "connecting" ? "busy" : studio.state === "error" ? "err" : "";
  const place = studio.studios.find((s) => s.id === studio.studioId)?.name;
  const studioLabel = studio.state === "connected" ? (place ? place.replace(/\s*\(placeId:.*\)$/, "") : "Studio: no place open") : studio.state === "connecting" ? "Connecting…" : "Studio offline";

  return (
    <header className="topbar">
      <button className="icon-btn hide-mobile" title="Toggle sidebar" onClick={() => useStore.setState({ sidebarOpen: !sidebarOpen })}>
        <Icon name="sidebar" />
      </button>
      <div className="brand">
        <BrandMark />
        Studio Forge
      </div>
      <span className="topbar-spacer" />
      <button className="status-btn" onClick={() => useStore.setState({ settingsOpen: "account" })} title="Claude Code account">
        <i className={`sq ${claudeDot}`} />
        <span className="label">{claudeLabel}</span>
      </button>
      <button className="status-btn" onClick={() => useStore.setState({ rightTab: "studio", mobileView: "panel" })} title="Roblox Studio connection">
        <i className={`sq ${studioDot}`} />
        <span className="label">{studioLabel}</span>
      </button>
      <button className="icon-btn" title="Settings" onClick={() => useStore.setState({ settingsOpen: "general" })}>
        <Icon name="settings" />
      </button>
    </header>
  );
}

/** An anvil, drawn in the accent colour. */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7h15l3-1v3l-4 3h-2v3h3v3H6v-3h3v-3H7C5 12 3 10.5 3 7z" fill="currentColor" />
    </svg>
  );
}

export function Sidebar() {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeConvId);
  const running = useStore((s) => s.running);
  const groups = useMemo(() => groupByDay(conversations), [conversations]);
  const totals = useMemo(() => {
    const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    for (const c of conversations) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += c.usage?.[k] ?? 0;
    return t;
  }, [conversations]);
  const hit = cacheRate(totals);
  const anyUsage = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens > 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <button className="btn new-chat" onClick={startNewChat}>
          <Icon name="plus" size={14} /> New chat
        </button>
      </div>
      <nav className="conv-list">
        {conversations.length === 0 && <div className="muted" style={{ padding: "12px 8px" }}>No chats yet.</div>}
        {groups.map(([label, list]) => (
          <div key={label}>
            <div className="conv-group">{label}</div>
            {list.map((c) => (
              <div key={c.id} className={`conv-item ${c.id === activeId ? "active" : ""}`} role="button" tabIndex={0} onClick={() => void openConversation(c.id)} onKeyDown={(e) => e.key === "Enter" && void openConversation(c.id)}>
                <span className="title">{c.title}</span>
                {running[c.id] && <span className="spinner" title="Working" />}
                <button
                  className="icon-btn del"
                  title="Delete chat"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete "${c.title}"?`)) void deleteConversation(c.id);
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <dl className="usage-stats" title="Totals across all chats. Cost is the API-equivalent price; Claude subscriptions are not billed per token.">
          <div>
            <dt>prompt cache</dt>
            <dd>{anyUsage ? `${hit}%` : "–"}</dd>
          </div>
          <div>
            <dt>tokens in / out</dt>
            <dd>{fmtTokens(totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens)} / {fmtTokens(totals.outputTokens)}</dd>
          </div>
          {totals.costUsd > 0 && (
            <div>
              <dt>api equivalent</dt>
              <dd>${totals.costUsd.toFixed(2)}</dd>
            </div>
          )}
        </dl>
      </div>
    </aside>
  );
}

function groupByDay(list: { id: string; title: string; updatedAt: number; usage: any }[]) {
  const out: [string, typeof list][] = [];
  const today = new Date().setHours(0, 0, 0, 0);
  for (const c of list) {
    const d = c.updatedAt >= today ? "Today" : c.updatedAt >= today - 86_400_000 ? "Yesterday" : c.updatedAt >= today - 7 * 86_400_000 ? "This week" : "Older";
    const g = out.find(([l]) => l === d);
    if (g) g[1].push(c);
    else out.push([d, [c]]);
  }
  return out;
}

export function MobileNav() {
  const view = useStore((s) => s.mobileView);
  const item = (v: typeof view, icon: Parameters<typeof Icon>[0]["name"], label: string) => (
    <button className={view === v ? "active" : ""} onClick={() => useStore.setState({ mobileView: v })}>
      <Icon name={icon} size={18} />
      {label}
    </button>
  );
  return (
    <nav className="mobile-nav">
      {item("chats", "sidebar", "Chats")}
      {item("chat", "message", "Chat")}
      {item("panel", "cube", "Preview & Studio")}
    </nav>
  );
}

export function PermissionDialog() {
  const req = useStore((s) => s.permissions[0]);
  if (!req) return null;
  const name = req.toolName.replace(/^mcp__forge__/, "");
  const input = req.input as any;
  const code: string | undefined = typeof input?.code === "string" ? input.code : typeof input?.command === "string" ? input.command : undefined;
  return (
    <div className="modal-backdrop">
      <div className="modal narrow" role="dialog" aria-modal="true">
        <div className="modal-head">
          <Icon name="shield" />
          <h2>Allow Claude to use a tool?</h2>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: "var(--text-dim)" }}>
            Claude wants to run <span className="perm-tool">{name}</span>
            {name.startsWith("studio_") ? " in Roblox Studio." : "."}
          </p>
          {code ? (
            <div className="codeblock">
              <pre style={{ maxHeight: 320 }}>
                <code>{name === "studio_execute_luau" ? highlightLuau(code).map((l, i) => <div key={i}>{l.length ? l : " "}</div>) : code}</code>
              </pre>
            </div>
          ) : (
            <pre className="console-out">{JSON.stringify(input, null, 2)}</pre>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn danger" onClick={() => respondPermission(req.id, false)}>Deny</button>
          <button className="btn" onClick={() => respondPermission(req.id, true, true)}>Always allow this tool</button>
          <button className="btn primary" onClick={() => respondPermission(req.id, true)}>Allow once</button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <Icon name={t.level === "error" ? "x" : t.level === "success" ? "check" : "info"} size={14} />
          <span style={{ overflowWrap: "anywhere" }}>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
