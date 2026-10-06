// Visual effects: Roblox ParticleEmitters, Beams, Trails, Fire, Smoke, Sparkles and lights,
// grouped into one effect that previews live in the browser and imports into Studio.
//
// Coordinates are studs relative to the effect's root (y = up, the root sits on the ground at
// its center). Sequences follow Roblox: a number/color is constant, a pair goes from the first
// to the second over the lifetime, and a list of [time 0..1, value(, envelope)] keypoints is used
// as is. Ranges ([min, max]) pick a random value per particle.

import { z } from "zod";
import { hexToRgb } from "./math.ts";
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

const common = {
  name: z.string().min(1).max(60),
  pos: vec3.optional().describe("offset from the root, studs"),
  enabled: z.boolean().optional(),
};

export const ParticlesSchema = z.object({
  ...common,
  type: z.literal("particles"),
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

export const EmitterSchema = z.discriminatedUnion("type", [ParticlesSchema, BeamSchema, TrailSchema, LightSchema, FireSchema, SmokeSchema, SparklesSchema]);
export type VfxEmitter = z.infer<typeof EmitterSchema>;
export type VfxParticles = z.infer<typeof ParticlesSchema>;
export type VfxBeam = z.infer<typeof BeamSchema>;
export type VfxTrail = z.infer<typeof TrailSchema>;
export type VfxLight = z.infer<typeof LightSchema>;
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

/** Round numbers, unique names, keep only what an emitter type uses. */
export function sanitizeVfxSpec(spec: VfxSpec): VfxSpec {
  const used = new Set<string>();
  const emitters = spec.emitters.map((e) => {
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

/** One-shot effects: every particle emitter bursts and none emit continuously. */
export function isOneShot(spec: VfxSpec): boolean {
  const ps = spec.emitters.filter((e): e is VfxParticles => e.type === "particles");
  return ps.length > 0 && ps.every((p) => p.burst !== undefined && !p.rate);
}

/** Seconds a one-shot takes to play out (bursts plus their longest lifetime). */
export function oneShotLength(spec: VfxSpec): number {
  let t = 0;
  for (const e of spec.emitters) {
    if (e.type !== "particles" || e.burst === undefined) continue;
    t = Math.max(t, (e.delay ?? 0) + rangeOf(e.lifetime, PARTICLE_DEFAULTS.lifetime)[1]);
  }
  return t || 1;
}

export function vfxSummary(spec: VfxSpec): string {
  const counts = new Map<string, number>();
  for (const e of spec.emitters) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const label: Record<string, string> = { particles: "emitter", beam: "beam", trail: "trail", light: "light", fire: "fire", smoke: "smoke", sparkles: "sparkles" };
  return [...counts].map(([k, n]) => `${n} ${label[k]}${n > 1 && k !== "sparkles" && k !== "smoke" && k !== "fire" ? "s" : ""}`).join(" · ");
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
  return { spec: sanitizeVfxSpec(VfxSpecSchema.parse(next)), missing };
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

const PLAY_SOURCE = `-- Plays this effect's one-shot bursts: require(effect.Play)()
local effect = script.Parent
return function()
	for _, e in effect:GetDescendants() do
		if e:IsA("ParticleEmitter") and e:GetAttribute("EmitCount") then
			task.delay(e:GetAttribute("EmitDelay") or 0, function()
				e:Emit(e:GetAttribute("EmitCount"))
			end)
		end
	end
end
`;

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
    }
  }
  if (spec.emitters.some((e) => e.type === "particles" && e.burst !== undefined)) {
    model.children!.push({ className: "ModuleScript", name: "Play", source: PLAY_SOURCE });
  }
  return model;
}
