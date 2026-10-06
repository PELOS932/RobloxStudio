// Frame sheets for Claude: an animation, effect, ability or model drawn by the live preview engine
// at chosen times (or from several sides), one labelled cell per frame, on a stud grid so contact
// with the floor and distances read clearly. Returned as one PNG.
import * as THREE from "three";
import { animationLength, buildTracks, poseRig, RIGS, sampleTracks, type AnimationSpec } from "../../shared/animation.ts";
import { toNativeModel, type ModelSpec } from "../../shared/model.ts";
import type { VfxSpec } from "../../shared/vfx.ts";
import type { ResolvedAbility } from "../../shared/ability.ts";
import type { FramesRequest, FramesView } from "../../shared/protocol.ts";
import { applyPose, buildRig } from "./rig3d.ts";
import { createVfx, mulberry, vfxExtent } from "./vfx3d.ts";
import { abilityExtent, createAbilityScene, defaultView, VIEWS } from "./ability3d.ts";
import { materialFor, studioEnvironment, tileOf } from "./materials.ts";
import { partGeometry, partMatrix } from "./geometry.ts";

const DIRS: Record<Exclude<FramesView, "front+side">, THREE.Vector3> = {
  front: new THREE.Vector3(0.55, 0.3, -1),
  side: new THREE.Vector3(1, 0.22, -0.08),
  behind: new THREE.Vector3(0.4, 0.5, 1),
  top: new THREE.Vector3(0.05, 1, -0.35),
};

interface Shot {
  label: string;
  /** Pose or simulate the scene for this cell. */
  prepare: () => void;
  dir: THREE.Vector3;
}

export async function renderFrames(req: FramesRequest): Promise<string> {
  const cell = req.kind === "model" ? { w: 380, h: 300 } : { w: 300, h: 300 };
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(cell.w, cell.h, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1d22);
  const disposeEnv = studioEnvironment(renderer, scene);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2622, 1.1));
  const sun = new THREE.DirectionalLight(0xfff3e0, 2);
  sun.position.set(8, 16, -6);
  scene.add(sun);
  // A floor with a 1-stud grid (4-stud lines brighter) for judging contact and distances.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x2a2c33, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.01;
  scene.add(floor);
  const fine = new THREE.GridHelper(80, 80, 0x3a3d46, 0x33363e);
  const coarse = new THREE.GridHelper(80, 20, 0x555a66, 0x4a4e59);
  coarse.position.y = 0.005;
  scene.add(fine, coarse);
  const camera = new THREE.PerspectiveCamera(38, cell.w / cell.h, 0.05, 2000);
  const disposers: (() => void)[] = [disposeEnv, () => renderer.dispose()];
  try {
    const { shots, frame } = stage(req, scene, camera, disposers);
    const views = req.view === "front+side" ? ["front", "side"] as const : [req.view] as const;
    const cols = Math.min(req.kind === "model" ? 2 : 6, Math.ceil(shots.length / (req.kind === "model" ? 2 : 1)));
    const rows = Math.ceil(shots.length / cols);
    const canvas = document.createElement("canvas");
    canvas.width = cols * cell.w;
    canvas.height = rows * cell.h * (req.kind === "model" ? 1 : views.length);
    const g = canvas.getContext("2d")!;
    g.font = "600 15px system-ui, sans-serif";
    let row = 0;
    for (const view of req.kind === "model" ? ["front" as const] : views) {
      shots.forEach((shot, i) => {
        shot.prepare();
        const dir = req.kind === "model" ? shot.dir : view === "front" && req.kind === "ability" ? shot.dir : DIRS[view];
        frame(dir);
        renderer.render(scene, camera);
        const x = (i % cols) * cell.w, y = (row + Math.floor(i / cols)) * cell.h;
        g.drawImage(renderer.domElement, x, y);
        const label = req.kind === "model" ? shot.label : `${shot.label}${views.length > 1 || view !== "front" ? ` · ${view}` : ""}`;
        g.fillStyle = "rgba(0,0,0,0.55)";
        g.fillRect(x + 6, y + 6, g.measureText(label).width + 12, 22);
        g.fillStyle = "#f2f2f2";
        g.fillText(label, x + 12, y + 22);
        g.strokeStyle = "#0d0e11";
        g.strokeRect(x + 0.5, y + 0.5, cell.w - 1, cell.h - 1);
      });
      row += Math.ceil(shots.length / cols);
    }
    return canvas.toDataURL("image/png").split(",")[1];
  } finally {
    for (const d of disposers) d();
  }
}

const s2 = (t: number) => `${Math.round(t * 100) / 100}s`;

function aim(camera: THREE.PerspectiveCamera, center: THREE.Vector3, radius: number, dir: THREE.Vector3, fit = 0.9) {
  const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * fit;
  camera.position.copy(center).addScaledVector(dir.clone().normalize(), Math.max(4, dist));
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  camera.updateMatrixWorld();
}

function stage(req: FramesRequest, scene: THREE.Scene, camera: THREE.PerspectiveCamera, disposers: (() => void)[]) {
  if (req.kind === "animation") {
    const spec = req.data as AnimationSpec;
    const rig = RIGS[spec.rig];
    const meshes = buildRig(rig);
    scene.add(meshes.group);
    disposers.push(meshes.dispose);
    const tracks = buildTracks(spec);
    // One camera distance for every frame, fitted to the whole motion.
    const box = new THREE.Box3();
    const len = animationLength(spec);
    for (let i = 0; i <= 12; i++) {
      applyPose(meshes, poseRig(rig, sampleTracks(tracks, (i / 12) * len)));
      meshes.group.updateMatrixWorld(true);
      box.expandByObject(meshes.group);
    }
    box.expandByPoint(new THREE.Vector3(0, 0, 0));
    const center = box.getCenter(new THREE.Vector3()), radius = Math.max(2.6, box.getSize(new THREE.Vector3()).length() / 2);
    const shots: Shot[] = req.times.map((t) => ({ label: s2(t), dir: DIRS.front, prepare: () => applyPose(meshes, poseRig(rig, sampleTracks(tracks, t))) }));
    return { shots, frame: (dir: THREE.Vector3) => aim(camera, center, radius, dir) };
  }
  if (req.kind === "ability") {
    const resolved = req.data as ResolvedAbility;
    const ability = createAbilityScene(resolved, resolved.spec.rig, { loop: false, seed: 5 });
    scene.add(ability.group);
    disposers.push(() => ability.dispose());
    const { center, radius } = abilityExtent(resolved, resolved.spec.rig);
    const own = VIEWS[defaultView(resolved)];
    const shots: Shot[] = req.times.map((t) => ({ label: s2(t), dir: own, prepare: () => ability.seek(t, camera) }));
    return { shots, frame: (dir: THREE.Vector3) => aim(camera, center, radius * 1.1, dir) };
  }
  if (req.kind === "vfx") {
    const spec = req.data as VfxSpec;
    const { center, radius } = vfxExtent(spec);
    let rt = createVfx(spec, mulberry(7));
    scene.add(rt.object);
    let at = 0;
    disposers.push(() => rt.dispose());
    // Simulated forward; an earlier time than the last starts over.
    const shots: Shot[] = [...req.times].sort((a, b) => a - b).map((t) => ({
      label: s2(t), dir: DIRS.front,
      prepare: () => {
        if (t < at) {
          scene.remove(rt.object);
          rt.dispose();
          rt = createVfx(spec, mulberry(7));
          scene.add(rt.object);
          at = 0;
        }
        if (t > at) rt.warm(t - at, camera);
        at = t;
      },
    }));
    return { shots, frame: (dir: THREE.Vector3) => aim(camera, center, Math.max(3, radius), dir) };
  }
  // Models: four sides.
  const spec = req.data as ModelSpec;
  const native = toNativeModel(spec);
  const group = new THREE.Group();
  for (const p of native.parts) {
    if (p.transparency >= 0.98) continue;
    const geo = partGeometry(p, tileOf(p.material));
    const mesh = new THREE.Mesh(geo, materialFor(p.material, p.color, p.transparency, p.reflectance));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(partMatrix(p));
    group.add(mesh);
    disposers.push(() => geo.dispose());
  }
  scene.add(group);
  const { min, max } = native.bounds;
  const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const radius = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  const shots: Shot[] = [
    { label: "front", dir: new THREE.Vector3(0.6, 0.45, -1), prepare: () => {} },
    { label: "back", dir: new THREE.Vector3(-0.6, 0.45, 1), prepare: () => {} },
    { label: "side", dir: new THREE.Vector3(1, 0.25, 0), prepare: () => {} },
    { label: "top", dir: new THREE.Vector3(0.05, 1, -0.2), prepare: () => {} },
  ];
  return { shots, frame: (dir: THREE.Vector3) => aim(camera, center, radius, dir, 1.12) };
}
