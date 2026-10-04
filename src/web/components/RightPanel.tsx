import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteAsset, importAsset, insertIntoComposer, loadAsset, openAsset, setRightTab, toast, useStore,
} from "../store.ts";
import { api } from "../lib/api.ts";
import { Icon, KindIcon } from "../lib/icons.tsx";
import { sizeLabel, type Asset, type AssetSummary } from "../../shared/assets.ts";
import { ModelViewer } from "./ModelViewer.tsx";
import { UiPreview } from "./UiPreview.tsx";
import { ScriptView } from "./ScriptView.tsx";
import { StudioPanel } from "./StudioPanel.tsx";

export function RightPanel() {
  const tab = useStore((s) => s.rightTab);
  const assets = useStore((s) => s.assets);
  const studio = useStore((s) => s.studio);
  return (
    <section className="panel">
      <div className="tabs">
        <button className={`tab ${tab === "preview" ? "active" : ""}`} onClick={() => setRightTab("preview")}>
          <Icon name="eye" /> Preview
        </button>
        <button className={`tab ${tab === "assets" ? "active" : ""}`} onClick={() => setRightTab("assets")}>
          <Icon name="grid" /> Assets <span className="count">{assets.length}</span>
        </button>
        <button className={`tab ${tab === "studio" ? "active" : ""}`} onClick={() => setRightTab("studio")}>
          <Icon name="plug" /> Studio <span className={`dot ${studio.state === "connected" ? (studio.studioId ? "ok" : "warn") : studio.state === "connecting" ? "busy" : studio.state === "error" ? "err" : ""}`} />
        </button>
      </div>
      <div className="panel-body">
        {tab === "preview" && <PreviewPane />}
        {tab === "assets" && <AssetLibrary />}
        {tab === "studio" && <StudioPanel />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function PreviewPane() {
  const activeId = useStore((s) => s.activeAssetId);
  const summary = useStore((s) => s.assets.find((a) => a.id === s.activeAssetId));
  const cached = useStore((s) => (s.activeAssetId ? s.assetCache[s.activeAssetId] : undefined));
  const [shown, setShown] = useState<Asset | null>(null);

  useEffect(() => {
    if (!activeId) return setShown(null);
    if (cached) return setShown(cached);
    let alive = true;
    void loadAsset(activeId).then((a) => alive && a && setShown(a));
    return () => {
      alive = false;
    };
  }, [activeId, cached]);

  if (!summary || !shown) {
    return (
      <div className="stage">
        <div className="stage-empty">
          <div>
            <div className="big">Nothing to preview yet</div>
            <div>Ask Claude for a model or UI — it appears here instantly and can be sent to Roblox Studio in one click.</div>
          </div>
        </div>
      </div>
    );
  }

  const asset = shown.id === summary.id ? shown : null;
  const reference = (what: string) =>
    insertIntoComposer(`In ${summary.kind === "ui" ? "UI" : "model"} "${summary.name}" (${summary.id}), change ${summary.kind === "ui" ? "node" : "part"} "${what}": `);

  return (
    <>
      <AssetBar asset={summary} />
      <div className="stage">
        {asset?.kind === "model" && <ModelViewer spec={asset.spec} onReference={reference} />}
        {asset?.kind === "ui" && <UiPreview spec={asset.spec} onReference={reference} />}
        {asset?.kind === "script" && <ScriptView source={asset.spec.source} />}
      </div>
    </>
  );
}

function AssetBar({ asset }: { asset: AssetSummary }) {
  const importing = useStore((s) => !!s.importing[asset.id]);
  const studio = useStore((s) => s.studio);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);
  const ready = studio.state === "connected" && !!studio.studioId;
  const upToDate = asset.lastImport && asset.lastImport.version === asset.version;

  return (
    <div className="asset-bar">
      <span className={`kind-badge ${asset.kind}`}>
        <KindIcon kind={asset.kind} />
      </span>
      <div className="grow">
        <span className="name">{asset.name}</span>
        <span className="sub">
          v{asset.version} · {sizeLabel(asset.kind, asset.size)}
        </span>
        {upToDate && <span className="badge ok hide-mobile" title={asset.lastImport!.path}>In Studio</span>}
      </div>
      <button
        className="btn primary"
        disabled={importing}
        title={ready ? "Import into the open Roblox Studio place" : "Connect Roblox Studio first (Studio tab)"}
        onClick={() => (ready ? importAsset(asset.id) : (setRightTab("studio"), toast("Connect Roblox Studio first.", "info")))}
      >
        <Icon name={importing ? "refresh" : "upload"} /> {importing ? "Importing…" : asset.lastImport ? "Update in Studio" : "Import to Studio"}
      </button>
      <div className="dropdown" ref={menuRef}>
        <button className="btn" onClick={() => setMenu((v) => !v)} title="Download">
          <Icon name="download" />
        </button>
        {menu && (
          <div className="menu">
            <a href={`/api/assets/${asset.id}/export?format=rbxmx`} onClick={() => setMenu(false)}>
              .rbxmx model<small>Drag into Studio or Insert from File</small>
            </a>
            <a href={`/api/assets/${asset.id}/export?format=luau`} onClick={() => setMenu(false)}>
              .luau script<small>Paste into the Studio command bar</small>
            </a>
            <a href={`/api/assets/${asset.id}/export?format=json`} onClick={() => setMenu(false)}>
              .json spec<small>Studio Forge format</small>
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AssetLibrary() {
  const assets = useStore((s) => s.assets);
  const activeId = useStore((s) => s.activeAssetId);
  const [filter, setFilter] = useState<"all" | "model" | "ui" | "script">("all");
  const [q, setQ] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const list = useMemo(
    () => assets.filter((a) => (filter === "all" || a.kind === filter) && a.name.toLowerCase().includes(q.toLowerCase())),
    [assets, filter, q],
  );
  return (
    <>
      <div className="library-tools">
        <input className="search" placeholder="Search assets" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg" style={{ background: "var(--panel-2)" }}>
          {(["all", "model", "ui", "script"] as const).map((f) => (
            <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "model" ? "Models" : f === "ui" ? "UI" : "Scripts"}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => setPasteOpen((v) => !v)} title="Add an asset from JSON">
          <Icon name="plus" /> JSON
        </button>
      </div>
      {pasteOpen && <PasteJson onDone={() => setPasteOpen(false)} />}
      <div className="library">
        {list.length === 0 && <div className="muted" style={{ padding: 16, textAlign: "center" }}>No assets{q ? " match" : " yet"}.</div>}
        {list.map((a) => (
          <div key={a.id} className={`asset-row ${a.id === activeId ? "active" : ""}`} onClick={() => openAsset(a.id)}>
            <span className={`kind-badge ${a.kind}`}>
              <KindIcon kind={a.kind} />
            </span>
            <div className="meta">
              <b>{a.name}</b>
              <small>
                {sizeLabel(a.kind, a.size)} · v{a.version} · {timeAgo(a.updatedAt)}
              </small>
            </div>
            {a.lastImport && <span className={`badge ${a.lastImport.version === a.version ? "ok" : ""}`}>{a.lastImport.version === a.version ? "In Studio" : "Studio outdated"}</span>}
            <button
              className="icon-btn"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete "${a.name}"? This only removes it from Studio Forge.`)) void deleteAsset(a.id);
              }}
            >
              <Icon name="trash" />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function PasteJson({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const submit = async () => {
    try {
      const parsed = JSON.parse(text);
      const kind = parsed.kind ?? (parsed.parts ? "model" : parsed.nodes ? "ui" : parsed.source ? "script" : undefined);
      const spec = parsed.spec ?? parsed;
      const asset = await api<Asset>("/assets", { body: { kind, spec } });
      openAsset(asset.id);
      onDone();
    } catch (err) {
      toast(`Could not add asset: ${err instanceof Error ? err.message : err}`, "error");
    }
  };
  return (
    <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", display: "grid", gap: 8 }}>
      <textarea className="console-input" placeholder='Paste a Studio Forge JSON export ({"kind":"model","spec":{...}})' value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn ghost" onClick={onDone}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={!text.trim()}>Add asset</button>
      </div>
    </div>
  );
}

export function timeAgo(t: number): string {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(t).toLocaleDateString();
}
