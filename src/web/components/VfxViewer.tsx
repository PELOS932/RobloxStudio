import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { isOneShot, oneShotLength, type VfxSpec } from "../../shared/vfx.ts";
import { createVfx, vfxExtent, type VfxRuntime } from "../lib/vfx3d.ts";
import { Icon } from "../lib/icons.tsx";

// Live preview of a visual effect: play/pause, replay one-shots, speed, backdrop and per-emitter
// mute, with orbit controls. Simulation runs every frame only while visible and playing.

const SPEEDS = [0.25, 0.5, 1, 2];
const BACKDROPS = { night: 0x0d0e12, dusk: 0x2a2f3d, day: 0x9fb6c9 } as const;
type Backdrop = keyof typeof BACKDROPS;

export function VfxViewer({ spec }: { spec: VfxSpec }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; floor: THREE.Mesh } | null>(null);
  const runtimeRef = useRef<VfxRuntime | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [backdrop, setBackdrop] = useState<Backdrop>("night");
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const [count, setCount] = useState(0);
  const oneShot = isOneShot(spec);
  const hasBursts = spec.emitters.some((e) => e.type === "particles" && e.burst !== undefined);
  const shown = useMemo<VfxSpec>(
    () => ({ ...spec, emitters: spec.emitters.map((e) => (muted.has(e.name) ? { ...e, enabled: false } : e)) }),
    [spec, muted],
  );

  useEffect(() => setMuted(new Set()), [spec]);

  // Renderer, once.
  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xbfd2ff, 0x1a1712, 0.35));
    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: 0x24262c, roughness: 0.92 }));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const grid = new THREE.PolarGridHelper(40, 16, 10, 64, 0x30323a, 0x30323a);
    grid.position.y = 0.01;
    scene.add(grid);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.495;
    engineRef.current = { renderer, scene, camera, controls, floor };
    const resize = () => {
      const w = host.clientWidth || 1, h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    return () => {
      ro.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      engineRef.current = null;
    };
  }, []);

  // Frame the effect when it changes.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    const { center, radius } = vfxExtent(spec);
    // Fit the bounding sphere in the narrower of the two fields of view.
    const vfov = THREE.MathUtils.degToRad(e.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * e.camera.aspect);
    const dist = Math.max(8, (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05);
    e.controls.target.copy(center);
    e.camera.position.copy(center).addScaledVector(new THREE.Vector3(0.55, 0.32, -1).normalize(), dist);
    e.controls.minDistance = 2;
    e.controls.maxDistance = dist * 4;
    e.controls.update();
  }, [spec]);

  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    const c = new THREE.Color(BACKDROPS[backdrop]);
    e.scene.background = c;
    (e.floor.material as THREE.MeshStandardMaterial).color.set(backdrop === "day" ? 0x6f7a63 : backdrop === "dusk" ? 0x2f3240 : 0x24262c);
  }, [backdrop]);

  // The effect itself: rebuilt when the spec or muted emitters change.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    const rt = createVfx(shown);
    rt.warm(oneShot ? 0 : 1.5, e.camera);
    e.scene.add(rt.object);
    runtimeRef.current = rt;
    return () => {
      e.scene.remove(rt.object);
      rt.dispose();
      runtimeRef.current = null;
    };
  }, [shown, oneShot]);

  // Frame loop.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    let last = performance.now();
    let sinceBurst = 0;
    let shownCount = -1;
    const replayEvery = oneShotLength(spec) + 0.8;
    e.renderer.setAnimationLoop((now) => {
      const dt = Math.min(0.1, (now - last) / 1000) * speed;
      last = now;
      const rt = runtimeRef.current;
      if (rt && playing) {
        rt.update(dt, e.camera);
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
      e.controls.update();
      e.renderer.render(e.scene, e.camera);
    });
    return () => e.renderer.setAnimationLoop(null);
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
        <div className="seg" role="group" aria-label="Backdrop">
          {(Object.keys(BACKDROPS) as Backdrop[]).map((b) => (
            <button key={b} className={backdrop === b ? "active" : ""} onClick={() => setBackdrop(b)}>
              {b[0].toUpperCase() + b.slice(1)}
            </button>
          ))}
        </div>
        <select className="anim-speed" value={speed} onChange={(ev) => setSpeed(Number(ev.target.value))} title="Simulation speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>{s}×</option>
          ))}
        </select>
      </div>
    </div>
  );
}
