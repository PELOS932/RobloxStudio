// Small still renders of models for asset cards and the library. One shared offscreen
// renderer draws them one at a time; results are cached per asset version.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { toNativeModel, type ModelSpec } from "../../shared/model.ts";
import { materialFor, tileOf } from "./materials.ts";
import { partGeometry, partMatrix } from "./geometry.ts";
import { animationLength, buildTracks, poseRig, RIGS, sampleTracks, type AnimationSpec } from "../../shared/animation.ts";
import { applyPose, buildRig } from "./rig3d.ts";

const W = 288;
const H = 180;

interface Engine {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  root: THREE.Group;
}

let engine: Engine | null = null;
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();

function getEngine(): Engine {
  if (engine) return engine;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2a2622, 0.65));
  // Directional lights only care about direction, so a fixed position works for any model.
  const sun = new THREE.DirectionalLight(0xfff3e0, 2.4);
  sun.position.set(16, 28, 12);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(32, W / H, 0.05, 5000);
  const root = new THREE.Group();
  scene.add(root);
  engine = { renderer, scene, camera, root };
  return engine;
}

/** Add the model to the scene; returns a function that photographs it from an angle around Y. */
function stage(spec: ModelSpec) {
  const e = getEngine();
  const native = toNativeModel(spec);
  for (const p of native.parts) {
    if (p.transparency >= 0.98) continue;
    const mesh = new THREE.Mesh(partGeometry(p, tileOf(p.material)), materialFor(p.material, p.color, p.transparency, p.reflectance));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(partMatrix(p));
    e.root.add(mesh);
  }
  const { min, max } = native.bounds;
  const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const radius = Math.max(0.5, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]));
  const shoot = (angle: number): string => {
    // Same framing as the viewer: front-right, slightly above (Roblox models face -Z).
    const dir = new THREE.Vector3(0.85, 0.6, -1).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    const place = (dist: number) => {
      e.camera.position.copy(center).addScaledVector(dir, dist);
      e.camera.near = Math.max(0.01, dist / 500);
      e.camera.far = dist * 50;
      e.camera.updateProjectionMatrix();
      e.camera.lookAt(center);
      e.camera.updateMatrixWorld();
    };
    // Start from the bounding sphere, then tighten until the box corners fill ~96% of the frame.
    let dist = radius / Math.sin(THREE.MathUtils.degToRad(e.camera.fov) / 2);
    for (let i = 0; i < 3; i++) {
      place(dist);
      const extent = Math.max(...corners.map((c) => {
        const p = c.clone().project(e.camera);
        return Math.max(Math.abs(p.x), Math.abs(p.y));
      }));
      dist *= extent / 0.96;
    }
    place(dist);
    e.renderer.render(e.scene, e.camera);
    return e.renderer.domElement.toDataURL("image/png");
  };
  const clear = () => {
    for (const child of [...e.root.children]) {
      e.root.remove(child);
      (child as THREE.Mesh).geometry.dispose();
    }
  };
  return { shoot, clear };
}

function render(spec: ModelSpec): string {
  const { shoot, clear } = stage(spec);
  try {
    return shoot(0);
  } finally {
    clear();
  }
}

/** A PNG data URL of the model, rendered once per key (asset id + version). */
export function modelThumbnail(key: string, spec: ModelSpec): Promise<string> {
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  let p = pending.get(key);
  if (!p) {
    // Render one model per task so a long library never blocks the page.
    p = queue.then(
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => {
            let url = "";
            try {
              url = render(spec);
            } catch {
              // No WebGL: callers fall back to an icon.
            }
            cache.set(key, url);
            pending.delete(key);
            resolve(url);
          }, 0),
        ),
    );
    queue = p;
    pending.set(key, p);
  }
  return p;
}

const turntables = new Map<string, Promise<string[]>>();

/** Frames of the model turning once around (for hover previews), rendered once per key. */
export function modelTurntable(key: string, spec: ModelSpec, frames = 16): Promise<string[]> {
  let p = turntables.get(key);
  if (!p) {
    p = queue.then(
      () =>
        new Promise<string[]>((resolve) =>
          setTimeout(() => {
            const out: string[] = [];
            try {
              const { shoot, clear } = stage(spec);
              try {
                for (let i = 0; i < frames; i++) out.push(shoot((i / frames) * Math.PI * 2));
              } finally {
                clear();
              }
            } catch {
              // No WebGL: no spin.
            }
            resolve(out);
          }, 0),
        ),
    );
    queue = p;
    turntables.set(key, p);
    // Keep memory bounded: only the most recent few spins stay cached.
    if (turntables.size > 24) turntables.delete(turntables.keys().next().value!);
  }
  return p;
}

const uploaded = new Set<string>();

/** Store a rendered preview on the server, so the library can show it without loading the model. */
export function uploadThumbnail(id: string, version: number, dataUrl: string) {
  const key = `${id}:${version}`;
  if (!dataUrl || uploaded.has(key)) return;
  uploaded.add(key);
  void fetch(`/api/assets/${id}/thumb`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version, dataUrl }),
  }).catch(() => uploaded.delete(key));
}

// ------------------------------------------------------------------ animations

/** Frames of an animation on its rig from a fixed camera (frame 0 doubles as the still). */
function renderAnimation(spec: AnimationSpec, frames: number): string[] {
  const e = getEngine();
  const rig = RIGS[spec.rig];
  const meshes = buildRig(rig);
  e.root.add(meshes.group);
  const tracks = buildTracks(spec);
  const length = animationLength(spec);
  const times = Array.from({ length: frames }, (_, i) => (frames === 1 ? length * 0.35 : (i / frames) * length));
  // Frame the whole motion (jumps, steps) so the camera never has to move.
  const box = new THREE.Box3();
  for (const t of [...times, ...Array.from({ length: 8 }, (_, i) => (i / 8) * length)]) {
    applyPose(meshes, poseRig(rig, sampleTracks(tracks, t)));
    meshes.group.updateMatrixWorld(true);
    box.expandByObject(meshes.group);
  }
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(1.5, box.getSize(new THREE.Vector3()).length() / 2);
  const dir = new THREE.Vector3(0.7, 0.35, -1).normalize();
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(e.camera.fov) / 2) * 0.82;
  e.camera.position.copy(center).addScaledVector(dir, dist);
  e.camera.near = 0.05;
  e.camera.far = dist * 10;
  e.camera.updateProjectionMatrix();
  e.camera.lookAt(center);
  const out: string[] = [];
  try {
    for (const t of times) {
      applyPose(meshes, poseRig(rig, sampleTracks(tracks, t)));
      e.renderer.render(e.scene, e.camera);
      out.push(e.renderer.domElement.toDataURL("image/png"));
    }
  } finally {
    e.root.remove(meshes.group);
    meshes.dispose();
  }
  return out;
}

const animFrames = new Map<string, Promise<string[]>>();

/** A still (frames = 1) or a looping strip of frames, rendered once per key. */
export function animationPreview(key: string, spec: AnimationSpec, frames: number): Promise<string[]> {
  const k = `${key}:${frames}`;
  let p = animFrames.get(k);
  if (!p) {
    p = queue.then(
      () =>
        new Promise<string[]>((resolve) =>
          setTimeout(() => {
            let out: string[] = [];
            try {
              out = renderAnimation(spec, frames);
            } catch {
              // No WebGL.
            }
            resolve(out);
          }, 0),
        ),
    );
    queue = p;
    animFrames.set(k, p);
    if (animFrames.size > 40) animFrames.delete(animFrames.keys().next().value!);
  }
  return p;
}
