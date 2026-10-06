import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { Icon } from "../lib/icons.tsx";
import { importAsset, insertIntoComposer, loadAsset, setRightTab, toast, useStore } from "../store.ts";
import type { AssetSummary } from "../../shared/assets.ts";
import type { RigType } from "../../shared/animation.ts";
import { useResolvedAbility } from "../lib/use-ability.ts";
import { AbilityViewer } from "./AbilityViewer.tsx";
import { AssetThumb } from "./AssetThumb.tsx";
import { timeAgo } from "./Library.tsx";

// Library > Abilities: magic powers and attacks (an animation plus timed effects) played live on
// a dummy, ready to put in Studio as a castable Tool.

const STARTER_NAMES = /^(Fireball|Lightning Strike|Healing Aura|Ground Slam|Frost Nova|Blade Slash)$/;

export function AbilityPanel({ items }: { items: AssetSummary[] }) {
  const studio = useStore((s) => s.studio);
  const selected = useStore((s) => s.abilityId);
  const cache = useStore((s) => s.assetCache);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [rig, setRig] = useState<RigType | null>(null);
  const list = useMemo(() => items.filter((a) => `${a.name} ${a.description ?? ""}`.toLowerCase().includes(q.toLowerCase())), [items, q]);
  const current = list.find((a) => a.id === selected) ?? list[0];
  const full = current ? cache[current.id] : undefined;
  const asset = full && full.kind === "ability" && full.version === current?.version ? full : undefined;
  const resolved = useResolvedAbility(asset?.spec);
  const ready = studio.state === "connected" && !!studio.studioId;

  useEffect(() => {
    if (current && !asset) void loadAsset(current.id);
  }, [current?.id, current?.version, asset]);
  // Each ability opens on its own rig; the switch previews it on the other one.
  useEffect(() => setRig(null), [current?.id]);

  const addStarters = async () => {
    setAdding(true);
    try {
      const { ids } = await api<{ ids: string[] }>("/abilities/starters", { method: "POST" });
      useStore.setState({ abilityId: ids[0] });
      toast(`Added ${ids.length} starter abilities`, "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setAdding(false);
    }
  };
  const ask = () => insertIntoComposer("Make an ability: ");
  const shownRig = rig ?? asset?.spec.rig ?? "R15";

  return (
    <div className={`anim ${selected && current ? "has-view" : ""}`}>
      <div className="anim-head">
        <input className="search anim-search" placeholder="Search abilities" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn small primary" title="Describe a power or attack to Claude" onClick={ask}>
          <Icon name="sparkles" size={13} /> <span className="long">New ability</span>
        </button>
      </div>
      {list.length === 0 ? (
        <div className="stage">
          <div className="stage-empty">
            <div>
              <div className="big">{q ? `No abilities match "${q}"` : "No abilities yet"}</div>
              <div>An ability is an animation with effects timed to it: "a fireball throw", "a lightning strike", "a ground slam". Preview it here, then cast it in Studio with the Tool it comes with.</div>
              {!q && (
                <div className="row" style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14 }}>
                  <button className="btn primary" onClick={ask}>
                    <Icon name="sparkles" /> Describe one
                  </button>
                  <button className="btn" disabled={adding} onClick={() => void addStarters()}>
                    {adding ? <span className="spinner" /> : <Icon name="plus" />} Add starter abilities
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="anim-body">
          <div className="anim-list">
            {list.map((a) => (
              <button
                key={a.id}
                className={`anim-item ${a.id === current?.id ? "active" : ""}`}
                onClick={() => useStore.setState({ abilityId: a.id, activeAssetId: a.id })}
                onMouseEnter={() => setHover(a.id)}
                onMouseLeave={() => setHover(null)}
              >
                <AssetThumb id={a.id} kind="ability" version={a.version} width={56} height={40} thumb={a.thumb} spin={hover === a.id} />
                <span className="anim-item-meta">
                  <b>{a.name}</b>
                  <small>{a.detail} · {timeAgo(a.updatedAt)}</small>
                </span>
              </button>
            ))}
            {!list.some((a) => STARTER_NAMES.test(a.name)) && !q && (
              <button className="lib-more" disabled={adding} onClick={() => void addStarters()}>
                + Add starter abilities
              </button>
            )}
          </div>
          <div className="anim-view">
            {current && (
              <div className="place-view-head">
                <button className="icon-btn place-back" title="Back to the list" onClick={() => useStore.setState({ abilityId: null })}>
                  <Icon name="chevronRight" size={14} style={{ transform: "rotate(180deg)" }} />
                </button>
                <span className="tree-icon"><Icon name="wand" size={15} /></span>
                <div className="grow">
                  <span className="place-view-name" title={current.description}>{current.name}</span>
                  <span className="sub">{current.detail}{asset && shownRig !== asset.spec.rig ? ` · previewing on ${shownRig}` : ""}</span>
                </div>
                <button className="btn small" title="Ask Claude to change it" onClick={() => insertIntoComposer(`In ability "${current.name}" (${current.id}): `)}>
                  <Icon name="message" size={13} /> <span className="long">Ask Claude</span>
                </button>
                <button
                  className="btn small"
                  title={ready ? "Add it to Studio: ReplicatedStorage.Abilities plus a Tool in StarterPack to cast it in a play-test" : "Connect Roblox Studio first"}
                  onClick={() => (ready ? void importAsset(current.id) : (setRightTab("studio"), toast("Connect Roblox Studio first.", "info")))}
                >
                  <Icon name="upload" size={13} /> <span className="long">To Studio</span>
                </button>
                <a className="btn small" href={`/api/assets/${current.id}/export?format=rbxmx`} title="Download as a Tool (.rbxmx): drop it into StarterPack">
                  <Icon name="download" size={13} />
                </a>
              </div>
            )}
            {current?.description && <div className="ability-desc">{current.description}</div>}
            <div className="stage">
              {resolved ? <AbilityViewer resolved={resolved} rig={shownRig} onRigChange={setRig} /> : <div className="stage-empty"><span className="spinner" /></div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
