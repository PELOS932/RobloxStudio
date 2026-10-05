import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { Icon } from "../lib/icons.tsx";
import { importAsset, insertIntoComposer, loadAsset, setRightTab, toast, useStore } from "../store.ts";
import type { AssetSummary } from "../../shared/assets.ts";
import { VfxViewer } from "./VfxViewer.tsx";
import { AssetThumb } from "./AssetThumb.tsx";
import { timeAgo } from "./Library.tsx";

// Library > VFX: the game's visual effects, played live.

const STARTER_NAMES = /^(Campfire|Magic Aura|Explosion|Portal)$/;

export function VfxPanel({ items }: { items: AssetSummary[] }) {
  const studio = useStore((s) => s.studio);
  const selected = useStore((s) => s.vfxId);
  const cache = useStore((s) => s.assetCache);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const effects = useMemo(() => items.filter((a) => `${a.name} ${a.description ?? ""}`.toLowerCase().includes(q.toLowerCase())), [items, q]);
  const current = effects.find((a) => a.id === selected) ?? effects[0];
  const full = current ? cache[current.id] : undefined;
  const asset = full && full.kind === "vfx" && full.version === current?.version ? full : undefined;
  const ready = studio.state === "connected" && !!studio.studioId;

  useEffect(() => {
    if (current && !asset) void loadAsset(current.id);
  }, [current?.id, current?.version, asset]);

  const addStarters = async () => {
    setAdding(true);
    try {
      const { ids } = await api<{ ids: string[] }>("/vfx/starters", { method: "POST" });
      useStore.setState({ vfxId: ids[0] });
      toast(`Added ${ids.length} starter effects`, "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setAdding(false);
    }
  };

  const ask = () => insertIntoComposer("Make a VFX: ");

  return (
    <div className={`anim ${selected && current ? "has-view" : ""}`}>
      <div className="anim-head">
        <input className="search anim-search" placeholder="Search effects" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn small primary" title="Describe an effect to Claude" onClick={ask}>
          <Icon name="sparkles" size={13} /> <span className="long">New effect</span>
        </button>
      </div>
      {effects.length === 0 ? (
        <div className="stage">
          <div className="stage-empty">
            <div>
              <div className="big">{q ? `No effects match "${q}"` : "No effects yet"}</div>
              <div>Ask Claude for one ("a blue portal", "a fireball impact", "rain"), or start from a few classics.</div>
              {!q && (
                <div className="row" style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14 }}>
                  <button className="btn primary" onClick={ask}>
                    <Icon name="sparkles" /> Describe one
                  </button>
                  <button className="btn" disabled={adding} onClick={() => void addStarters()}>
                    {adding ? <span className="spinner" /> : <Icon name="plus" />} Add starter effects
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="anim-body">
          <div className="anim-list">
            {effects.map((a) => (
              <button
                key={a.id}
                className={`anim-item ${a.id === current?.id ? "active" : ""}`}
                onClick={() => useStore.setState({ vfxId: a.id, activeAssetId: a.id })}
                onMouseEnter={() => setHover(a.id)}
                onMouseLeave={() => setHover(null)}
              >
                <AssetThumb id={a.id} kind="vfx" version={a.version} width={56} height={40} thumb={a.thumb} spin={hover === a.id} />
                <span className="anim-item-meta">
                  <b>{a.name}</b>
                  <small>{a.detail} · {timeAgo(a.updatedAt)}</small>
                </span>
              </button>
            ))}
            {!effects.some((a) => STARTER_NAMES.test(a.name)) && !q && (
              <button className="lib-more" disabled={adding} onClick={() => void addStarters()}>
                + Add starter effects
              </button>
            )}
          </div>
          <div className="anim-view">
            {current && (
              <div className="place-view-head">
                <button className="icon-btn place-back" title="Back to the list" onClick={() => useStore.setState({ vfxId: null })}>
                  <Icon name="chevronRight" size={14} style={{ transform: "rotate(180deg)" }} />
                </button>
                <span className="tree-icon"><Icon name="flame" size={15} /></span>
                <div className="grow">
                  <span className="place-view-name" title={current.description}>{current.name}</span>
                  <span className="sub">{current.detail}</span>
                </div>
                <button className="btn small" title="Ask Claude to change it" onClick={() => insertIntoComposer(`In effect "${current.name}" (${current.id}): `)}>
                  <Icon name="message" size={13} /> <span className="long">Ask Claude</span>
                </button>
                <button
                  className="btn small"
                  title={ready ? "Put it in Studio where you're looking" : "Connect Roblox Studio first"}
                  onClick={() => (ready ? void importAsset(current.id) : (setRightTab("studio"), toast("Connect Roblox Studio first.", "info")))}
                >
                  <Icon name="upload" size={13} /> <span className="long">To Studio</span>
                </button>
                <button
                  className="btn small"
                  title={ready ? "Attach it to the part selected in Studio (welded, so it follows the part)" : "Connect Roblox Studio first"}
                  onClick={() => (ready ? void importAsset(current.id, { parent: "@selection" }) : (setRightTab("studio"), toast("Connect Roblox Studio first.", "info")))}
                >
                  <Icon name="link" size={13} /> <span className="long">Attach</span>
                </button>
                <a className="btn small" href={`/api/assets/${current.id}/export?format=rbxmx`} title="Download the effect (.rbxmx)">
                  <Icon name="download" size={13} />
                </a>
              </div>
            )}
            <div className="stage">
              {asset ? <VfxViewer spec={asset.spec} /> : <div className="stage-empty"><span className="spinner" /></div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
