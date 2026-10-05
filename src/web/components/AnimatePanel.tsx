import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { Icon } from "../lib/icons.tsx";
import { importAsset, insertIntoComposer, loadAsset, setRightTab, toast, useStore } from "../store.ts";
import type { Asset, AssetSummary } from "../../shared/assets.ts";
import type { RigType } from "../../shared/animation.ts";
import { AnimationViewer } from "./AnimationViewer.tsx";
import { AssetThumb } from "./AssetThumb.tsx";
import { timeAgo } from "./Library.tsx";

// Library > Animations: pick a rig (R15 or R6), browse the game's animations and play them live.

function savedRig(): RigType {
  try {
    return localStorage.getItem("forge.rig") === "R6" ? "R6" : "R15";
  } catch {
    return "R15";
  }
}

export function AnimatePanel({ items }: { items: AssetSummary[] }) {
  const studio = useStore((s) => s.studio);
  const selected = useStore((s) => s.animationId);
  const cache = useStore((s) => s.assetCache);
  const [rig, setRig] = useState<RigType>(savedRig);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const animations = useMemo(() => items.filter((a) => a.name.toLowerCase().includes(q.toLowerCase())), [items, q]);
  const current = animations.find((a) => a.id === selected) ?? animations[0];
  const full = current ? cache[current.id] : undefined;
  const asset = full && full.kind === "animation" && full.version === current?.version ? full : undefined;
  const ready = studio.state === "connected" && !!studio.studioId;

  useEffect(() => {
    if (current && !asset) void loadAsset(current.id);
  }, [current?.id, current?.version, asset]);

  const chooseRig = (r: RigType) => {
    setRig(r);
    try {
      localStorage.setItem("forge.rig", r);
    } catch {
      // Not remembered in private mode.
    }
  };

  const addStarters = async () => {
    setAdding(true);
    try {
      const { ids } = await api<{ ids: string[] }>("/animations/starters", { method: "POST" });
      useStore.setState({ animationId: ids[0] });
      toast(`Added ${ids.length} starter animations`, "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setAdding(false);
    }
  };

  const ask = () => insertIntoComposer(`Make an ${rig} animation: `);

  return (
    <div className={`anim ${selected && current ? "has-view" : ""}`}>
      <div className="anim-head">
        <div className="seg" role="group" aria-label="Rig">
          {(["R15", "R6"] as const).map((r) => (
            <button key={r} className={rig === r ? "active" : ""} title={r === "R15" ? "15 joints: elbows, knees, waist…" : "Classic 6-part rig"} onClick={() => chooseRig(r)}>
              {r}
            </button>
          ))}
        </div>
        <input className="search anim-search" placeholder="Search animations" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn small primary" title="Describe an animation to Claude" onClick={ask}>
          <Icon name="sparkles" size={13} /> <span className="long">New animation</span>
        </button>
      </div>
      {animations.length === 0 ? (
        <div className="stage">
          <div className="stage-empty">
            <div>
              <div className="big">{q ? `No animations match "${q}"` : "No animations yet"}</div>
              <div>Ask Claude for one ("a happy jump", "a sword combo"), or start from a few classics.</div>
              {!q && (
                <div className="row" style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14 }}>
                  <button className="btn primary" onClick={ask}>
                    <Icon name="sparkles" /> Describe one
                  </button>
                  <button className="btn" disabled={adding} onClick={() => void addStarters()}>
                    {adding ? <span className="spinner" /> : <Icon name="plus" />} Add starter animations
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="anim-body">
          <div className="anim-list">
            {animations.map((a) => (
              <button key={a.id} className={`anim-item ${a.id === current?.id ? "active" : ""}`} onClick={() => useStore.setState({ animationId: a.id })}>
                <AssetThumb id={a.id} kind="animation" version={a.version} width={56} height={40} thumb={a.thumb} />
                <span className="anim-item-meta">
                  <b>{a.name}</b>
                  <small>{a.detail} · {timeAgo(a.updatedAt)}</small>
                </span>
              </button>
            ))}
            {!animations.some((a) => /^(Idle Breathing|Walk Cycle)$/.test(a.name)) && !q && (
              <button className="lib-more" disabled={adding} onClick={() => void addStarters()}>
                + Add starter animations
              </button>
            )}
          </div>
          <div className="anim-view">
            {current && (
              <div className="place-view-head">
                <button className="icon-btn place-back" title="Back to the list" onClick={() => useStore.setState({ animationId: null })}>
                  <Icon name="chevronRight" size={14} style={{ transform: "rotate(180deg)" }} />
                </button>
                <span className="tree-icon"><Icon name="anim" size={15} /></span>
                <div className="grow">
                  <span className="place-view-name">{current.name}</span>
                  <span className="sub">{current.detail}{asset && asset.spec.rig !== rig ? ` · previewing on ${rig}` : ""}</span>
                </div>
                {asset && asset.spec.rig !== rig && (
                  <button className="btn small" title={`Make ${rig} this animation's rig`} onClick={() => void api<Asset>("/assets", { body: { kind: "animation", replaceId: asset.id, spec: { ...asset.spec, rig } } })}>
                    <span className="long">Use</span> {rig}
                  </button>
                )}
                <button className="btn small" title="Ask Claude to change it" onClick={() => insertIntoComposer(`In animation "${current.name}" (${current.id}): `)}>
                  <Icon name="message" size={13} /> <span className="long">Ask Claude</span>
                </button>
                <button
                  className="btn small"
                  title={ready ? "Save it in Studio for the Animation Editor (with a dummy rig)" : "Connect Roblox Studio first"}
                  onClick={() => (ready ? void importAsset(current.id) : (setRightTab("studio"), toast("Connect Roblox Studio first.", "info")))}
                >
                  <Icon name="upload" size={13} /> <span className="long">To Studio</span>
                </button>
                <a className="btn small" href={`/api/assets/${current.id}/export?format=rbxmx`} title="Download the KeyframeSequence (.rbxmx)">
                  <Icon name="download" size={13} />
                </a>
              </div>
            )}
            <div className="stage">
              {asset ? <AnimationViewer spec={asset.spec} rig={rig} rigSwitch={false} /> : <div className="stage-empty"><span className="spinner" /></div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
