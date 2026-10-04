import { useEffect } from "react";
import { startConnection, useStore } from "./store.ts";
import { Chat } from "./components/Chat.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { MobileNav, PermissionDialog, Sidebar, Toasts, TopBar } from "./components/Shell.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { HtmlImportDialog } from "./components/HtmlTools.tsx";
import { RenderOnly } from "./components/RenderOnly.tsx";

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

  useEffect(() => {
    startConnection();
  }, []);

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
      <Toasts />
    </div>
  );
}
