import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { Icon } from "../lib/icons.tsx";
import { importAsset, insertIntoComposer, loadAsset, setRightTab, toast, useStore } from "../store.ts";
import type { AssetSummary } from "../../shared/assets.ts";
import { usePref, VfxViewer } from "./VfxViewer.tsx";
import { AbilityViewer } from "./AbilityViewer.tsx";
import { useResolvedAbility } from "../lib/use-ability.ts";
import { ATTACH_POINTS, type AbilitySpec, type AttachPoint } from "../../shared/ability.ts";
import { animationLength, type RigType } from "../../shared/animation.ts";
import { isOneShot, oneShotLength } from "../../shared/vfx.ts";
import type { Asset } from "../../shared/assets.ts";
import { AssetThumb } from "./AssetThumb.tsx";
import { timeAgo } from "./Library.tsx";

// Library > VFX: the game's visual effects, played live.

const STARTER_NAMES = /^(Campfire|Magic Aura|Explosion|Portal)$/;

const ATTACH_LABEL: Record<AttachPoint, string> = {
  root: "Body center", rightHand: "Right hand", leftHand: "Left hand", head: "Head", torso: "Chest",
  rightFoot: "Right foot", leftFoot: "Left foot", ground: "Ground", world: "Cast spot",
};

export function VfxPanel({ items, animations = [] }: { items: AssetSummary[]; animations?: AssetSummary[] }) {
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
  // "On character": the effect plays on a dummy, attached to a body part, while an animation runs.
  const [onChar, setOnChar] = usePref<"on" | "off">("forge.vfxOnChar", "off", ["on", "off"]);
  const [charRig, setCharRig] = usePref<RigType>("forge.vfxRig", "R15", ["R15", "R6"]);
  const [charAttach, setCharAttach] = usePref<AttachPoint>("forge.vfxAttach", "rightHand", ATTACH_POINTS);
  const [charAnim, setCharAnim] = usePref<string>("forge.vfxAnim", "", ["", ...animations.map((a) => a.id)]);
  const anim = charAnim ? cache[charAnim] : undefined;
  useEffect(() => {
    if (charAnim && !anim) void loadAsset(charAnim);
  }, [charAnim, anim]);
  const adHoc = useMemo<AbilitySpec | null>(() => {
    if (!asset || onChar !== "on") return null;
    const vfx = asset.spec;
    const oneShot = isOneShot(vfx);
    const animLen = anim?.kind === "animation" ? animationLength(anim.spec) : 0;
    const length = Math.min(30, Math.max(1, animLen, oneShot ? oneShotLength(vfx) + 0.6 : 3));
    return {
      name: vfx.name,
      rig: charRig,
      ...(charAnim && anim ? { animation: charAnim } : {}),
      events: [{ at: oneShot ? Math.min(0.3, length / 3) : 0, vfx, attach: charAttach, duration: oneShot ? 0.5 : length }],
      length,
    };
  }, [asset, onChar, charRig, charAttach, charAnim, anim]);
  const resolvedAdHoc = useResolvedAbility(adHoc);

  useEffect(() => {
    if (current && !asset) void loadAsset(current.id);
  }, [current?.id, current?.version, asset]);

  /** Save what's shown on the character as an ability (it references this effect and animation). */
  const makeAbility = async () => {
    if (!adHoc || !current) return;
    try {
      const spec = { ...adHoc, name: `${current.name} Power`, events: adHoc.events.map((e) => ({ ...e, vfx: current.id })) };
      const created = await api<Asset>("/assets", { body: { kind: "ability", spec } });
      useStore.setState({ abilityId: created.id, libraryTab: "abilities" });
      toast(`Saved "${created.name}" in Abilities`, "success");
    } catch (e) {
      toast(String(e), "error");
    }
  };

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
            <div className="vfx-char">
              <button className={`btn small ${onChar === "on" ? "active" : ""}`} title="Preview the effect on a character, attached to a body part while an animation plays" onClick={() => setOnChar(onChar === "on" ? "off" : "on")}>
                <Icon name="person" size={13} /> On character
              </button>
              {onChar === "on" && (
                <>
                  <span className="seg">
                    {(["R15", "R6"] as const).map((r) => (
                      <button key={r} className={charRig === r ? "active" : ""} onClick={() => setCharRig(r)}>{r}</button>
                    ))}
                  </span>
                  <select className="input select-sm" value={charAttach} onChange={(e) => setCharAttach(e.target.value as AttachPoint)} title="Where the effect is attached">
                    {ATTACH_POINTS.map((p) => (
                      <option key={p} value={p}>{ATTACH_LABEL[p]}</option>
                    ))}
                  </select>
                  <select className="input select-sm" value={charAnim} onChange={(e) => setCharAnim(e.target.value)} title="Animation the character plays">
                    <option value="">Standing still</option>
                    {animations.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  <button className="btn small" title="Save this as an ability (animation + effect) in the Abilities tab" onClick={() => void makeAbility()}>
                    <Icon name="wand" size={13} /> <span className="long">Save as ability</span>
                  </button>
                </>
              )}
            </div>
            <div className="stage">
              {asset && onChar === "on" && resolvedAdHoc ? (
                <AbilityViewer resolved={resolvedAdHoc} rig={charRig} compact />
              ) : asset ? (
                <VfxViewer spec={asset.spec} />
              ) : (
                <div className="stage-empty"><span className="spinner" /></div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
