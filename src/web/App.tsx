import { useEffect } from "react";
import { startConnection, useStore } from "./store.ts";
import { Chat } from "./components/Chat.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { MobileNav, PermissionDialog, Sidebar, Toasts, TopBar } from "./components/Shell.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { HtmlImportDialog } from "./components/HtmlTools.tsx";
import { RenderOnly } from "./components/RenderOnly.tsx";
import { CommandPalette, ShortcutsDialog } from "./components/CommandPalette.tsx";

const renderId = new URLSearchParams(location.search).get("render");

export function App() {
  if (renderId) return <RenderOnly id={renderId} />;
  return <Workbench />;
}

function Workbench() {
  const online = useStore((s) => s.online);
  const booted = useStore((s) => s.booted);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const view = useStore((s) => s.mobileView);
  const runningAny = useStore((s) => Object.keys(s.running).length > 0);
  const unseenDone = useStore((s) => s.unseenDone);
  const chatTitle = useStore((s) => s.conversations.find((c) => c.id === s.activeConvId)?.title);

  useEffect(() => {
    startConnection();
  }, []);

  // Global shortcuts: Ctrl/Cmd+K opens the palette, "?" lists shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useStore.setState((s) => ({ paletteOpen: !s.paletteOpen }));
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key === "?" && !typing && !document.querySelector(".modal-backdrop")) {
        e.preventDefault();
        useStore.setState({ shortcutsOpen: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The tab title shows progress, so a long build can run in the background.
  useEffect(() => {
    document.title = unseenDone
      ? "✓ Reply ready · Studio Forge"
      : runningAny
        ? `Working… · ${chatTitle ?? "Studio Forge"}`
        : chatTitle
          ? `${chatTitle} · Studio Forge`
          : "Studio Forge";
  }, [unseenDone, runningAny, chatTitle]);

  return (
    <div className="app">
      <TopBar />
      <main className={`main ${sidebarOpen ? "" : "sidebar-collapsed"}`} data-view={view}>
        <Sidebar />
        <Chat />
        <RightPanel />
      </main>
      <MobileNav />
      {booted && !online && <div className="offline-banner">Reconnecting to the Studio Forge server…</div>}
      <PermissionDialog />
      <SettingsDialog />
      <HtmlImportDialog />
      <CommandPalette />
      <ShortcutsDialog />
      <Toasts />
    </div>
  );
}
