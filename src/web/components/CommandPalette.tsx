import { useEffect, useMemo, useRef, useState } from "react";
import {
  exportConversation, importAsset, openAsset, openConversation, startNewChat, stopConversation, toast, updateSettings, useStore,
} from "../store.ts";
import { api } from "../lib/api.ts";
import { openScene } from "../lib/place.ts";
import { Icon, KindIcon, type IconName } from "../lib/icons.tsx";
import { EFFORTS, MODELS } from "./Chat.tsx";
import { timeAgo } from "./RightPanel.tsx";
import { sizeLabel } from "../../shared/assets.ts";

interface Item {
  id: string;
  group: "Actions" | "Chats" | "Assets";
  label: string;
  hint?: string;
  /** Extra words that should match (not shown). */
  keywords?: string;
  icon?: IconName;
  kind?: "model" | "ui" | "script";
  run: () => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl";

/** Ranks how well an item matches every word of the query (0 = no match). */
function score(item: Item, words: string[]): number {
  if (!words.length) return 1;
  const label = item.label.toLowerCase();
  const hay = `${label} ${item.keywords ?? ""} ${item.hint ?? ""}`.toLowerCase();
  let total = 0;
  for (const w of words) {
    const at = hay.indexOf(w);
    if (at < 0) return 0;
    total += label.startsWith(w) ? 4 : label.includes(` ${w}`) ? 3 : at < label.length ? 2 : 1;
  }
  return total;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  if (!open) return null;
  return <Palette />;
}

function Palette() {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => useStore.setState({ paletteOpen: false });

  const conversations = useStore((s) => s.conversations);
  const assets = useStore((s) => s.assets);
  const activeAsset = useStore((s) => s.assets.find((a) => a.id === s.activeAssetId));
  const activeConvId = useStore((s) => s.activeConvId);
  const running = useStore((s) => (s.activeConvId ? !!s.running[s.activeConvId] : false));
  const studio = useStore((s) => s.studio);
  const settings = useStore((s) => s.settings);
  const sidebarOpen = useStore((s) => s.sidebarOpen);

  const items = useMemo(() => {
    const out: Item[] = [];
    const studioReady = studio.state === "connected" && !!studio.studioId;
    const act = (id: string, label: string, icon: IconName, run: () => void, hint?: string, keywords?: string) =>
      out.push({ id, group: "Actions", label, icon, run, hint, keywords });

    act("new", "New chat", "plus", startNewChat, undefined, "start conversation");
    if (running && activeConvId) act("stop", "Stop the reply", "stop", () => stopConversation(activeConvId), "esc", "cancel interrupt");
    if (activeAsset) {
      act("import", `${activeAsset.lastImport ? "Update" : "Import"} "${activeAsset.name}" in Studio`, "upload", () => {
        if (!studioReady) return toast("Connect Roblox Studio first.", "info");
        void importAsset(activeAsset.id);
      }, undefined, "send push studio");
      act("export-rbxmx", `Download "${activeAsset.name}" as .rbxmx`, "download", () => {
        location.href = `/api/assets/${activeAsset.id}/export?format=rbxmx`;
      }, undefined, "save file export");
    }
    if (studioReady) {
      act("pull", "Pull the Studio selection", "download", () => {
        void api<{ ok: boolean; error?: string; id?: string }>("/studio/pull", { method: "POST" }).then((r) => {
          if (r.ok && r.id) {
            toast("Pulled the Studio selection", "success");
            openAsset(r.id);
          } else toast(r.error ?? "Pull failed", "error");
        });
      }, undefined, "import from studio selected");
      act("disconnect", "Disconnect Roblox Studio", "plug", () => void api("/studio/disconnect", { method: "POST" }));
    } else {
      act("connect", "Connect Roblox Studio", "plug", () => void api("/studio/connect", { method: "POST" }).catch((e) => toast(String(e), "error")), undefined, "mcp");
    }
    act("html", "Translate HTML to a Roblox UI", "code", () => useStore.setState({ htmlImportOpen: true }), undefined, "import paste convert");
    act("tab-preview", "Show the preview", "eye", () => useStore.setState({ rightTab: "preview", mobileView: "panel" }));
    act("tab-assets", "Show all assets", "grid", () => useStore.setState({ rightTab: "assets", mobileView: "panel" }), undefined, "library");
    act("tab-place", "Browse the Studio place", "map", () => useStore.setState({ rightTab: "place", mobileView: "panel" }), undefined, "explorer workspace tree scripts gui");
    if (studioReady) {
      act("place-map", "View the whole map in 3D", "map", () => {
        useStore.setState({ rightTab: "place", mobileView: "panel" });
        void openScene([["Workspace", 1]], { name: "Workspace", className: "Workspace", nth: 1, children: 0, parts: 0 });
      }, undefined, "workspace baseplate terrain 3d place");
    }
    act("tab-studio", "Show the Studio panel", "plug", () => useStore.setState({ rightTab: "studio", mobileView: "panel" }), undefined, "luau console");
    if (activeConvId) act("export-chat", "Export this chat as Markdown", "download", () => void exportConversation(activeConvId), undefined, "save transcript");
    act("sidebar", sidebarOpen ? "Hide the sidebar" : "Show the sidebar", "sidebar", () => useStore.setState({ sidebarOpen: !sidebarOpen }), undefined, "toggle");
    if (settings) {
      for (const m of MODELS) {
        if (m.id !== settings.model) act(`model-${m.id}`, `Use ${m.label}`, "cpu", () => void updateSettings({ model: m.id }), m.hint, "model switch");
      }
      for (const e of EFFORTS) {
        if (e.id !== settings.effort) act(`effort-${e.id}`, `Effort: ${e.label}`, "gauge", () => void updateSettings({ effort: e.id }), e.hint, "thinking effort");
      }
    }
    act("settings", "Settings", "settings", () => useStore.setState({ settingsOpen: "general" }), undefined, "preferences options");
    act("account", "Claude account", "user", () => useStore.setState({ settingsOpen: "account" }), undefined, "login sign in subscription");
    act("shortcuts", "Keyboard shortcuts", "terminal", () => useStore.setState({ shortcutsOpen: true }), "?", "keys help");

    for (const c of conversations) {
      out.push({ id: `chat-${c.id}`, group: "Chats", label: c.title, hint: timeAgo(c.updatedAt), icon: "message", run: () => void openConversation(c.id) });
    }
    for (const a of assets) {
      out.push({
        id: `asset-${a.id}`, group: "Assets", label: a.name, kind: a.kind,
        hint: `${a.kind} · ${sizeLabel(a.kind, a.size)} · v${a.version}`, keywords: a.id,
        run: () => openAsset(a.id),
      });
    }
    return out;
  }, [conversations, assets, activeAsset, activeConvId, running, studio, settings, sidebarOpen]);

  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
      // Nothing typed: a short list of each group, most recent first.
      const by = (g: Item["group"], n: number) => items.filter((i) => i.group === g).slice(0, n);
      return [...by("Actions", 7), ...by("Chats", 5), ...by("Assets", 5)];
    }
    const groups: Item["group"][] = ["Actions", "Chats", "Assets"];
    return items
      .map((i) => ({ i, s: score(i, words) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => groups.indexOf(a.i.group) - groups.indexOf(b.i.group) || b.s - a.s)
      .slice(0, 40)
      .map((r) => r.i);
  }, [items, q]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    close();
    item.run();
  };

  let lastGroup = "";
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" size={15} />
          <input
            autoFocus
            placeholder="Search chats, assets and actions"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(results[active]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {results.length === 0 && <div className="palette-empty">No matches for "{q}"</div>}
          {results.map((item, i) => {
            const header = item.group !== lastGroup ? (lastGroup = item.group) : null;
            return (
              <div key={item.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  className={`palette-item ${i === active ? "active" : ""}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => choose(item)}
                >
                  <span className="palette-icon">{item.kind ? <KindIcon kind={item.kind} size={14} /> : <Icon name={item.icon ?? "zap"} size={14} />}</span>
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>enter</kbd> open</span>
          <span><kbd>{MOD}</kbd><kbd>K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: [string[], string][] = [
  [[MOD, "K"], "Command palette: chats, assets and actions"],
  [["/"], "Focus the message box"],
  [["enter"], "Send (queues it while Claude is working)"],
  [["shift", "enter"], "New line"],
  [["↑"], "Edit your last message (in an empty message box)"],
  [["esc"], "Stop the reply, or close a dialog"],
  [["?"], "This list"],
];

export function ShortcutsDialog() {
  const open = useStore((s) => s.shortcutsOpen);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        useStore.setState({ shortcutsOpen: false });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;
  const close = () => useStore.setState({ shortcutsOpen: false });
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal narrow" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>Keyboard shortcuts</h2>
          <button className="icon-btn" onClick={close} title="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">
          <dl className="shortcut-list">
            {SHORTCUTS.map(([keys, label]) => (
              <div key={label}>
                <dt>{keys.map((k) => <kbd key={k}>{k}</kbd>)}</dt>
                <dd>{label}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
