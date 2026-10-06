// Live preview of visual effects: Roblox-like particle emitters, beams, trails, fire, smoke,
// sparkles and lights, simulated on the CPU and drawn as instanced quads (one draw call per
// emitter). Close to Roblox behaviour: sequences over each particle's lifetime with envelopes,
// spread cones, shapes, acceleration, drag (half-life), rotation and spin, LightEmission blending,
// orientation modes, squash, flipbooks, locked particles and one-shot bursts.
import * as THREE from "three";
import { decodeDds } from "../../shared/dds.ts";
import {
  colorKeys, DIRECTIONS, FIRE_DEFAULTS, isOneShot, MESH_DEFAULT_LIFE, meshSize, numberKeys, PARTICLE_DEFAULTS, previewMotion, rangeOf, sampleColor,
  sampleNumber, SMOKE_DEFAULTS, SPARKLES_DEFAULT, texturePreset, textureUrl, type ColorKey, type NumKey, type TexturePreset, type VfxBeam,
  type VfxMesh, type VfxParticles, type VfxSpec, type VfxTrail,
} from "../../shared/vfx.ts";
import type { RGB, Vec3 } from "../../shared/math.ts";
import { markGlow } from "./selective-bloom.ts";

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Procedural stand-ins for Roblox's built-in particle textures (white, tinted by color).

const textures = new Map<TexturePreset, THREE.Texture>();

export function particleTexture(preset: TexturePreset): THREE.Texture {
  const hit = textures.get(preset);
  if (hit) return hit;
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const radial = (x: number, y: number, r: number, stops: [number, number][]) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    for (const [o, a] of stops) grad.addColorStop(o, `rgba(255,255,255,${a})`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  let seed = preset.length * 9301 + 49297;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  switch (preset) {
    case "glow":
      radial(64, 64, 64, [[0, 1], [0.25, 0.75], [0.6, 0.18], [1, 0]]);
      break;
    case "sparkle": {
      radial(64, 64, 26, [[0, 1], [0.5, 0.35], [1, 0]]);
      g.fillStyle = "rgba(255,255,255,0.95)";
      for (const [w, h] of [[5, 60], [60, 5]]) {
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 62);
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grad;
        g.beginPath();
        g.ellipse(64, 64, w, h, 0, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case "spark": {
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.4, "rgba(255,255,255,0.6)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(64, 64, 10, 62, 0, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case "fire":
      for (let i = 0; i < 14; i++) radial(64 + (rnd() - 0.5) * 34, 74 - rnd() * 34, 20 + rnd() * 22, [[0, 0.5], [1, 0]]);
      radial(64, 78, 34, [[0, 0.9], [1, 0]]);
      break;
    case "smoke":
    case "puff":
      for (let i = 0; i < (preset === "puff" ? 26 : 18); i++) {
        const a = rnd() * Math.PI * 2, d = rnd() * 30;
        radial(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 18 + rnd() * 20, [[0, preset === "puff" ? 0.5 : 0.32], [1, 0]]);
      }
      break;
    case "core":
      radial(64, 64, 62, [[0, 1], [0.35, 0.85], [0.7, 0.3], [1, 0]]);
      for (let i = 0; i < 12; i++) radial(64 + (rnd() - 0.5) * 50, 64 + (rnd() - 0.5) * 50, 16 + rnd() * 14, [[0, 0.5], [1, 0]]);
      break;
    case "ring": {
      const grad = g.createRadialGradient(64, 64, 30, 64, 64, 63);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.55, "rgba(255,255,255,0.95)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);
      break;
    }
    case "vortex":
      g.translate(64, 64);
      for (let arm = 0; arm < 4; arm++) {
        for (let t = 0; t < 1; t += 0.02) {
          const a = arm * (Math.PI / 2) + t * Math.PI * 2.2;
          const r = 6 + t * 54;
          g.fillStyle = `rgba(255,255,255,${0.5 * (1 - t)})`;
          g.beginPath();
          g.arc(Math.cos(a) * r, Math.sin(a) * r, 3 + t * 6, 0, Math.PI * 2);
          g.fill();
        }
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      radial(64, 64, 22, [[0, 0.8], [1, 0]]);
      break;
    case "implosion":
      g.translate(64, 64);
      for (let i = 0; i < 24; i++) {
        g.rotate((Math.PI * 2) / 24);
        const grad = g.createLinearGradient(0, 8, 0, 62);
        grad.addColorStop(0, "rgba(255,255,255,0.9)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grad;
        g.fillRect(-1.5, 8, 3, 54);
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      break;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  // Beams and trails repeat their texture along the length (TextureMode Wrap).
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  textures.set(preset, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// The real textures, when they can be had: Roblox's built-in particle textures from the local
// Studio install (served by the app from Studio's content folder) and rbxassetid images through
// Roblox's thumbnail service. Until (or unless) they load, the procedural stand-ins are shown;
// the texture object is updated in place, so materials pick the real one up by themselves.

const loaded = new Map<string, THREE.Texture>();
let realCount = 0;
const realListeners = new Set<() => void>();

/** How many real Roblox textures are in use (0 = only stand-ins). */
export function realTextureCount() {
  return realCount;
}
export function onRealTextures(fn: () => void): () => void {
  realListeners.add(fn);
  return () => realListeners.delete(fn);
}

function paint(tex: THREE.Texture, width: number, height: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  draw(c.getContext("2d")!);
  tex.image = c;
  tex.needsUpdate = true;
  realCount++;
  for (const fn of realListeners) fn();
}

export function textureFor(texture: string | undefined): THREE.Texture {
  const key = texture ?? "sparkle";
  const hit = loaded.get(key);
  if (hit) return hit;
  const preset = texturePreset(texture);
  // A copy of the stand-in, so the shared stand-in is never replaced.
  const base = particleTexture(preset);
  const tex = new THREE.CanvasTexture(base.image as HTMLCanvasElement);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  loaded.set(key, tex);
  if (typeof fetch === "undefined" || typeof document === "undefined") return tex;
  const url = textureUrl(texture);
  const asset = url.match(/^rbxassetid:\/\/(\d+)/)?.[1];
  const builtin = url.match(/^rbxasset:\/\/(textures\/[\w/.-]+\.dds)$/)?.[1];
  if (builtin) {
    void fetch(`/api/rbxasset/${builtin}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => {
        const img = decodeDds(buf);
        paint(tex, img.width, img.height, (g) => g.putImageData(new ImageData(img.data, img.width, img.height), 0, 0));
      })
      .catch(() => undefined);
  } else if (asset) {
    void fetch(`/api/thumb/${asset}`)
      .then((r) => (r.ok && r.headers.get("content-type")?.startsWith("image/") ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((blob) => createImageBitmap(blob))
      .then((bmp) => paint(tex, bmp.width, bmp.height, (g) => g.drawImage(bmp, 0, 0)))
      .catch(() => undefined);
  }
  return tex;
}

// ---------------------------------------------------------------------------
// Shaders

const QUAD_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iSize;
attribute float iRot;
attribute vec4 iColor;
attribute vec3 iAxis;
attribute float iFrame;
uniform int uMode;
uniform float uGrid;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec3 toCam = normalize(cameraPosition - iPos);
  vec3 right;
  vec3 up;
  if (uMode == 0) {
    right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  } else if (uMode == 1) {
    up = vec3(0.0, 1.0, 0.0);
    right = cross(up, toCam);
    right = length(right) < 1e-4 ? vec3(1.0, 0.0, 0.0) : normalize(right);
  } else if (uMode == 2) {
    up = iAxis;
    right = cross(up, toCam);
    right = length(right) < 1e-4 ? vec3(1.0, 0.0, 0.0) : normalize(right);
  } else {
    vec3 a = abs(iAxis.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    right = normalize(cross(iAxis, a));
    up = cross(right, iAxis);
  }
  float c = cos(iRot);
  float s = sin(iRot);
  vec2 corner = vec2(position.x * iSize.x, position.y * iSize.y);
  vec2 rc = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
  vec3 world = iPos + right * rc.x + up * rc.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  float f = mod(floor(iFrame), uGrid * uGrid);
  vec2 cell = vec2(mod(f, uGrid), uGrid - 1.0 - floor(f / uGrid));
  vUv = (uv + cell) / uGrid;
  vColor = iColor;
}`;

// Premultiplied output with alpha scaled by (1 - LightEmission): 0 = normal blending, 1 = additive.
const FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform float uEmission;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 t = texture2D(uTex, vUv);
  float a = t.a * vColor.a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(t.rgb * vColor.rgb * a, a * (1.0 - uEmission));
}`;

const STRIP_VERT = /* glsl */ `
attribute vec4 color4;
uniform float uScroll;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vUv = vec2(uv.x - uScroll, uv.y);
  vColor = color4;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

function blended(uniforms: Record<string, THREE.IUniform>, vertexShader: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}

let whiteTex: THREE.Texture | null = null;
function white(): THREE.Texture {
  if (whiteTex) return whiteTex;
  const d = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  d.needsUpdate = true;
  return (whiteTex = d);
}

// ---------------------------------------------------------------------------
// Emitters

type Rng = () => number;

interface Sim {
  update(dt: number, root: THREE.Matrix4, camera: THREE.Camera, time: number): void;
  burst(): void;
  count(): number;
  /** Grow box by what is on screen right now. */
  extend(box: THREE.Box3): void;
  /** Stop emitting (what is already out fades on its own). */
  stop(): void;
  /** Still emitting continuously (until stopped). */
  continuous(): boolean;
  objects: THREE.Object3D[];
  dispose(): void;
}

interface ParticleConfig {
  pos: THREE.Vector3;
  texture: string;
  color: ColorKey[];
  size: NumKey[];
  transparency: NumKey[];
  squash: NumKey[] | null;
  lifetime: [number, number];
  rate: number;
  burst: number;
  delay: number;
  speed: [number, number];
  spread: [number, number];
  dir: THREE.Vector3;
  accel: THREE.Vector3;
  drag: number;
  rotation: [number, number];
  spin: [number, number];
  emission: number;
  brightness: number;
  mode: number;
  locked: boolean;
  shape: "point" | "box" | "sphere" | "cylinder" | "disc";
  shapeSize: THREE.Vector3;
  surface: boolean;
  inward: boolean;
  grid: number;
  flipMode: "loop" | "once" | "pingpong" | "random";
  fps: number;
  timeScale: number;
  enabled: boolean;
}

const MODES = { camera: 0, cameraUp: 1, velocity: 2, velocityPerp: 3 } as const;

function particleConfig(e: VfxParticles): ParticleConfig {
  const spread = e.spread === undefined ? [0, 0] : typeof e.spread === "number" ? [e.spread, e.spread] : e.spread;
  return {
    pos: new THREE.Vector3(...((e.pos ?? [0, 0, 0]) as [number, number, number])),
    texture: e.texture ?? "sparkle",
    color: colorKeys(e.color, PARTICLE_DEFAULTS.color),
    size: numberKeys(e.size, PARTICLE_DEFAULTS.size),
    transparency: numberKeys(e.transparency, PARTICLE_DEFAULTS.transparency),
    squash: e.squash === undefined ? null : numberKeys(e.squash, 0),
    lifetime: rangeOf(e.lifetime, PARTICLE_DEFAULTS.lifetime),
    rate: e.rate ?? (e.burst !== undefined ? 0 : PARTICLE_DEFAULTS.rate),
    burst: e.burst ?? 0,
    delay: e.delay ?? 0,
    speed: rangeOf(e.speed, PARTICLE_DEFAULTS.speed),
    spread: [spread[0] * DEG, spread[1] * DEG],
    dir: new THREE.Vector3(...DIRECTIONS[e.direction ?? "up"]),
    accel: new THREE.Vector3(...((e.accel ?? [0, 0, 0]) as [number, number, number])),
    drag: e.drag ?? 0,
    rotation: rangeOf(e.rotation, PARTICLE_DEFAULTS.rotation),
    spin: rangeOf(e.spin, PARTICLE_DEFAULTS.spin),
    emission: e.lightEmission ?? 0,
    brightness: e.brightness ?? 1,
    mode: MODES[e.orientation ?? "camera"],
    locked: !!e.locked,
    shape: e.shape ?? "point",
    shapeSize: new THREE.Vector3(...((e.shapeSize ?? [2, 2, 2]) as [number, number, number])),
    surface: !!e.surface,
    inward: !!e.inward,
    grid: e.flipbook ? Number(e.flipbook.grid[0]) : 1,
    flipMode: e.flipbook?.mode ?? "loop",
    fps: e.flipbook?.fps ?? 30,
    timeScale: e.timeScale ?? 1,
    enabled: e.enabled !== false,
  };
}

/** Roblox's legacy Fire, Smoke and Sparkles, approximated with particle emitters. */
function legacyConfigs(spec: VfxSpec): { cfg: ParticleConfig; name: string }[] {
  const out: { cfg: ParticleConfig; name: string }[] = [];
  for (const e of spec.emitters) {
    if (e.type === "fire") {
      const size = e.size ?? FIRE_DEFAULTS.size;
      const heat = e.heat ?? FIRE_DEFAULTS.heat;
      out.push({
        name: e.name,
        cfg: particleConfig({
          name: e.name, type: "particles", pos: e.pos, texture: "fire", enabled: e.enabled,
          color: [e.color ?? FIRE_DEFAULTS.color, e.secondaryColor ?? FIRE_DEFAULTS.secondaryColor],
          size: [[0, size * 0.35], [0.4, size * 0.45], [1, size * 0.1]], transparency: [[0, 0.25], [0.7, 0.5], [1, 1]],
          lifetime: [0.4 + size * 0.06, 0.7 + size * 0.1], rate: 60, speed: [Math.abs(heat) * 0.6, Math.abs(heat) * 0.9],
          direction: heat >= 0 ? "up" : "down", spread: 12, rotation: [-30, 30], spin: [-40, 40], lightEmission: 1,
        }),
      });
    } else if (e.type === "smoke") {
      const size = e.size ?? SMOKE_DEFAULTS.size;
      const rise = e.riseVelocity ?? SMOKE_DEFAULTS.riseVelocity;
      out.push({
        name: e.name,
        cfg: particleConfig({
          name: e.name, type: "particles", pos: e.pos, texture: "smoke", enabled: e.enabled, color: e.color ?? SMOKE_DEFAULTS.color,
          size: [[0, size], [1, size * 3]], transparency: [[0, 1 - (e.opacity ?? SMOKE_DEFAULTS.opacity) * 0.8], [1, 1]],
          lifetime: [4, 6], rate: 12, speed: [Math.abs(rise), Math.abs(rise) * 1.5], direction: rise >= 0 ? "up" : "down", spread: 20,
          rotation: [0, 360], spin: [-15, 15],
        }),
      });
    } else if (e.type === "sparkles") {
      out.push({
        name: e.name,
        cfg: particleConfig({
          name: e.name, type: "particles", pos: e.pos, texture: "sparkle", enabled: e.enabled, color: e.color ?? SPARKLES_DEFAULT,
          size: [[0, 0.5], [1, 0.1]], transparency: [0, 1], lifetime: [0.6, 1.2], rate: 24, speed: [2, 4], spread: 180,
          spin: [-180, 180], lightEmission: 1,
        }),
      });
    }
  }
  return out;
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/** A unit vector within the spread cone around dir (spread in radians, x and y). */
function spreadDir(dir: THREE.Vector3, spread: [number, number], rng: Rng, out: THREE.Vector3): THREE.Vector3 {
  out.copy(dir);
  if (!spread[0] && !spread[1]) return out;
  const a = (rng() * 2 - 1) * spread[0];
  const b = (rng() * 2 - 1) * spread[1];
  const p1 = tmpV2.set(1, 0, 0);
  if (Math.abs(dir.x) > 0.9) p1.set(0, 0, 1);
  const p2 = new THREE.Vector3().crossVectors(dir, p1).normalize();
  p1.crossVectors(p2, dir).normalize();
  out.applyAxisAngle(p2, a).applyAxisAngle(p1, b);
  return out.normalize();
}

function particleSim(cfg: ParticleConfig, rng: Rng): Sim {
  const maxLife = cfg.lifetime[1] / Math.max(0.05, cfg.timeScale);
  const cap = Math.max(8, Math.min(4000, Math.ceil(cfg.rate * maxLife * 1.15) + cfg.burst + 8));
  // State
  const pos = new Float32Array(cap * 3);
  const vel = new Float32Array(cap * 3);
  const age = new Float32Array(cap);
  const life = new Float32Array(cap);
  const rot = new Float32Array(cap);
  const spin = new Float32Array(cap);
  const env = new Float32Array(cap * 2);
  const frame0 = new Float32Array(cap);
  let n = 0;
  // GPU
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index;
  geo.setAttribute("position", quad.getAttribute("position"));
  geo.setAttribute("uv", quad.getAttribute("uv"));
  const attr = (name: string, size: number) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    return a;
  };
  const aPos = attr("iPos", 3), aSize = attr("iSize", 2), aRot = attr("iRot", 1), aColor = attr("iColor", 4), aAxis = attr("iAxis", 3), aFrame = attr("iFrame", 1);
  geo.instanceCount = 0;
  const mat = blended({ uTex: { value: textureFor(cfg.texture) }, uEmission: { value: cfg.emission }, uMode: { value: cfg.mode }, uGrid: { value: cfg.grid } }, QUAD_VERT);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = cfg.emission >= 0.5 ? 2 : 1;

  let carry = 0;
  let bursts: number[] = [];
  let stopped = false;
  const origin = new THREE.Vector3();
  const rootRot = new THREE.Quaternion();
  const spawnDir = new THREE.Vector3();

  const spawn = (rootM: THREE.Matrix4) => {
    if (n >= cap) return;
    const i = n++;
    rootRot.setFromRotationMatrix(rootM);
    // Shape sampling in emitter space (y = emission axis for cylinder and disc).
    const local = tmpV.set(0, 0, 0);
    let dir = spreadDir(cfg.dir, cfg.spread, rng, spawnDir);
    if (cfg.shape !== "point") {
      const s = cfg.shapeSize;
      if (cfg.shape === "box") {
        local.set((rng() - 0.5) * s.x, (rng() - 0.5) * s.y, (rng() - 0.5) * s.z);
        if (cfg.surface) {
          const axis = Math.floor(rng() * 3);
          local.setComponent(axis, (rng() < 0.5 ? -0.5 : 0.5) * s.getComponent(axis));
        }
      } else if (cfg.shape === "sphere") {
        const d = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();
        const r = cfg.surface ? 1 : Math.cbrt(rng());
        local.set(d.x * r * s.x / 2, d.y * r * s.y / 2, d.z * r * s.z / 2);
        dir = spawnDir.copy(d).multiplyScalar(cfg.inward ? -1 : 1);
      } else {
        // Cylinder and disc: around the emission axis.
        tmpQ.setFromUnitVectors(UP, cfg.dir);
        const a = rng() * Math.PI * 2;
        const r = cfg.surface ? 1 : Math.sqrt(rng());
        const rx = cfg.dir.x !== 0 ? s.y : s.x, rz = cfg.dir.z !== 0 ? s.y : s.z;
        const h = cfg.dir.x !== 0 ? s.x : cfg.dir.z !== 0 ? s.z : s.y;
        local.set(Math.cos(a) * r * rx / 2, cfg.shape === "cylinder" ? (rng() - 0.5) * h : 0, Math.sin(a) * r * rz / 2).applyQuaternion(tmpQ);
        if (cfg.shape === "cylinder") {
          dir = spawnDir.set(Math.cos(a), 0, Math.sin(a)).applyQuaternion(tmpQ).multiplyScalar(cfg.inward ? -1 : 1);
        } else if (cfg.inward) dir = spawnDir.copy(cfg.dir).negate();
      }
    }
    local.add(cfg.pos);
    const speed = cfg.speed[0] + rng() * (cfg.speed[1] - cfg.speed[0]);
    const v = dir.clone().multiplyScalar(speed);
    if (cfg.locked) {
      pos.set([local.x, local.y, local.z], i * 3);
      vel.set([v.x, v.y, v.z], i * 3);
    } else {
      local.applyMatrix4(rootM);
      v.applyQuaternion(rootRot);
      pos.set([local.x, local.y, local.z], i * 3);
      vel.set([v.x, v.y, v.z], i * 3);
    }
    age[i] = 0;
    life[i] = cfg.lifetime[0] + rng() * (cfg.lifetime[1] - cfg.lifetime[0]);
    rot[i] = (cfg.rotation[0] + rng() * (cfg.rotation[1] - cfg.rotation[0])) * DEG;
    spin[i] = (cfg.spin[0] + rng() * (cfg.spin[1] - cfg.spin[0])) * DEG;
    env[i * 2] = rng() * 2 - 1;
    env[i * 2 + 1] = rng() * 2 - 1;
    frame0[i] = cfg.flipMode === "random" ? Math.floor(rng() * cfg.grid * cfg.grid) : 0;
  };

  const kill = (i: number) => {
    const last = --n;
    if (i === last) return;
    pos.copyWithin(i * 3, last * 3, last * 3 + 3);
    vel.copyWithin(i * 3, last * 3, last * 3 + 3);
    age[i] = age[last];
    life[i] = life[last];
    rot[i] = rot[last];
    spin[i] = spin[last];
    env[i * 2] = env[last * 2];
    env[i * 2 + 1] = env[last * 2 + 1];
    frame0[i] = frame0[last];
  };

  const rgb: [number, number, number] = [0, 0, 0];
  let order: number[] = [];
  return {
    objects: [mesh],
    count: () => n,
    extend(box) {
      const p = new THREE.Vector3();
      for (let k = 0; k < geo.instanceCount; k++) {
        p.set(aPos.getX(k), aPos.getY(k), aPos.getZ(k));
        const r = Math.max(aSize.getX(k), aSize.getY(k)) / 2;
        box.expandByPoint(tmpV2.copy(p).addScalar(r));
        box.expandByPoint(tmpV2.copy(p).subScalar(r));
      }
    },
    burst: () => {
      if (cfg.burst > 0 && cfg.enabled && !stopped) bursts.push(cfg.delay);
    },
    stop: () => {
      stopped = true;
      bursts = [];
    },
    continuous: () => !stopped && cfg.enabled && cfg.rate > 0,
    update(dtRaw, rootM, camera) {
      const dt = dtRaw * cfg.timeScale;
      // Emit
      if (cfg.enabled && !stopped && cfg.rate > 0) {
        carry += cfg.rate * dt;
        while (carry >= 1) {
          spawn(rootM);
          carry -= 1;
        }
      }
      if (bursts.length) {
        bursts = bursts.map((t) => t - dtRaw);
        for (const t of bursts) if (t <= 0) for (let k = 0; k < cfg.burst; k++) spawn(rootM);
        bursts = bursts.filter((t) => t > 0);
      }
      // Simulate
      const dragK = cfg.drag > 0 ? Math.pow(0.5, cfg.drag * dt) : 1;
      for (let i = n - 1; i >= 0; i--) {
        age[i] += dt;
        if (age[i] >= life[i]) {
          kill(i);
          continue;
        }
        const j = i * 3;
        vel[j] = (vel[j] + cfg.accel.x * dt) * dragK;
        vel[j + 1] = (vel[j + 1] + cfg.accel.y * dt) * dragK;
        vel[j + 2] = (vel[j + 2] + cfg.accel.z * dt) * dragK;
        pos[j] += vel[j] * dt;
        pos[j + 1] += vel[j + 1] * dt;
        pos[j + 2] += vel[j + 2] * dt;
        rot[i] += spin[i] * dt;
      }
      // Draw order: back to front unless the emitter is additive.
      if (order.length !== n) order = Array.from({ length: n }, (_, i) => i);
      else for (let i = 0; i < n; i++) order[i] = i;
      const world = new THREE.Vector3();
      const cam = camera.position;
      const worldOf = (i: number, out: THREE.Vector3) => {
        out.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        if (cfg.locked) out.applyMatrix4(rootM);
        return out;
      };
      if (cfg.emission < 0.5 && n > 1) {
        const d = new Float32Array(n);
        for (let i = 0; i < n; i++) d[i] = worldOf(i, world).distanceToSquared(cam);
        order.sort((a, b) => d[b] - d[a]);
      }
      for (let k = 0; k < n; k++) {
        const i = order[k];
        const t = age[i] / life[i];
        worldOf(i, world);
        aPos.setXYZ(k, world.x, world.y, world.z);
        let size = Math.max(0, sampleNumber(cfg.size, t) + env[i * 2] * sampleEnvelope(cfg.size, t));
        let w = size, h = size;
        if (cfg.squash) {
          const sq = sampleNumber(cfg.squash, t);
          h = size * (1 + Math.max(-0.9, sq));
          w = size / (1 + Math.max(-0.9, sq));
        }
        aSize.setXY(k, w, h);
        aRot.setX(k, rot[i]);
        const tr = Math.min(1, Math.max(0, sampleNumber(cfg.transparency, t) + env[i * 2 + 1] * sampleEnvelope(cfg.transparency, t)));
        sampleColor(cfg.color, t, rgb);
        const b = cfg.brightness;
        aColor.setXYZW(k, (rgb[0] / 255) * b, (rgb[1] / 255) * b, (rgb[2] / 255) * b, 1 - tr);
        const vx = vel[i * 3], vy = vel[i * 3 + 1], vz = vel[i * 3 + 2];
        const len = Math.hypot(vx, vy, vz);
        if (len > 1e-4) aAxis.setXYZ(k, vx / len, vy / len, vz / len);
        else aAxis.setXYZ(k, cfg.dir.x, cfg.dir.y, cfg.dir.z);
        let frame = frame0[i];
        if (cfg.grid > 1 && cfg.flipMode !== "random") {
          const total = cfg.grid * cfg.grid;
          const f = cfg.flipMode === "once" ? Math.min(total - 1, t * total) : age[i] * cfg.fps;
          frame = cfg.flipMode === "pingpong" ? total - 1 - Math.abs((f % (2 * total - 2)) - (total - 1)) : f;
        }
        aFrame.setX(k, frame);
      }
      geo.instanceCount = n;
      for (const a of [aPos, aSize, aRot, aColor, aAxis, aFrame]) {
        a.needsUpdate = true;
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * a.itemSize);
      }
    },
    dispose() {
      geo.dispose();
      quad.dispose();
      mat.dispose();
    },
  };
}

function sampleEnvelope(keys: NumKey[], t: number): number {
  if (keys.every((k) => !k.e)) return 0;
  return sampleNumber(keys.map((k) => ({ t: k.t, v: k.e, e: 0 })), t);
}

// ---------------------------------------------------------------------------
// Beams and trails: camera-facing strips with color and transparency along their length.

function stripMaterial(texture: string | undefined, emission: number): THREE.ShaderMaterial {
  return blended({
    uTex: { value: texture ? textureFor(texture) : white() },
    uEmission: { value: emission },
    uScroll: { value: 0 },
  }, STRIP_VERT);
}

function stripGeometry(segments: number) {
  const geo = new THREE.BufferGeometry();
  const verts = (segments + 1) * 2;
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(verts * 2), 2).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color4", new THREE.BufferAttribute(new Float32Array(verts * 4), 4).setUsage(THREE.DynamicDrawUsage));
  const idx: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  geo.setIndex(idx);
  return geo;
}

function beamSim(e: VfxBeam): Sim {
  const segs = Math.max(1, Math.min(200, e.segments ?? (e.curve ? 20 : 10)));
  const geo = stripGeometry(segs);
  const mat = stripMaterial(e.texture, e.lightEmission ?? 0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  const color = colorKeys(e.color);
  const transparency = numberKeys(e.transparency, 0);
  const width = e.width === undefined ? [1, 1] : typeof e.width === "number" ? [e.width, e.width] : e.width;
  const from = new THREE.Vector3(...(e.from as [number, number, number]));
  const to = new THREE.Vector3(...(e.to as [number, number, number]));
  const curve = e.curve ?? [0, 0];
  const len = from.distanceTo(to);
  const rgb: [number, number, number] = [0, 0, 0];
  let scroll = 0;
  const brightness = e.brightness ?? 1;
  // After stop() the beam fades out over 0.2 s.
  let fade = 1;
  let stopped = false;
  return {
    objects: [mesh],
    count: () => (stopped && fade > 0 ? 1 : 0),
    burst: () => undefined,
    stop: () => {
      stopped = true;
    },
    continuous: () => !stopped && e.enabled !== false,
    extend(box) {
      geo.computeBoundingBox();
      if (geo.boundingBox && mesh.visible) box.union(geo.boundingBox);
    },
    update(dt, rootM, camera) {
      if (stopped) fade = Math.max(0, fade - dt / 0.2);
      mesh.visible = e.enabled !== false && fade > 0;
      const p0 = from.clone().applyMatrix4(rootM), p3 = to.clone().applyMatrix4(rootM);
      // Attachments point their X axis up: curves bend along the root's up axis.
      const up = new THREE.Vector3(0, 1, 0).transformDirection(rootM);
      const p1 = p0.clone().addScaledVector(up, curve[0]);
      const p2 = p3.clone().addScaledVector(up, -curve[1]);
      const bez = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
      const pa = geo.getAttribute("position") as THREE.BufferAttribute;
      const ua = geo.getAttribute("uv") as THREE.BufferAttribute;
      const ca = geo.getAttribute("color4") as THREE.BufferAttribute;
      const texLen = e.textureLength ?? 1;
      const mode = e.textureMode ?? "stretch";
      scroll += dt * (e.textureSpeed ?? 1) * (mode === "static" ? 0 : 1);
      (mat.uniforms.uScroll as THREE.IUniform).value = mode === "wrap" ? scroll / texLen : scroll;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const p = bez.getPoint(t);
        const tan = bez.getTangent(t);
        const side = e.faceCamera === false ? new THREE.Vector3().crossVectors(tan, up) : new THREE.Vector3().crossVectors(tan, tmpV.copy(camera.position).sub(p));
        if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
        side.normalize().multiplyScalar((width[0] + (width[1] - width[0]) * t) / 2);
        pa.setXYZ(i * 2, p.x + side.x, p.y + side.y, p.z + side.z);
        pa.setXYZ(i * 2 + 1, p.x - side.x, p.y - side.y, p.z - side.z);
        const u = mode === "wrap" ? (t * len) / texLen : t;
        ua.setXY(i * 2, u, 1);
        ua.setXY(i * 2 + 1, u, 0);
        sampleColor(color, t, rgb);
        const a = (1 - Math.min(1, Math.max(0, sampleNumber(transparency, t)))) * fade;
        for (const k of [i * 2, i * 2 + 1]) ca.setXYZW(k, (rgb[0] / 255) * brightness, (rgb[1] / 255) * brightness, (rgb[2] / 255) * brightness, a);
      }
      pa.needsUpdate = ua.needsUpdate = ca.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

// Mesh effects: a sphere, upright cylinder or block that grows, fades, changes colour and spins.
const sphereGeo = new THREE.SphereGeometry(0.5, 40, 24);
const cylinderGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 1);
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const ringGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

function meshSim(e: VfxMesh): Sim {
  const ring = e.shape === "ring";
  const geo = ring ? ringGeo : e.shape === "cylinder" ? cylinderGeo : e.shape === "block" ? boxGeo : sphereGeo;
  const kind = e.material ?? "neon";
  // Rings are the shockwave ring texture on a flat quad (a Decal on a thin part in Studio).
  const mat: THREE.Material = ring
    ? markGlow(new THREE.MeshBasicMaterial({ map: textureFor("ring"), transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }))
    : kind === "glass"
      ? new THREE.MeshPhysicalMaterial({ roughness: 0.05, transparent: true, depthWrite: false })
      : markGlow(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: kind === "forcefield" ? THREE.DoubleSide : THREE.FrontSide, blending: kind === "forcefield" ? THREE.AdditiveBlending : THREE.NormalBlending }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;
  const from = meshSize(e.size), to = meshSize(e.to ?? e.size);
  const tKeys = numberKeys(e.transparency ?? [0, 1], 0);
  const cKeys = colorKeys(e.color, "#ffffff");
  const life = e.life ?? MESH_DEFAULT_LIFE;
  const base = new THREE.Matrix4().makeTranslation(...((e.pos ?? [0, 0, 0]) as Vec3)).multiply(
    new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(((e.rot?.[0] ?? 0) * Math.PI) / 180, ((e.rot?.[1] ?? 0) * Math.PI) / 180, ((e.rot?.[2] ?? 0) * Math.PI) / 180, "XYZ")),
  );
  const ease = (f: number) => (e.ease === "linear" ? f : e.ease === "in" ? f * f * f : e.ease === "inOut" ? (f < 0.5 ? 4 * f * f * f : 1 - (2 - 2 * f) ** 3 / 2) : 1 - (1 - f) ** 3);
  const rgb: RGB = [0, 0, 0];
  // Loops run from the start; one-shots run when burst. -1: not playing.
  let started = e.loop ? 0 : -1;
  let clock = 0;
  let fadeOut = 1;
  let stopped = false;
  const m = new THREE.Matrix4();
  return {
    objects: [mesh],
    update(dt, root) {
      clock += dt;
      if (stopped) fadeOut = Math.max(0, fadeOut - dt / 0.25);
      const age = started < 0 ? -1 : clock - started - (e.delay ?? 0);
      if (age < 0 || (!e.loop && age >= life) || fadeOut <= 0 || e.enabled === false) {
        mesh.visible = false;
        return;
      }
      let f = (age % life) / life;
      if (e.pulse) f = 1 - Math.abs(1 - 2 * f);
      const k = ease(f);
      const sx = from[0] + (to[0] - from[0]) * k, sy = from[1] + (to[1] - from[1]) * k, sz = from[2] + (to[2] - from[2]) * k;
      const spin = e.spin
        ? new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler((e.spin[0] * age * Math.PI) / 180, (e.spin[1] * age * Math.PI) / 180, (e.spin[2] * age * Math.PI) / 180, "XYZ"))
        : null;
      m.copy(root).multiply(base);
      if (spin) m.multiply(spin);
      m.multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
      mesh.matrix.copy(m);
      mesh.matrixWorldNeedsUpdate = true;
      sampleColor(cKeys, f, rgb);
      // Neon glows: its colour is pushed past white so the glow pass picks it up.
      const boost = ring ? 1.4 : kind === "neon" ? 1.6 : kind === "forcefield" ? 0.9 : 1;
      (mat as THREE.MeshBasicMaterial).color.setRGB((rgb[0] / 255) * boost, (rgb[1] / 255) * boost, (rgb[2] / 255) * boost, THREE.SRGBColorSpace);
      const shown = (1 - sampleNumber(tKeys, f)) * fadeOut;
      mat.opacity = ring ? shown : kind === "forcefield" ? shown * 0.45 : kind === "glass" ? shown * 0.5 : shown;
      mesh.visible = mat.opacity > 0.003;
    },
    burst() {
      if (!e.loop) started = clock;
    },
    count: () => (mesh.visible ? 1 : 0),
    extend(box) {
      if (!mesh.visible) return;
      mesh.updateMatrixWorld(true);
      box.union(new THREE.Box3().setFromObject(mesh));
    },
    stop() {
      stopped = true;
    },
    continuous: () => !!e.loop && !stopped,
    dispose() {
      mat.dispose();
    },
  };
}

function trailSim(e: VfxTrail): Sim {
  const MAX = 160;
  const geo = stripGeometry(MAX - 1);
  const mat = stripMaterial(e.texture, e.lightEmission ?? 0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  const color = colorKeys(e.color);
  const transparency = numberKeys(e.transparency, 0);
  const widthScale = e.widthScale === undefined ? null : numberKeys(e.widthScale, 1);
  const lifetime = e.lifetime ?? 0.5;
  const a0 = new THREE.Vector3(...(e.from as [number, number, number]));
  const a1 = new THREE.Vector3(...(e.to as [number, number, number]));
  const samples: { a: THREE.Vector3; b: THREE.Vector3; t: number }[] = [];
  let clock = 0;
  let stopped = false;
  const rgb: [number, number, number] = [0, 0, 0];
  const brightness = e.brightness ?? 1;
  return {
    objects: [mesh],
    count: () => samples.length,
    burst: () => undefined,
    stop: () => {
      stopped = true;
    },
    continuous: () => !stopped && e.enabled !== false,
    extend(box) {
      for (const smp of samples) box.expandByPoint(smp.a).expandByPoint(smp.b);
    },
    update(dt, rootM) {
      clock += dt;
      if (e.enabled !== false && !stopped) {
        samples.unshift({ a: a0.clone().applyMatrix4(rootM), b: a1.clone().applyMatrix4(rootM), t: clock });
        if (samples.length > MAX) samples.length = MAX;
      }
      while (samples.length && clock - samples[samples.length - 1].t > lifetime) samples.pop();
      const pa = geo.getAttribute("position") as THREE.BufferAttribute;
      const ua = geo.getAttribute("uv") as THREE.BufferAttribute;
      const ca = geo.getAttribute("color4") as THREE.BufferAttribute;
      const n = samples.length;
      for (let i = 0; i < MAX; i++) {
        const s = samples[Math.min(i, n - 1)];
        if (!s) {
          pa.setXYZ(i * 2, 0, 0, 0);
          pa.setXYZ(i * 2 + 1, 0, 0, 0);
          continue;
        }
        const life = Math.min(1, (clock - s.t) / lifetime);
        let pa0 = s.a, pa1 = s.b;
        if (widthScale) {
          const k = sampleNumber(widthScale, life);
          const mid = tmpV.copy(s.a).add(s.b).multiplyScalar(0.5);
          pa0 = mid.clone().lerp(s.a, k);
          pa1 = mid.clone().lerp(s.b, k);
        }
        pa.setXYZ(i * 2, pa0.x, pa0.y, pa0.z);
        pa.setXYZ(i * 2 + 1, pa1.x, pa1.y, pa1.z);
        ua.setXY(i * 2, life, 1);
        ua.setXY(i * 2 + 1, life, 0);
        sampleColor(color, life, rgb);
        const a = i >= n ? 0 : 1 - Math.min(1, Math.max(0, sampleNumber(transparency, life)));
        for (const k of [i * 2, i * 2 + 1]) ca.setXYZW(k, (rgb[0] / 255) * brightness, (rgb[1] / 255) * brightness, (rgb[2] / 255) * brightness, a);
      }
      geo.setDrawRange(0, Math.max(0, (n - 1) * 6));
      pa.needsUpdate = ua.needsUpdate = ca.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

// ---------------------------------------------------------------------------

export interface VfxRuntime {
  object: THREE.Group;
  update(dt: number, camera: THREE.Camera): void;
  /** Fire one-shot bursts again. */
  burst(): void;
  /** Run the simulation ahead (fills continuous emitters before the first frame). */
  warm(seconds: number, camera: THREE.Camera): void;
  particles(): number;
  /** What the effect covers right now (particles, beams, trails, lights). */
  bounds(): THREE.Box3;
  /** With `external`: where the effect's root is (world transform). */
  setRoot(m: THREE.Matrix4): void;
  /** Stop emitting; particles already out live on, lights and beams fade. */
  stop(): void;
  /** Anything left to show (false once stopped and everything has faded, or a one-shot is over). */
  alive(): boolean;
  dispose(): void;
}

export interface VfxOptions {
  /** The caller places the root each frame with setRoot (abilities); no preview motion, no auto burst. */
  external?: boolean;
}

/** Seeded random numbers (stable thumbnails). */
export function mulberry(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createVfx(spec: VfxSpec, rng: Rng = Math.random, opts: VfxOptions = {}): VfxRuntime {
  const object = new THREE.Group();
  const sims: Sim[] = [];
  const lights: { light: THREE.Light; pos: THREE.Vector3; dir: THREE.Vector3; intensity: number }[] = [];
  for (const e of spec.emitters) {
    if (e.type === "particles") sims.push(particleSim(particleConfig(e), rng));
    else if (e.type === "beam") sims.push(beamSim(e));
    else if (e.type === "trail") sims.push(trailSim(e));
    else if (e.type === "mesh") sims.push(meshSim(e));
    else if (e.type === "light" && e.enabled !== false) {
      const color = new THREE.Color(e.color ?? "#ffffff");
      const range = e.range ?? 8;
      const light = e.kind === "spot"
        ? new THREE.SpotLight(color, (e.brightness ?? 1) * 6, range * 1.4, ((e.angle ?? 90) * DEG) / 2, 0.4, 1)
        : new THREE.PointLight(color, (e.brightness ?? 1) * 6, range * 1.4, 1);
      if (light instanceof THREE.SpotLight) object.add(light.target);
      lights.push({
        light,
        pos: new THREE.Vector3(...((e.pos ?? [0, 0, 0]) as [number, number, number])),
        dir: new THREE.Vector3(...DIRECTIONS[e.face ?? "down"]),
        intensity: light.intensity,
      });
      object.add(light);
    }
  }
  for (const { cfg } of legacyConfigs(spec)) sims.push(particleSim(cfg, rng));
  for (const s of sims) for (const o of s.objects) object.add(o);

  const motion = opts.external ? "none" : previewMotion(spec);
  let time = 0;
  let stopped = false;
  let lightFade = 1;
  const rootM = new THREE.Matrix4();
  const place = () => {
    if (opts.external) return;
    if (motion === "orbit") rootM.makeTranslation(Math.cos(time * 2.4) * 4, 0, Math.sin(time * 2.4) * 4);
    else if (motion === "line") rootM.makeTranslation(Math.sin(time * 1.6) * 8, 0, 0);
    else if (motion === "swing") {
      // A sword-like swing around the hilt: fast arcs with a short pause between them.
      const cycle = (time % 1.6) / 1.6;
      const k = cycle < 0.35 ? cycle / 0.35 : cycle < 0.5 ? 1 : cycle < 0.85 ? 1 - (cycle - 0.5) / 0.35 : 0;
      const eased = k * k * (3 - 2 * k);
      rootM.makeRotationZ((-70 + eased * 140) * DEG).premultiply(new THREE.Matrix4().makeTranslation(0, 1, 0));
    } else rootM.identity();
  };
  const step = (dt: number, camera: THREE.Camera) => {
    time += dt;
    place();
    for (const s of sims) s.update(dt, rootM, camera, time);
    if (stopped) lightFade = Math.max(0, lightFade - dt / 0.25);
    for (const l of lights) {
      l.light.intensity = l.intensity * lightFade;
      l.light.position.copy(l.pos).applyMatrix4(rootM);
      if (l.light instanceof THREE.SpotLight) l.light.target.position.copy(l.light.position).addScaledVector(tmpV.copy(l.dir).transformDirection(rootM), 10);
    }
  };
  const runtime: VfxRuntime = {
    object,
    update: (dt, camera) => step(Math.min(0.1, dt), camera),
    burst: () => sims.forEach((s) => s.burst()),
    warm(seconds, camera) {
      for (let t = 0; t < seconds; t += 1 / 30) step(1 / 30, camera);
    },
    particles: () => sims.reduce((n, s) => n + s.count(), 0),
    bounds() {
      const box = new THREE.Box3();
      for (const s of sims) s.extend(box);
      for (const l of lights) box.expandByPoint(l.light.position);
      return box;
    },
    setRoot(m) {
      rootM.copy(m);
    },
    stop() {
      stopped = true;
      for (const s of sims) s.stop();
    },
    alive() {
      if (sims.some((s) => s.count() > 0 || s.continuous())) return true;
      // Lights shine until the effect is stopped, then fade.
      return lights.length > 0 && (!stopped || lightFade > 0);
    },
    dispose() {
      for (const s of sims) s.dispose();
      for (const l of lights) l.light.dispose();
    },
  };
  if (!opts.external) runtime.burst();
  return runtime;
}

/**
 * Where to point the camera: the effect is simulated briefly (seeded, off screen) and framed by
 * what it actually covers, ignoring the few particles that fly furthest.
 */
export function vfxExtent(spec: VfxSpec): { center: THREE.Vector3; radius: number } {
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, 6, -20);
  const rt = createVfx(spec, mulberry(11));
  const box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
  try {
    const oneShot = isOneShot(spec);
    const steps = oneShot ? 12 : 60;
    for (let i = 0; i < steps; i++) {
      rt.update(1 / 30, cam);
      if (i % 6 === 5) box.union(rt.bounds());
    }
  } finally {
    rt.dispose();
  }
  box.min.y = Math.max(-1, box.min.y);
  const size = box.getSize(new THREE.Vector3());
  // Keep the ground in view and the framing compact.
  const center = box.getCenter(new THREE.Vector3());
  center.y = Math.max(center.y, size.y * 0.35);
  return { center, radius: Math.min(30, Math.max(3, size.length() / 2)) };
}
