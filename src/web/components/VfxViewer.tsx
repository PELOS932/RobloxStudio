import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { isOneShot, oneShotLength, type VfxSpec } from "../../shared/vfx.ts";
import { createVfx, onRealTextures, realTextureCount, vfxExtent, type VfxRuntime } from "../lib/vfx3d.ts";
import { BACKDROPS, createStage, type Backdrop, type Stage } from "../lib/stage3d.ts";
import { Icon } from "../lib/icons.tsx";

// Live preview of a visual effect: play/pause, replay one-shots, speed, backdrop, glow and
// per-emitter mute, with orbit controls. Simulation runs only while playing.

const SPEEDS = [0.25, 0.5, 1, 2];

/** Shared by the effect and ability viewers: remembered per browser. */
export function usePref<T extends string>(key: string, initial: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key) as T | null;
      return s && allowed.includes(s) ? s : initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (next: T) => {
      setV(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // Not remembered in private mode.
      }
    },
  ];
}

/** "Roblox textures" when the real built-in textures loaded from the local Studio install. */
export function TextureBadge() {
  const [real, setReal] = useState(realTextureCount() > 0);
  useEffect(() => onRealTextures(() => setReal(true)), []);
  return (
    <span className={`vfx-tex ${real ? "real" : ""}`} title={real ? "Using Roblox's own particle textures from your Studio install" : "Roblox Studio wasn't found on this computer, so built-in particle textures are drawn as close stand-ins"}>
      {real ? "Roblox textures" : "Stand-in textures"}
    </span>
  );
}

/** Cycles the stage backdrop: night, dusk, day. */
export function BackdropButton({ value, onChange }: { value: Backdrop; onChange: (b: Backdrop) => void }) {
  const all = Object.keys(BACKDROPS) as Backdrop[];
  const next = all[(all.indexOf(value) + 1) % all.length];
  return (
    <button className="btn small backdrop-btn" title={`Backdrop: ${value} (click for ${next})`} onClick={() => onChange(next)}>
      <i className={`backdrop-dot ${value}`} /> <span className="long">{value[0].toUpperCase() + value.slice(1)}</span>
    </button>
  );
}

export function GlowToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`icon-btn ${on ? "active" : ""}`} title={on ? "Glow (bloom) on" : "Glow (bloom) off"} onClick={() => onChange(!on)}>
      <Icon name="sparkles" size={14} />
    </button>
  );
}

export function VfxViewer({ spec }: { spec: VfxSpec }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const runtimeRef = useRef<VfxRuntime | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [backdrop, setBackdrop] = usePref<Backdrop>("forge.vfxBackdrop", "night", Object.keys(BACKDROPS) as Backdrop[]);
  const [glow, setGlow] = usePref<"on" | "off">("forge.vfxGlow", "on", ["on", "off"]);
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const [count, setCount] = useState(0);
  const oneShot = isOneShot(spec);
  const hasBursts = spec.emitters.some((e) => e.type === "particles" && e.burst !== undefined);
  const shown = useMemo<VfxSpec>(
    () => ({ ...spec, emitters: spec.emitters.map((e) => (muted.has(e.name) ? { ...e, enabled: false } : e)) }),
    [spec, muted],
  );

  useEffect(() => setMuted(new Set()), [spec]);

  useEffect(() => {
    const stage = createStage(hostRef.current!);
    stageRef.current = stage;
    return () => {
      stage.dispose();
      stageRef.current = null;
    };
  }, []);

  useEffect(() => {
    const s = stageRef.current;
    if (!s) return;
    const { center, radius } = vfxExtent(spec);
    s.frame(center, radius, new THREE.Vector3(0.55, 0.32, -1));
  }, [spec]);

  useEffect(() => stageRef.current?.setBackdrop(backdrop), [backdrop]);
  useEffect(() => {
    if (stageRef.current) stageRef.current.glow.enabled = glow === "on";
  }, [glow]);

  // The effect itself: rebuilt when the spec or muted emitters change.
  useEffect(() => {
    const s = stageRef.current;
    if (!s) return;
    const rt = createVfx(shown);
    rt.warm(oneShot ? 0 : 1.5, s.camera);
    s.scene.add(rt.object);
    runtimeRef.current = rt;
    return () => {
      s.scene.remove(rt.object);
      rt.dispose();
      runtimeRef.current = null;
    };
  }, [shown, oneShot]);

  // Frame loop.
  useEffect(() => {
    const s = stageRef.current;
    if (!s) return;
    let last = performance.now();
    let sinceBurst = 0;
    let shownCount = -1;
    const replayEvery = oneShotLength(spec) + 0.8;
    s.renderer.setAnimationLoop((now) => {
      const dt = Math.min(0.1, (now - last) / 1000) * speed;
      last = now;
      const rt = runtimeRef.current;
      if (rt && playing) {
        rt.update(dt, s.camera);
        sinceBurst += dt;
        // One-shots replay on their own so the preview never goes empty.
        if (hasBursts && sinceBurst > replayEvery) {
          sinceBurst = 0;
          rt.burst();
        }
        const n = rt.particles();
        if (Math.abs(n - shownCount) > 4 || (n === 0) !== (shownCount === 0)) {
          shownCount = n;
          setCount(n);
        }
      }
      s.render();
    });
    return () => s.renderer.setAnimationLoop(null);
  }, [playing, speed, spec, hasBursts]);

  const toggle = (name: string) =>
    setMuted((m) => {
      const next = new Set(m);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="vfx-viewer" tabIndex={0} onKeyDown={(ev) => ev.key === " " && (ev.preventDefault(), setPlaying((p) => !p))}>
      <div ref={hostRef} className="vfx-canvas" />
      <div className="vfx-emitters" role="group" aria-label="Emitters">
        {spec.emitters.map((em) => (
          <button key={em.name} className={muted.has(em.name) ? "off" : ""} title={muted.has(em.name) ? `Show ${em.name}` : `Hide ${em.name}`} onClick={() => toggle(em.name)}>
            <i className={`vfx-dot ${em.type}`} />
            {em.name}
          </button>
        ))}
        <TextureBadge />
      </div>
      <div className="anim-bar vfx-bar">
        <button className="icon-btn anim-play" title={playing ? "Pause (space)" : "Play (space)"} onClick={() => setPlaying((p) => !p)}>
          <Icon name={playing ? "pause" : "play"} size={15} />
        </button>
        {hasBursts && (
          <button className="btn small" title="Fire the one-shot bursts again" onClick={() => runtimeRef.current?.burst()}>
            <Icon name="zap" size={13} /> Burst
          </button>
        )}
        <span className="anim-time">{count} particles</span>
        <span style={{ flex: 1 }} />
        <GlowToggle on={glow === "on"} onChange={(v) => setGlow(v ? "on" : "off")} />
        <BackdropButton value={backdrop} onChange={setBackdrop} />
        <select className="anim-speed" value={speed} onChange={(ev) => setSpeed(Number(ev.target.value))} title="Simulation speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>{s}×</option>
          ))}
        </select>
      </div>
    </div>
  );
}
