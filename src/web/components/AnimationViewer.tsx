import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  animationLength, buildTracks, poseRig, RIGS, sampleTracks, unsupportedJoints, type AnimationSpec, type RigType,
} from "../../shared/animation.ts";
import { studioEnvironment } from "../lib/materials.ts";
import { applyPose, buildRig, type RigMeshes } from "../lib/rig3d.ts";
import { Icon } from "../lib/icons.tsx";

// Live preview of an animation on an R15 or R6 dummy: play, pause, scrub, speed and loop.

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

interface Engine {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  rig: RigMeshes | null;
  draw: () => void;
}

export function AnimationViewer({ spec, rig: rigProp, onRigChange, rigSwitch = true }: {
  spec: AnimationSpec; rig?: RigType; onRigChange?: (rig: RigType) => void; rigSwitch?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [rigType, setRigType] = useState<RigType>(rigProp ?? spec.rig);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(spec.loop ?? true);
  const [time, setTime] = useState(0);
  const timeRef = useRef(0);
  const length = animationLength(spec);
  const tracks = useMemo(() => buildTracks(spec), [spec]);
  const rig = RIGS[rigType];
  const skipped = useMemo(() => unsupportedJoints(spec, rig), [spec, rig]);

  useEffect(() => setRigType(rigProp ?? spec.rig), [rigProp, spec.rig]);
  useEffect(() => {
    setLoop(spec.loop ?? true);
    timeRef.current = 0;
    setTime(0);
    setPlaying(true);
  }, [spec]);

  // Renderer, once.
  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const disposeEnv = studioEnvironment(renderer, scene);
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2622, 1.1));
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.2);
    sun.position.set(6, 12, -8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -6;
    sc.right = sc.top = 6;
    scene.add(sun);
    // A round stage with a stud grid.
    const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 64), new THREE.MeshStandardMaterial({ color: 0x1c1d21, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.PolarGridHelper(6, 16, 6, 64, 0x2c2d33, 0x2c2d33);
    grid.position.y = 0.002;
    scene.add(grid);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 3, 0);
    controls.enableDamping = true;
    controls.minDistance = 4;
    controls.maxDistance = 60;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.update();

    const engine: Engine = { renderer, scene, camera, controls, rig: null, draw: () => renderer.render(scene, camera) };
    // Characters face -Z: look at the front, a little from the right and above, far enough
    // that a jump (about 8 studs tall) and outstretched arms fit in any panel shape.
    let fitted = false;
    const fit = () => {
      const vfov = THREE.MathUtils.degToRad(camera.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      const dist = Math.max(4.8 / Math.tan(vfov / 2), 4 / Math.tan(hfov / 2));
      camera.position.copy(controls.target).addScaledVector(new THREE.Vector3(0.5, 0.28, -1).normalize(), dist);
      controls.update();
    };
    const resize = () => {
      const w = host.clientWidth || 1, h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (!fitted) {
        fit();
        fitted = w > 1;
      }
      engine.draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    engineRef.current = engine;
    return () => {
      ro.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      engine.rig?.dispose();
      disposeEnv();
      renderer.dispose();
      renderer.domElement.remove();
      engineRef.current = null;
    };
  }, []);

  // Rig.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    if (e.rig) {
      e.scene.remove(e.rig.group);
      e.rig.dispose();
    }
    e.rig = buildRig(rig);
    e.scene.add(e.rig.group);
  }, [rig]);

  // Playback loop: poses every frame while playing; otherwise only when scrubbed or orbiting.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    let last = performance.now();
    let shown = -1;
    const pose = (t: number) => {
      if (e.rig) applyPose(e.rig, poseRig(rig, sampleTracks(tracks, t)));
    };
    pose(timeRef.current);
    e.renderer.setAnimationLoop((now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (playing) {
        let t = timeRef.current + dt * speed;
        if (t >= length) {
          if (loop) t %= length;
          else {
            t = length;
            setPlaying(false);
          }
        }
        timeRef.current = t;
        pose(t);
        // The time readout only needs ~20 updates a second.
        if (Math.abs(t - shown) > 0.05 || t === length) {
          shown = t;
          setTime(t);
        }
      }
      e.controls.update();
      e.draw();
    });
    return () => e.renderer.setAnimationLoop(null);
  }, [playing, speed, loop, length, tracks, rig]);

  const seek = (t: number) => {
    const e = engineRef.current;
    timeRef.current = Math.max(0, Math.min(length, t));
    setTime(timeRef.current);
    if (e?.rig) applyPose(e.rig, poseRig(rig, sampleTracks(tracks, timeRef.current)));
  };

  const barRef = useRef<HTMLDivElement>(null);
  const scrubTo = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    seek(((clientX - r.left) / r.width) * length);
  };

  const toggle = () => {
    if (!playing && timeRef.current >= length - 1e-6) seek(0);
    setPlaying((p) => !p);
  };

  return (
    <div className="anim-viewer" tabIndex={0} onKeyDown={(e) => e.key === " " && (e.preventDefault(), toggle())}>
      <div ref={hostRef} className="anim-canvas" />
      {rigSwitch && (
        <div className="anim-rigs seg" role="group" aria-label="Rig">
          {(["R15", "R6"] as const).map((r) => (
            <button key={r} className={rigType === r ? "active" : ""} onClick={() => (setRigType(r), onRigChange?.(r))}>
              {r}
            </button>
          ))}
        </div>
      )}
      {skipped.length > 0 && (
        <div className="anim-note" title={skipped.join(", ")}>
          {rigType} has no {skipped.length > 3 ? `${skipped.slice(0, 3).join(", ")}…` : skipped.join(", ")}
        </div>
      )}
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
          {spec.keyframes.map((k, i) => (
            <i key={i} className="anim-key" style={{ left: `${(k.t / length) * 100}%` }} title={`${k.name ?? "Keyframe"} · ${k.t}s`} />
          ))}
          <span className="anim-fill" style={{ width: `${(time / length) * 100}%` }} />
          <span className="anim-cursor" style={{ left: `${(time / length) * 100}%` }} />
        </div>
        <span className="anim-time">{time.toFixed(2)} / {length.toFixed(2)}s</span>
        <select className="anim-speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Playback speed">
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
