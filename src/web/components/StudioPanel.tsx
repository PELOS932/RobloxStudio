import { useState } from "react";
import { api } from "../lib/api.ts";
import { Icon } from "../lib/icons.tsx";
import { openAsset, toast, useStore } from "../store.ts";
import type { StudioStatus } from "../../shared/protocol.ts";

export function StudioPanel() {
  const studio = useStore((s) => s.studio);
  const [busy, setBusy] = useState<string | null>(null);
  const [code, setCode] = useState('local count = 0\nfor _, d in workspace:GetDescendants() do\n\tif d:IsA("BasePart") then count += 1 end\nend\nreturn count .. " parts in Workspace"');
  const [log, setLog] = useState<{ ok: boolean; text: string }[]>([]);
  const [shot, setShot] = useState<string | null>(null);

  const ready = studio.state === "connected" && !!studio.studioId;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="studio">
      <div className="card">
        <h3>
          <span className={`dot ${dotClass(studio)}`} /> Roblox Studio
          <span style={{ flex: 1 }} />
          {studio.flavor && <span className="badge">{studio.flavor === "builtin" ? "Built-in MCP" : "Legacy plugin"}</span>}
        </h3>
        <p>{describe(studio)}</p>
        {studio.studios.length > 0 && (
          <div className="field">
            <label className="field-label">Place</label>
            <select className="select" value={studio.studioId ?? ""} onChange={(e) => void api("/studio/select", { body: { studioId: e.target.value } })}>
              {studio.studios.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="row">
          {studio.state === "connected" ? (
            <button className="btn" disabled={!!busy} onClick={() => run("disconnect", () => api("/studio/disconnect", { method: "POST" }))}>
              Disconnect
            </button>
          ) : (
            <button className="btn primary" disabled={!!busy || studio.state === "connecting"} onClick={() => run("connect", () => api("/studio/connect", { method: "POST" }))}>
              <Icon name="plug" /> {studio.state === "connecting" ? "Connecting…" : "Connect"}
            </button>
          )}
          <button className="btn ghost" onClick={() => useStore.setState({ settingsOpen: "studio" })}>
            <Icon name="settings" /> Connection settings
          </button>
        </div>
        {studio.command && <div className="muted" style={{ overflowWrap: "anywhere" }}>Server: <span className="kbd">{studio.command}</span></div>}
      </div>

      {studio.state !== "connected" && (
        <div className="card">
          <h3><Icon name="wrench" /> Set up the Studio connection</h3>
          <ol className="steps">
            <li>Open a place in Roblox Studio.</li>
            <li>In Studio, open the <b>Assistant</b> panel → <b>…</b> menu → <b>Manage MCP Servers</b>.</li>
            <li>Turn on <b>Enable Studio as MCP server</b>.</li>
            <li>Press <b>Connect</b> above. Studio Forge finds <span className="kbd">StudioMCP</span> automatically on Windows and macOS.</li>
          </ol>
          <p className="muted">
            No Studio on this machine? Exported <b>.rbxmx</b> files can be dragged into Studio anywhere. The old
            studio-rust-mcp-server plugin also works — set its command (with <span className="kbd">--stdio</span>) in connection settings.
          </p>
        </div>
      )}

      <div className="card">
        <h3><Icon name="download" /> Bring things from Studio</h3>
        <p>Select Parts/Models or a ScreenGui in Studio, then pull them in to preview, edit with Claude and re-import.</p>
        <div className="row">
          <button
            className="btn"
            disabled={!ready || !!busy}
            onClick={() =>
              run("pull", async () => {
                const r = await api<{ ok: boolean; error?: string; id?: string; skipped?: string[] }>("/studio/pull", { method: "POST" });
                if (!r.ok || !r.id) throw new Error(r.error ?? "Pull failed");
                toast(`Pulled selection${r.skipped?.length ? ` (${r.skipped.length} unsupported objects skipped)` : ""}`, "success");
                openAsset(r.id);
              })
            }
          >
            <Icon name="download" /> {busy === "pull" ? "Pulling…" : "Pull selection"}
          </button>
          <button
            className="btn"
            disabled={!ready || !!busy || studio.flavor === "legacy"}
            onClick={() =>
              run("shot", async () => {
                const r = await api<{ ok: boolean; dataUrl?: string; error?: string }>("/studio/screenshot", { method: "POST" });
                if (!r.ok || !r.dataUrl) throw new Error(r.error ?? "No screenshot");
                setShot(r.dataUrl);
              })
            }
          >
            <Icon name="camera" /> {busy === "shot" ? "Capturing…" : "Viewport snapshot"}
          </button>
        </div>
        {shot && <img className="screenshot" src={shot} alt="Studio viewport" />}
      </div>

      <div className="card">
        <h3><Icon name="terminal" /> Luau console</h3>
        <p className="muted">Runs in the Edit data model with plugin permissions. End with <span className="kbd">return</span> to see a value. Changes can be undone in Studio.</p>
        <textarea
          className="console-input"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") document.getElementById("run-luau")?.click();
          }}
        />
        <div className="row">
          <button
            id="run-luau"
            className="btn primary"
            disabled={!ready || !!busy || !code.trim()}
            onClick={() =>
              run("luau", async () => {
                const r = await api<{ ok: boolean; output: string }>("/studio/run", { body: { code } });
                setLog((l) => [...l.slice(-30), { ok: r.ok, text: r.output || "nil" }]);
              })
            }
          >
            <Icon name="play" /> {busy === "luau" ? "Running…" : "Run"}
          </button>
          <span className="muted">Ctrl/⌘ + Enter</span>
          <span style={{ flex: 1 }} />
          {log.length > 0 && <button className="btn ghost small" onClick={() => setLog([])}>Clear</button>}
        </div>
        {log.length > 0 && (
          <pre className="console-out">
            {log.map((l, i) => (
              <div key={i} className={l.ok ? "" : "err"}>{l.ok ? "→ " : "✕ "}{l.text}</div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}

function dotClass(s: StudioStatus) {
  if (s.state === "connected") return s.studioId ? "ok" : "warn";
  if (s.state === "connecting") return "busy";
  if (s.state === "error") return "err";
  return "";
}

function describe(s: StudioStatus): string {
  switch (s.state) {
    case "connected":
      return s.studioId ? `Connected to ${s.studios.find((x) => x.id === s.studioId)?.name ?? "Studio"}.` : s.detail ?? "Connected — waiting for an open place.";
    case "connecting":
      return "Starting the Studio MCP server…";
    case "unconfigured":
      return s.detail ?? "Studio's MCP server was not found on this machine.";
    case "error":
      return s.detail ?? "Could not connect.";
    default:
      return s.detail ?? "Not connected.";
  }
}
