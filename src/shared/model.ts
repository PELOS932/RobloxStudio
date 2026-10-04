import { z } from "zod";
import { MATERIALS, NORMAL_IDS, type MaterialName, type NormalIdName } from "./roblox-data.ts";
import {
  applyMat, clamp, eulerXYZDeg, hexToRgb, mul, rotY, rotZ, round,
  type Mat3, type RGB, type Vec3,
} from "./math.ts";

const vec3 = (d: string) => z.array(z.number()).length(3).describe(d);
export const hexColor = z.string().regex(/^#?[0-9a-fA-F]{6}$/, "hex color like #aabbcc");

export const LightSchema = z.object({
  type: z.enum(["point", "spot", "surface"]),
  color: hexColor.optional(),
  brightness: z.number().min(0).max(40).optional().describe("default 1"),
  range: z.number().min(0).max(60).optional().describe("studs, default 12"),
  angle: z.number().min(0).max(180).optional().describe("spot/surface only, default 90"),
  face: z.enum(NORMAL_IDS).optional().describe("spot/surface only, default Front"),
  shadows: z.boolean().optional(),
});

export const PartSchema = z.object({
  name: z.string().min(1).max(60).optional().describe("unique within the model; edit_model addresses parts by name"),
  shape: z.enum(["block", "ball", "cylinder", "wedge"]).optional().describe("default block"),
  size: vec3("[x,y,z] studs"),
  pos: vec3("center [x,y,z] studs in model space, Y up"),
  rot: vec3("degrees [x,y,z], same order as CFrame.Angles").optional(),
  axis: z.enum(["x", "y", "z"]).optional().describe("cylinder length axis (default x like Roblox). axis y + size [d,h,d] = upright cylinder"),
  color: hexColor.optional().describe("default #a3a2a5"),
  material: z.enum(MATERIALS).optional().describe("default Plastic"),
  transparency: z.number().min(0).max(1).optional(),
  reflectance: z.number().min(0).max(1).optional(),
  collide: z.boolean().optional().describe("CanCollide, default true"),
  group: z.string().max(120).optional().describe("sub-model path, e.g. 'Roof' or 'House/Door'"),
  light: LightSchema.optional(),
});

export const ModelSpecSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  parts: z.array(PartSchema).min(1).max(3000),
});

export type PartSpec = z.infer<typeof PartSchema>;
export type ModelSpec = z.infer<typeof ModelSpecSchema>;
export type LightSpec = z.infer<typeof LightSchema>;

export interface NativeLight {
  className: "PointLight" | "SpotLight" | "SurfaceLight";
  color: RGB;
  brightness: number;
  range: number;
  angle: number;
  face: NormalIdName;
  shadows: boolean;
}

/** A part expressed exactly the way Roblox stores it. */
export interface NativePart {
  name: string;
  className: "Part" | "WedgePart";
  shape: "Block" | "Ball" | "Cylinder" | null;
  size: Vec3;
  pos: Vec3;
  rot: Mat3;
  color: RGB;
  material: MaterialName;
  transparency: number;
  reflectance: number;
  anchored: boolean;
  canCollide: boolean;
  canTouch: boolean;
  castShadow: boolean;
  group: string;
  light?: NativeLight;
}

export interface NativeModel {
  name: string;
  parts: NativePart[];
  bounds: { min: Vec3; max: Vec3 };
}

export interface ConvertOptions {
  /** Apply static-geometry performance settings (CanTouch off, no shadows on tiny/neon parts). */
  performance?: boolean;
  anchored?: boolean;
}

const MIN_SIZE = 0.05;
const MAX_SIZE = 2048;

/** Give every part a unique, stable name and round noisy numbers. Run once when an asset is saved. */
export function sanitizeModelSpec(spec: ModelSpec): ModelSpec {
  const used = new Set<string>();
  const parts = spec.parts.map((p, i) => {
    const base = (p.name ?? "").trim() || `${capitalize(p.shape ?? "block")}${i + 1}`;
    const name = uniqueName(base, used);
    const out: PartSpec = { ...p, name };
    out.size = p.size.map((v) => round(clamp(Math.abs(v), MIN_SIZE, MAX_SIZE), 4));
    out.pos = p.pos.map((v) => round(v, 4));
    if (p.rot) out.rot = p.rot.map((v) => round(v, 3));
    if (p.color) out.color = normalizeHex(p.color);
    if (p.group) out.group = p.group.split("/").map((s) => s.trim()).filter(Boolean).join("/") || undefined;
    return out;
  });
  return { ...spec, name: spec.name.trim() || "Model", parts };
}

export function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

export function normalizeHex(hex: string): string {
  return ("#" + hex.replace(/^#/, "")).toLowerCase();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function nativeLight(l: LightSpec): NativeLight {
  return {
    className: l.type === "spot" ? "SpotLight" : l.type === "surface" ? "SurfaceLight" : "PointLight",
    color: hexToRgb(l.color ?? "#ffffff"),
    brightness: l.brightness ?? 1,
    range: l.range ?? 12,
    angle: l.angle ?? 90,
    face: l.face ?? "Front",
    shadows: l.shadows ?? false,
  };
}

export function toNativePart(p: PartSpec, index: number, opts: ConvertOptions = {}): NativePart {
  const shape = p.shape ?? "block";
  let size: Vec3 = [p.size[0], p.size[1], p.size[2]].map((v) => clamp(Math.abs(v), MIN_SIZE, MAX_SIZE)) as Vec3;
  let rot = eulerXYZDeg(p.rot as Vec3 | undefined);

  if (shape === "cylinder") {
    // Roblox cylinders run along local X. Re-express other axes natively.
    if (p.axis === "y") {
      size = [size[1], size[0], size[2]];
      rot = mul(rot, rotZ(Math.PI / 2));
    } else if (p.axis === "z") {
      size = [size[2], size[1], size[0]];
      rot = mul(rot, rotY(-Math.PI / 2));
    }
    const d = Math.min(size[1], size[2]);
    size = [size[0], d, d];
  } else if (shape === "ball") {
    const d = Math.min(size[0], size[1], size[2]);
    size = [d, d, d];
  }

  const transparency = p.transparency ?? 0;
  const material = (p.material ?? "Plastic") as MaterialName;
  const perf = opts.performance ?? true;
  const tiny = Math.max(size[0], size[1], size[2]) < 0.6;

  return {
    name: p.name ?? `Part${index + 1}`,
    className: shape === "wedge" ? "WedgePart" : "Part",
    shape: shape === "wedge" ? null : shape === "ball" ? "Ball" : shape === "cylinder" ? "Cylinder" : "Block",
    size: size.map((v) => round(v, 4)) as Vec3,
    pos: [p.pos[0], p.pos[1], p.pos[2]],
    rot: rot.map((v) => round(v, 7)) as Mat3,
    color: hexToRgb(p.color ?? "#a3a2a5"),
    material,
    transparency,
    reflectance: p.reflectance ?? 0,
    anchored: opts.anchored ?? true,
    canCollide: p.collide ?? true,
    canTouch: perf ? false : true,
    castShadow: perf ? !(tiny || transparency >= 0.9 || material === "Neon") : true,
    group: p.group ?? "",
    light: p.light ? nativeLight(p.light) : undefined,
  };
}

export function partBounds(p: NativePart): { min: Vec3; max: Vec3 } {
  const h: Vec3 = [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2];
  const r = p.rot;
  const ext: Vec3 = [
    Math.abs(r[0]) * h[0] + Math.abs(r[1]) * h[1] + Math.abs(r[2]) * h[2],
    Math.abs(r[3]) * h[0] + Math.abs(r[4]) * h[1] + Math.abs(r[5]) * h[2],
    Math.abs(r[6]) * h[0] + Math.abs(r[7]) * h[1] + Math.abs(r[8]) * h[2],
  ];
  return {
    min: [p.pos[0] - ext[0], p.pos[1] - ext[1], p.pos[2] - ext[2]],
    max: [p.pos[0] + ext[0], p.pos[1] + ext[1], p.pos[2] + ext[2]],
  };
}

export function toNativeModel(spec: ModelSpec, opts: ConvertOptions = {}): NativeModel {
  const parts = spec.parts.map((p, i) => toNativePart(p, i, opts));
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const b = partBounds(p);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  }
  if (!parts.length) return { name: spec.name, parts, bounds: { min: [0, 0, 0], max: [0, 0, 0] } };
  return { name: spec.name, parts, bounds: { min, max } };
}

// ---------------------------------------------------------------------------
// Editing (edit_model tool) — lets Claude change a few parts without re-sending the whole model.

export const ModelEditSchema = z.object({
  add: z.array(PartSchema).optional().describe("new parts"),
  update: z
    .array(PartSchema.partial().extend({ name: z.string().describe("existing part name") }))
    .optional()
    .describe("partial updates matched by name; only listed fields change"),
  remove: z.array(z.string()).optional().describe("part names to delete"),
  rename: z.string().optional().describe("new model name"),
  move: vec3("offset every part by [x,y,z]").optional(),
  scale: z.number().positive().max(100).optional().describe("uniformly scale the whole model"),
});
export type ModelEdit = z.infer<typeof ModelEditSchema>;

export function applyModelEdit(spec: ModelSpec, edit: ModelEdit): { spec: ModelSpec; missing: string[] } {
  const missing: string[] = [];
  let parts = spec.parts.slice();
  if (edit.remove?.length) {
    const rm = new Set(edit.remove);
    for (const n of rm) if (!parts.some((p) => p.name === n)) missing.push(n);
    parts = parts.filter((p) => !rm.has(p.name ?? ""));
  }
  for (const u of edit.update ?? []) {
    const i = parts.findIndex((p) => p.name === u.name);
    if (i < 0) {
      missing.push(u.name);
      continue;
    }
    const merged: Record<string, unknown> = { ...parts[i] };
    for (const [k, v] of Object.entries(u)) if (v !== undefined) merged[k] = v;
    parts[i] = merged as PartSpec;
  }
  if (edit.add?.length) parts = parts.concat(edit.add);
  if (edit.move) {
    const m = edit.move;
    parts = parts.map((p) => ({ ...p, pos: [p.pos[0] + m[0], p.pos[1] + m[1], p.pos[2] + m[2]] }));
  }
  if (edit.scale && edit.scale !== 1) {
    const s = edit.scale;
    parts = parts.map((p) => ({
      ...p,
      pos: p.pos.map((v) => v * s),
      size: p.size.map((v) => v * s),
      light: p.light?.range ? { ...p.light, range: Math.min(60, p.light.range * s) } : p.light,
    }));
  }
  const next = sanitizeModelSpec({ ...spec, name: edit.rename ?? spec.name, parts });
  return { spec: next, missing };
}

/** Rotated corner points of a wedge in part space (Roblox: slope faces -Z/front, tall face at +Z/back). */
export function wedgeVertices(size: Vec3): Vec3[] {
  const [x, y, z] = size.map((v) => v / 2);
  return [
    [-x, -y, -z], [x, -y, -z],
    [-x, -y, z], [x, -y, z],
    [-x, y, z], [x, y, z],
  ];
}

export function worldPoint(p: NativePart, local: Vec3): Vec3 {
  const v = applyMat(p.rot, local);
  return [v[0] + p.pos[0], v[1] + p.pos[1], v[2] + p.pos[2]];
}
