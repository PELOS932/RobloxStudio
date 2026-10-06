import { useEffect, useMemo, useRef, useState } from "react";
import type { RigType } from "../../shared/animation.ts";
import type { ResolvedAbility } from "../../shared/ability.ts";
import { abilityExtent, createAbilityScene, defaultView, VIEWS, type AbilityScene, type AbilityView } from "../lib/ability3d.ts";
import { BACKDROPS, createStage, type Backdrop, type Stage } from "../lib/stage3d.ts";
import { Icon } from "../lib/icons.tsx";
import { BackdropButton, GlowToggle, TextureBadge, usePref } from "./VfxViewer.tsx";

// Live preview of an ability (or of an effect on a character): the rig plays the animation and
// the effects fire on cue. Play, pause, scrub (re-simulated exactly), speed, loop, rig, glow.

const SPEEDS = [0.1, 0.25, 0.5, 1, 1.5];

export function AbilityViewer({ resolved, rig, onRigChange, compact = false }: {
  resolved: ResolvedAbility; rig: RigType; onRigChange?: (rig: RigType) => void; compact?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const sceneRef = useRef<AbilityScene | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [time, setTime] = useState(0);
  const [backdrop, setBackdrop] = usePref<Backdrop>("forge.vfxBackdrop", "night", Object.keys(BACKDROPS) as Backdrop[]);
  const [glow, setGlow] = usePref<"on" | "off">("forge.vfxGlow", "on", ["on", "off"]);
  const [view, setView] = useState<AbilityView>(() => defaultView(resolved));
  const length = resolved.length;
  const markers = useMemo(
    () => [
      ...resolved.events.map((e) => ({ t: e.event.at, label: `${e.event.name ?? e.vfx.name} · ${e.event.at}s${e.event.travel ? " (projectile)" : ""}`, kind: e.event.travel ? "travel" : "" })),
      ...resolved.summons.map((m) => ({ t: m.summon.at, label: `${m.templateName} (summon) · ${m.summon.at}–${m.until}s`, kind: "summon" })),
      ...resolved.props.map((p) => ({ t: p.prop.at, label: `${p.templateName} (prop) · ${p.prop.at}–${p.until}s`, kind: "prop" })),
    ],
    [resolved],
  );

  useEffect(() => {
    const stage = createStage(hostRef.current!, { characters: true });
    stageRef.current = stage;
    return () => {
      stage.dispose();
      stageRef.current = null;
    };
  }, []);
  useEffect(() => stageRef.current?.setBackdrop(backdrop), [backdrop]);
  useEffect(() => {
    if (stageRef.current) stageRef.current.glow.enabled = glow === "on";
  }, [glow]);

  useEffect(() => setView(defaultView(resolved)), [resolved]);
  const extent = useMemo(() => abilityExtent(resolved, rig), [resolved, rig]);
  useEffect(() => {
    stageRef.current?.frame(extent.center, extent.radius, VIEWS[view]);
  }, [extent, view]);

  // The scene, rebuilt when the ability or rig changes.
  useEffect(() => {
    const s = stageRef.current;
    if (!s) return;
    const scene = createAbilityScene(resolved, rig);
    s.scene.add(scene.group);
    sceneRef.current = scene;
    setTime(0);
    setPlaying(true);
    return () => {
      s.scene.remove(scene.group);
      scene.dispose();
      sceneRef.current = null;
    };
  }, [resolved, rig]);

  useEffect(() => {
    const s = stageRef.current;
    if (!s) return;
    let last = performance.now();
    let shown = -1;
    s.renderer.setAnimationLoop((now) => {
      const dt = Math.min(0.1, (now - last) / 1000) * speed;
      last = now;
      const scene = sceneRef.current;
      if (scene && playing) {
        const before = scene.time();
        if (!loop && before + dt >= scene.length) {
          scene.update(scene.length - before, s.camera);
          setPlaying(false);
        } else scene.update(dt, s.camera);
        const t = scene.time();
        if (Math.abs(t - shown) > 0.04 || t < shown) {
          shown = t;
          setTime(t);
        }
      }
      s.render();
    });
    return () => s.renderer.setAnimationLoop(null);
  }, [playing, speed, loop, resolved, rig]);

  const seek = (t: number) => {
    const s = stageRef.current, scene = sceneRef.current;
    if (!s || !scene) return;
    scene.seek(t, s.camera);
    setTime(scene.time());
  };
  const barRef = useRef<HTMLDivElement>(null);
  const scrubTo = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    seek(((clientX - r.left) / r.width) * length);
  };
  const toggle = () => {
    const scene = sceneRef.current;
    if (!playing && scene && scene.time() >= length - 1e-3) seek(0);
    setPlaying((p) => !p);
  };

  return (
    <div className="anim-viewer vfx-viewer" tabIndex={0} onKeyDown={(e) => e.key === " " && (e.preventDefault(), toggle())}>
      <div ref={hostRef} className="anim-canvas" />
      <div className="vfx-emitters" role="group" aria-label="Rig">
        {onRigChange && (
          <span className="seg ability-rig">
            {(["R15", "R6"] as const).map((r) => (
              <button key={r} className={rig === r ? "active" : ""} onClick={() => onRigChange(r)}>
                {r}
              </button>
            ))}
          </span>
        )}
        <span className="seg ability-rig" title="Camera">
          {(Object.keys(VIEWS) as AbilityView[]).map((v) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </span>
        <TextureBadge />
        {resolved.missing.length > 0 && <span className="vfx-tex warn" title={resolved.missing.join(", ")}>Missing {resolved.missing.length} asset{resolved.missing.length > 1 ? "s" : ""}</span>}
      </div>
      <div className="anim-bar">
        <button className="icon-btn anim-play" title={playing ? "Pause (space)" : "Play (space)"} onClick={toggle}>
          <Icon name={playing ? "pause" : "play"} size={15} />
        </button>
        <div
          ref={barRef}
          className="anim-track"
          role="slider"
          aria-label="Time"
          aria-valuemin={0}
          aria-valuemax={length}
          aria-valuenow={time}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            setPlaying(false);
            scrubTo(e.clientX);
          }}
          onPointerMove={(e) => e.buttons === 1 && scrubTo(e.clientX)}
        >
          {markers.map((m, i) => (
            <i key={i} className={`anim-key ability-key ${m.kind}`} style={{ left: `${(m.t / length) * 100}%` }} title={m.label} />
          ))}
          <span className="anim-fill" style={{ width: `${(time / length) * 100}%` }} />
          <span className="anim-cursor" style={{ left: `${(time / length) * 100}%` }} />
        </div>
        <span className="anim-time">{time.toFixed(2)} / {length.toFixed(2)}s</span>
        {!compact && <GlowToggle on={glow === "on"} onChange={(v) => setGlow(v ? "on" : "off")} />}
        {!compact && <BackdropButton value={backdrop} onChange={setBackdrop} />}
        <select className="anim-speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Playback speed (slow motion helps judge timing)">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>{s}×</option>
          ))}
        </select>
        <button className={`icon-btn ${loop ? "active" : ""}`} title={loop ? "Looping" : "Play once"} onClick={() => setLoop((l) => !l)}>
          <Icon name="rotate" size={14} />
        </button>
      </div>
    </div>
  );
}
