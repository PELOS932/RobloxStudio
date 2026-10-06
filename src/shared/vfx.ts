// Visual effects: Roblox ParticleEmitters, Beams, Trails, Fire, Smoke, Sparkles and lights,
// grouped into one effect that previews live in the browser and imports into Studio.
//
// Coordinates are studs relative to the effect's root (y = up, the root sits on the ground at
// its center). Sequences follow Roblox: a number/color is constant, a pair goes from the first
// to the second over the lifetime, and a list of [time 0..1, value(, envelope)] keypoints is used
// as is. Ranges ([min, max]) pick a random value per particle.

import { z } from "zod";
import { eulerXYZDeg, hexToRgb, mul } from "./math.ts";
import type { Mat3, RGB, Vec3 } from "./math.ts";
import type { ColorKey, InstNode, NumKey, PropValue } from "./instance-tree.ts";

/** Built-in particle textures that ship with Roblox (rbxasset://textures/particles/…). */
export const VFX_TEXTURES = {
  sparkle: "rbxasset://textures/particles/sparkles_main.dds",
  spark: "rbxasset://textures/particles/fire_sparks_main.dds",
  fire: "rbxasset://textures/particles/fire_main.dds",
  smoke: "rbxasset://textures/particles/smoke_main.dds",
  glow: "rbxasset://textures/particles/forcefield_glow_main.dds",
  vortex: "rbxasset://textures/particles/forcefield_vortex_main.dds",
  ring: "rbxasset://textures/particles/explosion01_shockwave_main.dds",
  core: "rbxasset://textures/particles/explosion01_core_main.dds",
  puff: "rbxasset://textures/particles/explosion01_smoke_main.dds",
  implosion: "rbxasset://textures/particles/explosion01_implosion_main.dds",
} as const;
export type TexturePreset = keyof typeof VFX_TEXTURES;
export const TEXTURE_PRESETS = Object.keys(VFX_TEXTURES) as TexturePreset[];

const vec3 = z.array(z.number()).length(3);
const range = z.union([z.number(), z.array(z.number()).length(2)]);
const hex = z.string().regex(/^#?[0-9a-fA-F]{6}$/);
/** number, [from, to], or [[t, value, envelope?], …] */
export const NumberSeqSchema = z.union([
  z.number(),
  z.array(z.number()).length(2),
  z.array(z.array(z.number()).min(2).max(3)).min(2).max(20),
]);
/** "#hex", ["#from", "#to"], or [[t, "#hex"], …] */
export const ColorSeqSchema = z.union([
  hex,
  z.array(hex).min(2).max(2),
  z.array(z.tuple([z.number(), hex])).min(2).max(20),
]);
const texture = z.string().max(200).describe(`${TEXTURE_PRESETS.join("|")} or rbxassetid://…`);

/** Ready-made particle emitters (see PARTICLE_PRESETS); fields given next to a preset override it. */
export const PARTICLE_PRESET_NAMES = [
  "flames", "embers", "smoke", "sparks", "flash", "shockwave", "fireball", "puff", "dust", "glow", "motes", "aura", "rise", "snow", "vortex", "electric",
] as const;
export type ParticlePreset = (typeof PARTICLE_PRESET_NAMES)[number];

const common = {
  name: z.string().min(1).max(60),
  pos: vec3.optional().describe("offset from the root, studs"),
  enabled: z.boolean().optional(),
};

export const ParticlesSchema = z.object({
  ...common,
  type: z.literal("particles"),
  preset: z.enum(PARTICLE_PRESET_NAMES).optional().describe("start from a ready-made emitter; other fields override it"),
  texture: texture.optional(),
  color: ColorSeqSchema.optional(),
  size: NumberSeqSchema.optional().describe("studs"),
  transparency: NumberSeqSchema.optional().describe("0 opaque .. 1 invisible"),
  lifetime: range.optional().describe("seconds"),
  rate: z.number().min(0).max(2000).optional().describe("particles per second; 0 with burst for one-shots"),
  burst: z.number().int().min(1).max(1000).optional().describe("one-shot: emit this many at once when played"),
  delay: z.number().min(0).max(30).optional().describe("one-shot delay, seconds"),
  speed: range.optional().describe("studs/s"),
  spread: z.union([z.number(), z.array(z.number()).length(2)]).optional().describe("degrees, or [x, y]"),
  direction: z.enum(["up", "down", "left", "right", "front", "back"]).optional().describe("emission direction, default up"),
  accel: vec3.optional().describe("studs/s², e.g. [0,-20,0] gravity"),
  drag: z.number().min(0).max(50).optional(),
  rotation: range.optional().describe("degrees"),
  spin: range.optional().describe("degrees/s"),
  lightEmission: z.number().min(0).max(1).optional().describe("1 = additive glow"),
  lightInfluence: z.number().min(0).max(1).optional(),
  brightness: z.number().min(0).max(100).optional(),
  squash: NumberSeqSchema.optional().describe("-3..3, stretches along velocity"),
  zOffset: z.number().optional(),
  orientation: z.enum(["camera", "cameraUp", "velocity", "velocityPerp"]).optional(),
  locked: z.boolean().optional().describe("particles follow the emitter"),
  shape: z.enum(["point", "box", "sphere", "cylinder", "disc"]).optional().describe("emit from a volume (default point)"),
  shapeSize: vec3.optional().describe("size of the emitting volume, studs"),
  surface: z.boolean().optional().describe("emit from the shape's surface only"),
  inward: z.boolean().optional().describe("shapes: emit inward instead of outward"),
  flipbook: z
    .object({ grid: z.enum(["2x2", "4x4", "8x8"]), mode: z.enum(["loop", "once", "pingpong", "random"]).optional(), fps: z.number().min(1).max(60).optional() })
    .optional(),
  timeScale: z.number().min(0).max(1).optional(),
});

export const BeamSchema = z.object({
  ...common,
  type: z.literal("beam"),
  from: vec3,
  to: vec3,
  texture: texture.optional(),
  color: ColorSeqSchema.optional(),
  transparency: NumberSeqSchema.optional(),
  width: z.union([z.number(), z.array(z.number()).length(2)]).optional().describe("studs, or [start, end]"),
  curve: z.array(z.number()).length(2).optional().describe("CurveSize0/1, studs"),
  segments: z.number().int().min(1).max(1000).optional(),
  textureLength: z.number().min(0.01).max(100).optional(),
  textureSpeed: z.number().min(-100).max(100).optional(),
  textureMode: z.enum(["stretch", "wrap", "static"]).optional(),
  faceCamera: z.boolean().optional(),
  lightEmission: z.number().min(0).max(1).optional(),
  brightness: z.number().min(0).max(100).optional(),
});

export const TrailSchema = z.object({
  ...common,
  type: z.literal("trail"),
  from: vec3.describe("first attachment offset (e.g. sword hilt)"),
  to: vec3.describe("second attachment offset (e.g. blade tip)"),
  texture: texture.optional(),
  color: ColorSeqSchema.optional(),
  transparency: NumberSeqSchema.optional(),
  lifetime: z.number().min(0.01).max(20).optional(),
  widthScale: NumberSeqSchema.optional(),
  minLength: z.number().min(0).optional(),
  faceCamera: z.boolean().optional(),
  lightEmission: z.number().min(0).max(1).optional(),
  brightness: z.number().min(0).max(100).optional(),
});

export const LightSchema = z.object({
  ...common,
  type: z.literal("light"),
  kind: z.enum(["point", "spot"]).optional(),
  color: hex.optional(),
  brightness: z.number().min(0).max(40).optional(),
  range: z.number().min(0).max(60).optional(),
  angle: z.number().min(0).max(180).optional().describe("spot only"),
  face: z.enum(["up", "down", "left", "right", "front", "back"]).optional().describe("spot only, default down"),
  shadows: z.boolean().optional(),
});

export const FireSchema = z.object({
  ...common,
  type: z.literal("fire"),
  color: hex.optional(),
  secondaryColor: hex.optional(),
  heat: z.number().min(-25).max(25).optional(),
  size: z.number().min(2).max(30).optional(),
});

export const SmokeSchema = z.object({
  ...common,
  type: z.literal("smoke"),
  color: hex.optional(),
  opacity: z.number().min(0).max(1).optional(),
  riseVelocity: z.number().min(-25).max(25).optional(),
  size: z.number().min(0.1).max(100).optional(),
});

export const SparklesSchema = z.object({
  ...common,
  type: z.literal("sparkles"),
  color: hex.optional(),
});

/** Ready-made mesh effects (see MESH_PRESETS). */
export const MESH_PRESET_NAMES = ["shockDome", "orb", "pillar", "ringBurst", "shield"] as const;
export type MeshPreset = (typeof MESH_PRESET_NAMES)[number];
const size3 = z.union([z.number(), vec3]);

/** A part that grows, fades, changes colour and spins: shock domes, energy orbs, light pillars, rings. */
export const MeshSchema = z.object({
  ...common,
  type: z.literal("mesh"),
  preset: z.enum(MESH_PRESET_NAMES).optional().describe("start from a ready-made mesh effect; other fields override it"),
  shape: z.enum(["sphere", "cylinder", "block", "ring"]).optional().describe("default sphere; cylinders stand upright (size [diameter, height, diameter]); ring lies flat ([diameter, 0, diameter])"),
  material: z.enum(["neon", "forcefield", "glass"]).optional().describe("default neon"),
  color: ColorSeqSchema.optional(),
  size: size3.optional().describe("studs at the start (a number for all sides), default 1"),
  to: size3.optional().describe("size at the end of its life, default the same"),
  transparency: NumberSeqSchema.optional().describe("over its life, default fades out [0, 1]"),
  life: z.number().min(0.05).max(10).optional().describe("seconds, default 0.6"),
  delay: z.number().min(0).max(30).optional(),
  loop: z.boolean().optional().describe("repeat forever instead of once when played"),
  pulse: z.boolean().optional().describe("with loop: grow and shrink back (breathing) instead of restarting"),
  ease: z.enum(["linear", "out", "in", "inOut"]).optional().describe("how the size changes, default out (fast, then slow)"),
  rot: vec3.optional().describe("degrees"),
  spin: vec3.optional().describe("degrees per second"),
});

export const EmitterSchema = z.discriminatedUnion("type", [ParticlesSchema, BeamSchema, TrailSchema, LightSchema, FireSchema, SmokeSchema, SparklesSchema, MeshSchema]);
export type VfxEmitter = z.infer<typeof EmitterSchema>;
export type VfxParticles = z.infer<typeof ParticlesSchema>;
export type VfxBeam = z.infer<typeof BeamSchema>;
export type VfxTrail = z.infer<typeof TrailSchema>;
export type VfxLight = z.infer<typeof LightSchema>;
export type VfxMesh = z.infer<typeof MeshSchema>;
export type NumberSeq = z.infer<typeof NumberSeqSchema>;
export type ColorSeq = z.infer<typeof ColorSeqSchema>;

export const VfxSpecSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  emitters: z.array(EmitterSchema).min(1).max(40),
  motion: z.enum(["none", "orbit", "swing", "line"]).optional().describe("how the preview moves the effect (trails need motion); default none, or orbit with trails"),
});
export type VfxSpec = z.infer<typeof VfxSpecSchema>;

// ---------------------------------------------------------------------------
// Sequences

export type { ColorKey, NumKey };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Normalized NumberSequence keypoints (sorted, first at 0, last at 1). */
export function numberKeys(seq: NumberSeq | undefined, fallback: number): NumKey[] {
  if (seq === undefined) return [{ t: 0, v: fallback, e: 0 }, { t: 1, v: fallback, e: 0 }];
  if (typeof seq === "number") return [{ t: 0, v: seq, e: 0 }, { t: 1, v: seq, e: 0 }];
  if (seq.length === 2 && typeof seq[0] === "number") {
    const [a, b] = seq as number[];
    return [{ t: 0, v: a, e: 0 }, { t: 1, v: b, e: 0 }];
  }
  const keys = (seq as number[][]).map(([t, v, e]) => ({ t: clamp01(t), v, e: Math.abs(e ?? 0) })).sort((a, b) => a.t - b.t);
  keys[0].t = 0;
  keys[keys.length - 1].t = 1;
  return keys;
}

export function colorKeys(seq: ColorSeq | undefined, fallback = "#ffffff"): ColorKey[] {
  const rgb = (h: string) => hexToRgb(h.startsWith("#") ? h : `#${h}`);
  if (seq === undefined) return [{ t: 0, c: rgb(fallback) }, { t: 1, c: rgb(fallback) }];
  if (typeof seq === "string") return [{ t: 0, c: rgb(seq) }, { t: 1, c: rgb(seq) }];
  if (typeof seq[0] === "string") return [{ t: 0, c: rgb(seq[0] as string) }, { t: 1, c: rgb(seq[1] as string) }];
  const keys = (seq as [number, string][]).map(([t, h]) => ({ t: clamp01(t), c: rgb(h) })).sort((a, b) => a.t - b.t);
  keys[0].t = 0;
  keys[keys.length - 1].t = 1;
  return keys;
}

export function sampleNumber(keys: NumKey[], t: number): number {
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (t <= b.t) {
      const a = keys[i - 1];
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return a.v + (b.v - a.v) * f;
    }
  }
  return keys[keys.length - 1].v;
}

export function sampleColor(keys: ColorKey[], t: number, out: RGB = [0, 0, 0]): RGB {
  let a = keys[0], b = keys[keys.length - 1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      a = keys[i - 1];
      b = keys[i];
      break;
    }
  }
  const f = b.t > a.t ? clamp01((t - a.t) / (b.t - a.t)) : 0;
  for (let i = 0; i < 3; i++) out[i] = a.c[i] + (b.c[i] - a.c[i]) * f;
  return out;
}

export const rangeOf = (r: number | number[] | undefined, fallback: [number, number]): [number, number] =>
  r === undefined ? fallback : typeof r === "number" ? [r, r] : [Math.min(r[0], r[1]), Math.max(r[0], r[1])];

export function textureUrl(t: string | undefined): string {
  if (!t) return VFX_TEXTURES.sparkle;
  return (VFX_TEXTURES as Record<string, string>)[t] ?? t;
}

/** The built-in preset a texture refers to (unknown asset ids preview as a soft glow). */
export function texturePreset(t: string | undefined): TexturePreset {
  if (!t) return "sparkle";
  if (t in VFX_TEXTURES) return t as TexturePreset;
  const hit = (Object.entries(VFX_TEXTURES) as [TexturePreset, string][]).find(([, url]) => url === t);
  return hit?.[0] ?? "glow";
}

// ---------------------------------------------------------------------------
// Defaults (Roblox's, where an effect leaves a field out)

export const PARTICLE_DEFAULTS = {
  color: "#ffffff",
  size: 1,
  transparency: 0,
  lifetime: [5, 10] as [number, number],
  rate: 20,
  speed: [5, 5] as [number, number],
  spread: [0, 0] as [number, number],
  rotation: [0, 0] as [number, number],
  spin: [0, 0] as [number, number],
};

export const DIRECTIONS: Record<string, Vec3> = {
  up: [0, 1, 0], down: [0, -1, 0], left: [-1, 0, 0], right: [1, 0, 0], front: [0, 0, -1], back: [0, 0, 1],
};

type PresetFields = Omit<VfxParticles, "name" | "type" | "preset" | "pos" | "enabled">;

/** Tuned particle emitters (most come from the starter effects). One-shots use rate 0 + burst. */
export const PARTICLE_PRESETS: Record<ParticlePreset, PresetFields> = {
  flames: { texture: "fire", color: [[0, "#ffd36b"], [0.45, "#ff7a1a"], [1, "#a8200a"]], size: [[0, 1.4], [0.5, 1.8], [1, 0.4]], transparency: [[0, 0.3], [0.6, 0.45], [1, 1]], lifetime: [0.6, 1.1], rate: 45, speed: [2, 4], spread: 12, rotation: [-30, 30], spin: [-60, 60], lightEmission: 1 },
  embers: { texture: "spark", color: ["#ffc04d", "#ff5a1f"], size: [0.18, 0.05], transparency: [0, 1], lifetime: [1.2, 2.2], rate: 14, speed: [4, 7], spread: 25, accel: [0, 1.5, 0], drag: 1, lightEmission: 1 },
  smoke: { texture: "smoke", color: "#3d3936", size: [[0, 1], [1, 3.5]], transparency: [[0, 0.75], [0.3, 0.6], [1, 1]], lifetime: [2.5, 3.5], rate: 5, speed: [1.5, 2.5], spread: 15, rotation: [0, 360], spin: [-20, 20], accel: [0.4, 0.2, 0] },
  sparks: { texture: "spark", color: ["#fff2b0", "#ff8a1f"], size: [0.35, 0.05], transparency: [0, 1], lifetime: [0.8, 1.4], rate: 0, burst: 40, speed: [18, 34], spread: 180, accel: [0, -40, 0], drag: 1.5, orientation: "velocity", squash: 1.5, lightEmission: 1 },
  flash: { texture: "glow", color: "#fff1c1", size: [[0, 4], [1, 12]], transparency: [[0, 0], [1, 1]], lifetime: 0.25, rate: 0, burst: 1, speed: 0, lightEmission: 1, zOffset: 1 },
  shockwave: { texture: "ring", color: "#ffd9a0", size: [[0, 2], [1, 22]], transparency: [[0, 0.2], [1, 1]], lifetime: 0.6, rate: 0, burst: 1, speed: 0, orientation: "velocityPerp", lightEmission: 0.6 },
  fireball: { texture: "core", color: [[0, "#ffe08a"], [0.4, "#ff7b22"], [1, "#5a1d0a"]], size: [[0, 3], [1, 7]], transparency: [[0, 0], [0.7, 0.4], [1, 1]], lifetime: [0.6, 0.9], rate: 0, burst: 18, speed: [6, 14], spread: 180, drag: 4, rotation: [0, 360], spin: [-90, 90], lightEmission: 0.8 },
  puff: { texture: "puff", color: "#3b3632", size: [[0, 3], [1, 8]], transparency: [[0, 0.4], [1, 1]], lifetime: [2, 3], rate: 0, burst: 14, speed: [3, 7], spread: 180, drag: 2, accel: [0, 2, 0], rotation: [0, 360], spin: [-30, 30] },
  dust: { texture: "puff", color: "#b59a76", size: [[0, 1.2], [1, 3.5]], transparency: [[0, 0.45], [1, 1]], lifetime: [0.9, 1.5], rate: 0, burst: 16, speed: [6, 10], spread: 85, drag: 3, accel: [0, 1, 0], rotation: [0, 360], spin: [-40, 40] },
  glow: { texture: "glow", color: "#ffffff", size: 3, transparency: [[0, 1], [0.3, 0.5], [1, 1]], lifetime: 0.5, rate: 10, speed: 0, locked: true, lightEmission: 1 },
  motes: { texture: "sparkle", color: "#e3d1ff", size: [0.35, 0], transparency: [0, 1], lifetime: [1.5, 2.5], rate: 12, speed: [0.5, 1], spread: 180, spin: [-90, 90], lightEmission: 1 },
  aura: { texture: "glow", color: ["#c69bff", "#6a2cff"], size: [[0, 0.9], [1, 0]], transparency: [[0, 0.2], [1, 1]], lifetime: [1.2, 2], rate: 80, speed: [2.5, 4], shape: "cylinder", shapeSize: [5, 0.2, 5], surface: true, lightEmission: 1 },
  rise: { texture: "sparkle", color: ["#b6ffcf", "#29e06f"], size: [0.45, 0], transparency: [0, 1], lifetime: [1.2, 2], rate: 16, speed: [2, 4], spin: [-90, 90], shape: "disc", shapeSize: [3, 0.2, 3], lightEmission: 1 },
  snow: { texture: "glow", color: "#ffffff", size: [[0, 0.4], [1, 0.3]], transparency: [[0, 1], [0.1, 0.1], [0.9, 0.2], [1, 1]], lifetime: [5, 7], rate: 120, speed: [2.5, 4], spread: 15, accel: [0.6, 0, 0.2], direction: "down", shape: "box", shapeSize: [40, 1, 40] },
  vortex: { texture: "vortex", color: ["#7ffff0", "#1a8cff"], size: [[0, 6], [1, 3]], transparency: [[0, 1], [0.3, 0.2], [1, 1]], lifetime: 1.5, rate: 6, speed: 0, rotation: [0, 360], spin: [160, 220], orientation: "velocityPerp", direction: "front", lightEmission: 1 },
  electric: { texture: "spark", color: "#d8f4ff", size: [0.3, 0], transparency: [0, 1], lifetime: 0.4, rate: 40, speed: [4, 9], spread: 180, lightEmission: 1 },
};

type MeshFields = Omit<VfxMesh, "name" | "type" | "preset" | "pos" | "enabled">;

export const MESH_PRESETS: Record<MeshPreset, MeshFields> = {
  shockDome: { shape: "sphere", material: "neon", color: "#9fe8ff", size: 1, to: 16, transparency: [[0, 0.2], [1, 1]], life: 0.5 },
  orb: { shape: "sphere", material: "neon", color: "#7fd0ff", size: 1.6, to: 2.1, transparency: 0.15, life: 0.9, loop: true, pulse: true, ease: "inOut" },
  pillar: { shape: "cylinder", material: "neon", color: "#aef1ff", size: [0.6, 14, 0.6], to: [3.5, 14, 3.5], transparency: [[0, 0.1], [1, 1]], life: 0.6 },
  ringBurst: { shape: "ring", material: "neon", color: "#ffd27a", size: [2, 0.05, 2], to: [20, 0.05, 20], transparency: [[0, 0], [1, 1]], life: 0.45 },
  shield: { shape: "sphere", material: "forcefield", color: "#6fb8ff", size: 7, to: 7.3, transparency: 0.55, life: 1.2, loop: true, pulse: true, ease: "inOut", spin: [0, 40, 0] },
};

/** A preset emitter with the given fields on top (a burst makes it a one-shot, a rate continuous). */
function expandParticlePreset(e: VfxParticles): VfxParticles {
  if (!e.preset) return e;
  const { preset, ...own } = e;
  const out: VfxParticles = { ...structuredClone(PARTICLE_PRESETS[preset]), ...own };
  if (own.burst !== undefined && own.rate === undefined) out.rate = 0;
  if (own.rate && own.burst === undefined) {
    delete out.burst;
    delete out.delay;
  }
  return out;
}

/** Round numbers, unique names, keep only what an emitter type uses; particle presets expanded. */
export function sanitizeVfxSpec(spec: VfxSpec): VfxSpec {
  const used = new Set<string>();
  const emitters = spec.emitters.map((raw) => {
    let e: VfxEmitter = raw.type === "particles" ? expandParticlePreset(raw) : raw;
    if (e.type === "mesh" && e.preset) {
      const { preset, ...own } = e;
      e = { ...structuredClone(MESH_PRESETS[preset]), ...own } as VfxEmitter;
    }
    let name = e.name.trim() || e.type;
    for (let i = 2; used.has(name); i++) name = `${e.name}${i}`;
    used.add(name);
    return { ...e, name };
  });
  const out: VfxSpec = { name: spec.name.trim() || "Effect", emitters };
  if (spec.description) out.description = spec.description;
  if (spec.motion) out.motion = spec.motion;
  return out;
}

/** Whether a preview should move the effect (trails only draw while moving). */
export function previewMotion(spec: VfxSpec): NonNullable<VfxSpec["motion"]> {
  if (spec.motion) return spec.motion;
  return spec.emitters.some((e) => e.type === "trail") ? "swing" : "none";
}

/** One-shot effects: every particle emitter bursts and every mesh plays once (none emit continuously). */
export function isOneShot(spec: VfxSpec): boolean {
  const ps = spec.emitters.filter((e): e is VfxParticles => e.type === "particles");
  const ms = spec.emitters.filter((e): e is VfxMesh => e.type === "mesh");
  return ps.length + ms.length > 0 && ps.every((p) => p.burst !== undefined && !p.rate) && ms.every((m) => !m.loop);
}

/** Seconds a one-shot takes to play out (bursts plus their longest lifetime, meshes' lives). */
export function oneShotLength(spec: VfxSpec): number {
  let t = 0;
  for (const e of spec.emitters) {
    if (e.type === "mesh" && !e.loop) t = Math.max(t, (e.delay ?? 0) + (e.life ?? MESH_DEFAULT_LIFE));
    if (e.type !== "particles" || e.burst === undefined) continue;
    t = Math.max(t, (e.delay ?? 0) + rangeOf(e.lifetime, PARTICLE_DEFAULTS.lifetime)[1]);
  }
  return t || 1;
}

export const MESH_DEFAULT_LIFE = 0.6;

/** A mesh's size as [x, y, z] (a number means all sides). */
export const meshSize = (v: number | number[] | undefined, fallback: Vec3 = [1, 1, 1]): Vec3 =>
  v === undefined ? fallback : typeof v === "number" ? [v, v, v] : (v as Vec3);

export function vfxSummary(spec: VfxSpec): string {
  const counts = new Map<string, number>();
  for (const e of spec.emitters) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const label: Record<string, string> = { particles: "emitter", beam: "beam", trail: "trail", light: "light", fire: "fire", smoke: "smoke", sparkles: "sparkles", mesh: "mesh" };
  return [...counts].map(([k, n]) => `${n} ${label[k]}${n > 1 && k !== "sparkles" && k !== "smoke" && k !== "fire" ? (k === "mesh" ? "es" : "s") : ""}`).join(" · ");
}

// ---------------------------------------------------------------------------
// Edits

const PartialEmitter = z.object({ name: z.string() }).catchall(z.any());
export const VfxEditSchema = z.object({
  name: z.string().min(1).max(60).optional().describe("rename the effect"),
  add: z.array(EmitterSchema).optional(),
  update: z.array(PartialEmitter).optional().describe("matched by name; only listed fields change (null removes a field)"),
  remove: z.array(z.string()).optional(),
  scale: z.number().min(0.05).max(20).optional().describe("scale sizes, speeds and offsets"),
  tint: hex.optional().describe("shift every color to this hue (keeps light and dark parts)"),
  motion: VfxSpecSchema.shape.motion,
});
export type VfxEdit = z.infer<typeof VfxEditSchema>;

export function applyVfxEdit(spec: VfxSpec, edit: VfxEdit): { spec: VfxSpec; missing: string[] } {
  const missing: string[] = [];
  let emitters = spec.emitters.map((e) => ({ ...e }));
  for (const u of edit.update ?? []) {
    const i = emitters.findIndex((e) => e.name === u.name);
    if (i < 0) {
      missing.push(u.name);
      continue;
    }
    const merged: Record<string, unknown> = { ...emitters[i] };
    for (const [k, v] of Object.entries(u)) {
      if (k === "name") continue;
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    if (typeof u.rename === "string") {
      merged.name = u.rename;
      delete merged.rename;
    }
    emitters[i] = EmitterSchema.parse(merged);
  }
  if (edit.remove?.length) {
    const gone = new Set(edit.remove);
    for (const n of gone) if (!emitters.some((e) => e.name === n)) missing.push(n);
    emitters = emitters.filter((e) => !gone.has(e.name));
  }
  emitters.push(...(edit.add ?? []));
  if (edit.scale && edit.scale !== 1) emitters = emitters.map((e) => scaleEmitter(e, edit.scale!));
  if (!emitters.length) throw new Error("An effect needs at least one emitter.");
  const next: VfxSpec = { ...spec, emitters, name: edit.name ?? spec.name };
  if (edit.motion) next.motion = edit.motion;
  const out = sanitizeVfxSpec(VfxSpecSchema.parse(next));
  return { spec: edit.tint ? tintVfx(out, edit.tint) : out, missing };
}

// ---------------------------------------------------------------------------
// Tint: rotate every color's hue so the effect's main hue becomes the tint's (a fire turns into
// a blue fire with the same bright core and dark edges). A grey tint makes the effect grey.

type HSL = [number, number, number];

function toHsl(h: string): HSL {
  const [r, g, b] = hexToRgb(h).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hue * 60, s, l];
}

function fromHsl([h, s, l]: HSL): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return "#" + [f(0), f(8), f(4)].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
}

function mapColorSeq(seq: ColorSeq | undefined, fn: (h: string) => string): ColorSeq | undefined {
  if (seq === undefined) return seq;
  if (typeof seq === "string") return fn(seq);
  if (typeof seq[0] === "string") return (seq as string[]).map(fn) as ColorSeq;
  return (seq as [number, string][]).map(([t, c]) => [t, fn(c)]) as ColorSeq;
}

function emitterColors(e: VfxEmitter, fn: (h: string) => string): VfxEmitter {
  const out = { ...e } as Record<string, unknown>;
  if (e.type === "particles" || e.type === "beam" || e.type === "trail" || e.type === "mesh") out.color = mapColorSeq(e.color, fn);
  else if (e.type === "fire") {
    out.color = fn(e.color ?? FIRE_DEFAULTS.color);
    out.secondaryColor = fn(e.secondaryColor ?? FIRE_DEFAULTS.secondaryColor);
  } else if (e.type === "light" || e.type === "smoke" || e.type === "sparkles") {
    if (e.color) out.color = fn(e.color);
    else if (e.type === "sparkles") out.color = fn(SPARKLES_DEFAULT);
  }
  if (out.color === undefined) delete out.color;
  return out as VfxEmitter;
}

export function tintVfx<T extends { emitters: VfxEmitter[] }>(spec: T, tint: string): T {
  const [th, ts] = toHsl(tint);
  // The effect's main hue: the circular mean of its colors' hues, weighted by how colorful each is.
  let x = 0, y = 0;
  for (const e of spec.emitters) {
    emitterColors(e, (h) => {
      const [hue, s, l] = toHsl(h);
      const w = s * (1 - Math.abs(2 * l - 1));
      x += Math.cos((hue * Math.PI) / 180) * w;
      y += Math.sin((hue * Math.PI) / 180) * w;
      return h;
    });
  }
  const colorful = Math.hypot(x, y) > 1e-3;
  const delta = th - (colorful ? (Math.atan2(y, x) * 180) / Math.PI : 0);
  const fn = (h: string) => {
    const [hue, s, l] = toHsl(h);
    if (ts < 0.08) return fromHsl([hue, 0, l]);
    // Colors turn by the same angle; greys stay grey unless the whole effect is grey or white.
    if (s < 0.06) return colorful ? h : fromHsl([th, ts * 0.6, l]);
    if (!colorful) return fromHsl([th, Math.max(s, ts * 0.6), l]);
    return fromHsl([(((hue + delta) % 360) + 360) % 360, s, l]);
  };
  return { ...spec, emitters: spec.emitters.map((e) => emitterColors(e, fn)) };
}

function scaleSeq(s: NumberSeq | undefined, k: number): NumberSeq | undefined {
  if (s === undefined) return s;
  if (typeof s === "number") return s * k;
  if (typeof s[0] === "number") return (s as number[]).map((v) => v * k);
  return (s as number[][]).map(([t, v, e]) => (e === undefined ? [t, v * k] : [t, v * k, e * k]));
}
const scaleRange = (r: number | number[] | undefined, k: number) => (r === undefined ? r : typeof r === "number" ? r * k : r.map((v) => v * k));
const scaleVec = (v: number[] | undefined, k: number) => v?.map((x) => x * k);

/** The whole effect scaled (sizes, speeds, offsets, light ranges). */
export function scaleVfx(spec: VfxSpec, k: number): VfxSpec {
  if (k === 1) return spec;
  return { ...spec, emitters: spec.emitters.map((e) => scaleEmitter(e, k)) };
}

/** The longest a particle or trail segment can live, seconds (how long the effect takes to fade). */
export function vfxTail(spec: VfxSpec): number {
  let t = 0;
  for (const e of spec.emitters) {
    if (e.type === "particles") t = Math.max(t, (e.delay ?? 0) + rangeOf(e.lifetime, PARTICLE_DEFAULTS.lifetime)[1] / (e.timeScale || 1));
    else if (e.type === "trail") t = Math.max(t, e.lifetime ?? 0.5);
    else if (e.type === "smoke") t = Math.max(t, 6);
    else if (e.type === "mesh") t = Math.max(t, (e.delay ?? 0) + (e.life ?? MESH_DEFAULT_LIFE));
    else if (e.type === "fire" || e.type === "sparkles") t = Math.max(t, 1.5);
    else t = Math.max(t, 0.25);
  }
  return t;
}

function scaleEmitter(e: VfxEmitter, k: number): VfxEmitter {
  const pos = scaleVec(e.pos, k);
  switch (e.type) {
    case "particles":
      return { ...e, pos, size: scaleSeq(e.size ?? 1, k), speed: scaleRange(e.speed ?? 5, k), accel: scaleVec(e.accel, k), shapeSize: scaleVec(e.shapeSize, k) } as VfxEmitter;
    case "beam":
      return { ...e, pos, from: scaleVec(e.from, k)!, to: scaleVec(e.to, k)!, width: scaleRange(e.width ?? 1, k), curve: scaleVec(e.curve, k) } as VfxEmitter;
    case "trail":
      return { ...e, pos, from: scaleVec(e.from, k)!, to: scaleVec(e.to, k)! } as VfxEmitter;
    case "light":
      return { ...e, pos, range: Math.min(60, (e.range ?? 8) * k) };
    case "fire":
      return { ...e, pos, size: Math.min(30, Math.max(2, (e.size ?? 5) * k)) };
    case "smoke":
      return { ...e, pos, size: Math.min(100, (e.size ?? 1) * k) };
    case "mesh":
      return { ...e, pos, size: meshSize(e.size).map((v) => v * k), ...(e.to !== undefined ? { to: meshSize(e.to).map((v) => v * k) } : {}) } as VfxEmitter;
    default:
      return { ...e, pos } as VfxEmitter;
  }
}

// ---------------------------------------------------------------------------
// Roblox instances

const NORMAL_IDS: Record<string, [string, number]> = {
  up: ["Top", 1], down: ["Bottom", 4], left: ["Left", 3], right: ["Right", 0], front: ["Front", 5], back: ["Back", 2],
};
const ORIENTATIONS: Record<string, [string, number]> = {
  camera: ["FacingCamera", 0], cameraUp: ["FacingCameraWorldUp", 1], velocity: ["VelocityParallel", 2], velocityPerp: ["VelocityPerpendicular", 3],
};
const SHAPES: Record<string, [string, number]> = { box: ["Box", 0], sphere: ["Sphere", 1], cylinder: ["Cylinder", 2], disc: ["Disc", 3] };
const FLIP_LAYOUTS: Record<string, [string, number]> = { "2x2": ["Grid2x2", 1], "4x4": ["Grid4x4", 2], "8x8": ["Grid8x8", 3] };
const FLIP_MODES: Record<string, [string, number]> = { loop: ["Loop", 0], once: ["OneShot", 1], pingpong: ["PingPong", 2], random: ["Random", 3] };
const TEXTURE_MODES: Record<string, [string, number]> = { stretch: ["Stretch", 0], wrap: ["Wrap", 1], static: ["Static", 2] };

const en = (e: string, [item, token]: [string, number]): PropValue => ({ enum: e, item, token });
const rgb = (h: string): PropValue => ({ rgb: hexToRgb(h.startsWith("#") ? h : `#${h}`) });
/** Attachment orientation (0, 0, 90): its X axis (what beams curve along) points up. */
const AXIS_UP: Mat3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];

export const FIRE_DEFAULTS = { color: "#ec8b46", secondaryColor: "#8b5037", heat: 9, size: 5 };
export const SMOKE_DEFAULTS = { color: "#ffffff", opacity: 0.5, riseVelocity: 1, size: 1 };
export const SPARKLES_DEFAULT = "#9019ff";

/**
 * Animates the mesh effects (parts with a ForgeMesh attribute) of a model: one-shots once
 * (loops = false) or the looping ones forever (loops = true). Shared by every generated script.
 */
export const MESH_LUAU = `-- Mesh effects: parts that grow, fade, change colour and spin (settings in their ForgeMesh attribute).
local function forgeMeshes(model, loops)
	local HttpService = game:GetService("HttpService")
	local RunService = game:GetService("RunService")
	local function sample(keys, f)
		if f <= keys[1][1] then return keys[1] end
		for i = 2, #keys do
			local b = keys[i]
			if f <= b[1] then
				local a = keys[i - 1]
				local k = (f - a[1]) / math.max(1e-6, b[1] - a[1])
				local out = {}
				for j = 1, #a do out[j] = a[j] + (b[j] - a[j]) * k end
				return out
			end
		end
		return keys[#keys]
	end
	local function eased(f, kind)
		if kind == "linear" then return f end
		if kind == "in" then return f * f * f end
		if kind == "inOut" then return if f < 0.5 then 4 * f * f * f else 1 - (2 - 2 * f) ^ 3 / 2 end
		return 1 - (1 - f) ^ 3
	end
	for _, part in model:GetDescendants() do
		local raw = part:IsA("BasePart") and part:GetAttribute("ForgeMesh")
		if raw then
			local ok, m = pcall(function() return HttpService:JSONDecode(raw) end)
			if ok and (m.loop == true) == loops then
				local start = os.clock() + (m.delay or 0)
				local offset = model:GetPivot():ToObjectSpace(part.CFrame)
				local conn = nil
				conn = RunService.Heartbeat:Connect(function()
					if not part.Parent then
						conn:Disconnect()
						return
					end
					local age = os.clock() - start
					-- Rings show a Decal on an invisible part: fade and colour the Decal.
					local skin = part:FindFirstChild("Ring") or part
					if age < 0 then
						skin.Transparency = 1
						return
					end
					if not m.loop and age >= m.life then
						skin.Transparency = 1
						conn:Disconnect()
						return
					end
					local f = (age % m.life) / m.life
					if m.pulse then f = 1 - math.abs(1 - 2 * f) end
					local k = eased(f, m.ease)
					part.Size = Vector3.new(m.from[1] + (m.to[1] - m.from[1]) * k, m.from[2] + (m.to[2] - m.from[2]) * k, m.from[3] + (m.to[3] - m.from[3]) * k)
					skin.Transparency = sample(m.t, f)[2]
					if m.c then
						local c = sample(m.c, f)
						if skin == part then part.Color = Color3.fromRGB(c[2], c[3], c[4]) else skin.Color3 = Color3.fromRGB(c[2], c[3], c[4]) end
					end
					local spin = CFrame.new()
					if m.spin then spin = CFrame.Angles(math.rad(m.spin[1] * age), math.rad(m.spin[2] * age), math.rad(m.spin[3] * age)) end
					part.CFrame = model:GetPivot() * CFrame.new(offset.Position) * spin * offset.Rotation
				end)
			end
		end
	end
end
`;

const PLAY_SOURCE = `-- Plays this effect's one-shot bursts: require(effect.Play)()
local effect = script.Parent
${MESH_LUAU}
return function()
	for _, e in effect:GetDescendants() do
		if e:IsA("ParticleEmitter") and e:GetAttribute("EmitCount") then
			task.delay(e:GetAttribute("EmitDelay") or 0, function()
				e:Emit(e:GetAttribute("EmitCount"))
			end)
		end
	end
	forgeMeshes(effect, false)
end
`;

const LOOP_SOURCE = `-- Keeps this effect's looping mesh effects moving.
${MESH_LUAU}
forgeMeshes(script.Parent, true)
`;

const MESH_MATERIALS = { neon: ["Neon", 288], forcefield: ["ForceField", 1584], glass: ["Glass", 1568] } as const;
/** Roblox cylinders lie along X; mesh cylinders stand up. */
const STAND_UP: Mat3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];

function meshPart(e: VfxMesh): InstNode {
  const shape = e.shape ?? "sphere";
  if (shape === "ring") return ringPart(e);
  const toPart = (v: Vec3): Vec3 => (shape === "cylinder" ? [v[1], v[0], v[2]] : v);
  const from = toPart(meshSize(e.size));
  const to = toPart(meshSize(e.to ?? e.size));
  const settings = meshSettings(e, from, to);
  const tKeys = settings.t as number[][];
  const cKeys = colorKeys(e.color, "#ffffff");
  const rot = mul(eulerXYZDeg(e.rot as Vec3 | undefined), shape === "cylinder" ? STAND_UP : [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const [matName, matToken] = MESH_MATERIALS[e.material ?? "neon"];
  const props: Record<string, PropValue> = {
    Anchored: true, CanCollide: false, CanTouch: false, CanQuery: false, CastShadow: false,
    Material: { enum: "Material", item: matName, token: matToken },
    Color: { rgb: cKeys[0].c },
    Size: { v3: from },
    CFrame: { cf: { pos: (e.pos ?? [0, 0, 0]) as Vec3, rot } },
    // Hidden until played; loops show from the start.
    Transparency: e.loop ? tKeys[0][1] : 1,
  };
  if (shape === "cylinder") props.Shape = en("PartType", ["Cylinder", 2]);
  return {
    className: "Part",
    name: e.name,
    props,
    attrs: { ForgeMesh: JSON.stringify(settings) },
    children: shape === "sphere" ? [{ className: "SpecialMesh", name: "Mesh", props: { MeshType: en("MeshType", ["Sphere", 3]) } }] : [],
  };
}

/** Settings the mesh runtime reads (sizes in the part's own axes). */
function meshSettings(e: VfxMesh, from: Vec3, to: Vec3) {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  const cKeys = colorKeys(e.color, "#ffffff");
  return {
    life: e.life ?? MESH_DEFAULT_LIFE,
    ...(e.delay ? { delay: e.delay } : {}),
    ...(e.loop ? { loop: true } : {}),
    ...(e.pulse ? { pulse: true } : {}),
    ease: e.ease ?? "out",
    from: from.map(r),
    to: to.map(r),
    t: numberKeys(e.transparency ?? [0, 1], 0).map((k) => [r(k.t), r(k.v)]),
    ...(cKeys.length > 1 && cKeys.some((k) => k.c.join() !== cKeys[0].c.join()) ? { c: cKeys.map((k) => [r(k.t), ...k.c.map(Math.round)]) } : {}),
    ...(e.spin ? { spin: e.spin } : {}),
  };
}

/**
 * A flat ring: Roblox has no ring part, so (like hand-made VFX) it is the shockwave ring texture
 * as a Decal on top of a thin invisible part that grows; the Decal fades and takes the colour.
 */
function ringPart(e: VfxMesh): InstNode {
  const thin = (v: Vec3): Vec3 => [v[0], 0.05, v[2]];
  const from = thin(meshSize(e.size, [2, 0.05, 2])), to = thin(meshSize(e.to ?? e.size, [2, 0.05, 2]));
  const settings = meshSettings(e, from, to);
  const tKeys = settings.t as number[][];
  const first = colorKeys(e.color, "#ffffff")[0].c;
  return {
    className: "Part",
    name: e.name,
    props: {
      ...hiddenPart(from, (e.pos ?? [0, 0, 0]) as Vec3),
      CFrame: { cf: { pos: (e.pos ?? [0, 0, 0]) as Vec3, rot: eulerXYZDeg(e.rot as Vec3 | undefined) } },
    },
    attrs: { ForgeMesh: JSON.stringify(settings) },
    children: [{
      className: "Decal",
      name: "Ring",
      props: { Texture: { content: VFX_TEXTURES.ring }, Face: en("NormalId", ["Top", 1]), Color3: { rgb: first }, Transparency: e.loop ? tKeys[0][1] : 1 },
    }],
  };
}

function particleProps(e: VfxParticles): { props: Record<string, PropValue>; attrs?: Record<string, number> } {
  const spread = e.spread === undefined ? [0, 0] : typeof e.spread === "number" ? [e.spread, e.spread] : e.spread;
  const props: Record<string, PropValue> = {
    Texture: { content: textureUrl(e.texture) },
    Color: { cseq: colorKeys(e.color, PARTICLE_DEFAULTS.color) },
    Size: { nseq: numberKeys(e.size, PARTICLE_DEFAULTS.size) },
    Transparency: { nseq: numberKeys(e.transparency, PARTICLE_DEFAULTS.transparency) },
    Lifetime: { range: rangeOf(e.lifetime, PARTICLE_DEFAULTS.lifetime) },
    Rate: e.rate ?? (e.burst !== undefined ? 0 : PARTICLE_DEFAULTS.rate),
    Speed: { range: rangeOf(e.speed, PARTICLE_DEFAULTS.speed) },
    SpreadAngle: { v2: [spread[0], spread[1]] },
    EmissionDirection: en("NormalId", NORMAL_IDS[e.direction ?? "up"]),
  };
  if (e.accel) props.Acceleration = { v3: e.accel as Vec3 };
  if (e.drag !== undefined) props.Drag = e.drag;
  if (e.rotation !== undefined) props.Rotation = { range: rangeOf(e.rotation, [0, 0]) };
  if (e.spin !== undefined) props.RotSpeed = { range: rangeOf(e.spin, [0, 0]) };
  if (e.lightEmission !== undefined) props.LightEmission = e.lightEmission;
  if (e.lightInfluence !== undefined) props.LightInfluence = e.lightInfluence;
  if (e.brightness !== undefined) props.Brightness = e.brightness;
  if (e.squash !== undefined) props.Squash = { nseq: numberKeys(e.squash, 0) };
  if (e.zOffset !== undefined) props.ZOffset = e.zOffset;
  if (e.orientation) props.Orientation = en("ParticleOrientation", ORIENTATIONS[e.orientation]);
  if (e.locked !== undefined) props.LockedToPart = e.locked;
  if (e.timeScale !== undefined) props.TimeScale = e.timeScale;
  if (e.shape && e.shape !== "point") {
    props.Shape = en("ParticleEmitterShape", SHAPES[e.shape]);
    if (e.surface) props.ShapeStyle = en("ParticleEmitterShapeStyle", ["Surface", 1]);
    if (e.inward) props.ShapeInOut = en("ParticleEmitterShapeInOut", ["Inward", 1]);
  }
  if (e.flipbook) {
    props.FlipbookLayout = en("ParticleFlipbookLayout", FLIP_LAYOUTS[e.flipbook.grid]);
    props.FlipbookMode = en("ParticleFlipbookMode", FLIP_MODES[e.flipbook.mode ?? "loop"]);
    if (e.flipbook.fps) props.FlipbookFramerate = { range: [e.flipbook.fps, e.flipbook.fps] };
  }
  if (e.enabled === false) props.Enabled = false;
  const attrs = e.burst !== undefined ? { EmitCount: e.burst, ...(e.delay ? { EmitDelay: e.delay } : {}) } : undefined;
  return { props, attrs };
}

const hiddenPart = (size: number[], pos: number[]): Record<string, PropValue> => ({
  Anchored: true, CanCollide: false, CanTouch: false, CanQuery: false, CastShadow: false, Transparency: 1,
  Size: { v3: size as Vec3 }, CFrame: { cf: { pos: pos as Vec3 } },
});

/**
 * The effect as Roblox instances, standing at the origin: a Model whose invisible Root part holds
 * an Attachment per emitter (shaped particle emitters get their own invisible part).
 */
export function vfxTree(spec: VfxSpec): InstNode {
  const root: InstNode = { id: "root", className: "Part", name: "Root", props: hiddenPart([1, 1, 1], [0, 0, 0]), children: [] };
  const model: InstNode = { className: "Model", name: spec.name, props: { PrimaryPart: { ref: "root" } }, children: [root] };
  const at = (name: string, pos: number[] | undefined, children: InstNode[] = [], rot?: Mat3, id?: string): InstNode => ({
    ...(id ? { id } : {}),
    className: "Attachment",
    name,
    props: { CFrame: { cf: { pos: (pos ?? [0, 0, 0]) as Vec3, ...(rot ? { rot } : {}) } } },
    children,
  });
  for (const e of spec.emitters) {
    const off = (e.enabled === false ? { Enabled: false } : {}) as Record<string, PropValue>;
    switch (e.type) {
      case "particles": {
        const { props, attrs } = particleProps(e);
        const emitter: InstNode = { className: "ParticleEmitter", name: e.name, props, ...(attrs ? { attrs } : {}) };
        if (e.shape && e.shape !== "point") {
          model.children!.push({ className: "Part", name: e.name, props: hiddenPart(e.shapeSize ?? [2, 2, 2], e.pos ?? [0, 0, 0]), children: [emitter] });
        } else root.children!.push(at(e.name, e.pos, [emitter]));
        break;
      }
      case "beam": {
        const width = e.width === undefined ? [1, 1] : typeof e.width === "number" ? [e.width, e.width] : e.width;
        const props: Record<string, PropValue> = {
          Attachment0: { ref: `${e.name}#0` },
          Attachment1: { ref: `${e.name}#1` },
          Color: { cseq: colorKeys(e.color) },
          Transparency: { nseq: numberKeys(e.transparency, 0) },
          Width0: width[0],
          Width1: width[1],
          FaceCamera: e.faceCamera ?? true,
          Segments: { int: e.segments ?? (e.curve ? 20 : 10) },
          ...off,
        };
        if (e.curve) {
          props.CurveSize0 = e.curve[0];
          props.CurveSize1 = e.curve[1];
        }
        if (e.texture) {
          props.Texture = { content: textureUrl(e.texture) };
          props.TextureLength = e.textureLength ?? 1;
          props.TextureSpeed = e.textureSpeed ?? 1;
          props.TextureMode = en("TextureMode", TEXTURE_MODES[e.textureMode ?? "stretch"]);
        }
        if (e.lightEmission !== undefined) props.LightEmission = e.lightEmission;
        if (e.brightness !== undefined) props.Brightness = e.brightness;
        root.children!.push(at(`${e.name}0`, e.from, [], AXIS_UP, `${e.name}#0`), at(`${e.name}1`, e.to, [], AXIS_UP, `${e.name}#1`));
        root.children!.push({ className: "Beam", name: e.name, props });
        break;
      }
      case "trail": {
        const props: Record<string, PropValue> = {
          Attachment0: { ref: `${e.name}#0` },
          Attachment1: { ref: `${e.name}#1` },
          Color: { cseq: colorKeys(e.color) },
          Transparency: { nseq: numberKeys(e.transparency, 0) },
          Lifetime: e.lifetime ?? 0.5,
          ...off,
        };
        if (e.widthScale !== undefined) props.WidthScale = { nseq: numberKeys(e.widthScale, 1) };
        if (e.minLength !== undefined) props.MinLength = e.minLength;
        if (e.faceCamera !== undefined) props.FaceCamera = e.faceCamera;
        if (e.lightEmission !== undefined) props.LightEmission = e.lightEmission;
        if (e.brightness !== undefined) props.Brightness = e.brightness;
        if (e.texture) props.Texture = { content: textureUrl(e.texture) };
        root.children!.push(at(`${e.name}0`, e.from, [], undefined, `${e.name}#0`), at(`${e.name}1`, e.to, [], undefined, `${e.name}#1`));
        root.children!.push({ className: "Trail", name: e.name, props });
        break;
      }
      case "light": {
        const spot = e.kind === "spot";
        const props: Record<string, PropValue> = {
          Color: rgb(e.color ?? "#ffffff"),
          Brightness: e.brightness ?? 1,
          Range: e.range ?? 8,
          ...off,
        };
        if (e.shadows) props.Shadows = true;
        if (spot) {
          props.Angle = e.angle ?? 90;
          props.Face = en("NormalId", NORMAL_IDS[e.face ?? "down"]);
        }
        root.children!.push(at(e.name, e.pos, [{ className: spot ? "SpotLight" : "PointLight", name: e.name, props }]));
        break;
      }
      case "fire":
        root.children!.push(at(e.name, e.pos, [{
          className: "Fire",
          name: e.name,
          props: {
            Color: rgb(e.color ?? FIRE_DEFAULTS.color),
            SecondaryColor: rgb(e.secondaryColor ?? FIRE_DEFAULTS.secondaryColor),
            Heat: e.heat ?? FIRE_DEFAULTS.heat,
            Size: e.size ?? FIRE_DEFAULTS.size,
            ...off,
          },
        }]));
        break;
      case "smoke":
        root.children!.push(at(e.name, e.pos, [{
          className: "Smoke",
          name: e.name,
          props: {
            Color: rgb(e.color ?? SMOKE_DEFAULTS.color),
            Opacity: e.opacity ?? SMOKE_DEFAULTS.opacity,
            RiseVelocity: e.riseVelocity ?? SMOKE_DEFAULTS.riseVelocity,
            Size: e.size ?? SMOKE_DEFAULTS.size,
            ...off,
          },
        }]));
        break;
      case "sparkles":
        root.children!.push(at(e.name, e.pos, [{ className: "Sparkles", name: e.name, props: { SparkleColor: rgb(e.color ?? SPARKLES_DEFAULT), ...off } }]));
        break;
      case "mesh":
        if (e.enabled !== false) model.children!.push(meshPart(e));
        break;
    }
  }
  const meshes = spec.emitters.filter((e): e is VfxMesh => e.type === "mesh" && e.enabled !== false);
  if (spec.emitters.some((e) => e.type === "particles" && e.burst !== undefined) || meshes.some((m) => !m.loop)) {
    model.children!.push({ className: "ModuleScript", name: "Play", source: PLAY_SOURCE });
  }
  if (meshes.some((m) => m.loop)) model.children!.push({ className: "Script", name: "MeshLoop", source: LOOP_SOURCE });
  return model;
}
