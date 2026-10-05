import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelSpecSchema, sanitizeModelSpec, type ModelSpec } from "../src/shared/model.ts";
import { modelToLuau } from "../src/shared/to-luau.ts";
import { pullSelectionLuau } from "../src/shared/studio-luau.ts";

// Checks the 3D translation against Roblox's own math (Lune's Roblox instance model):
// a model with every shape, axis, rotation order, material, light and group path is imported
// with the generated Luau, every part is read back from the instances, and the result is
// compared with frames Roblox computes from the spec with CFrame.Angles. Then the model is
// pulled back with the generated pull code and imported again, which must give the same parts.

const LUNE = process.env.LUNE_BIN ?? "lune";
let luneAvailable = true;
try {
  execFileSync(LUNE, ["--version"], { stdio: "ignore" });
} catch {
  luneAvailable = false;
}

type V3 = [number, number, number];
interface RbxPart {
  name: string;
  class: string;
  shape?: string;
  size: V3;
  pos: V3;
  right: V3;
  up: V3;
  back: V3;
  color: V3;
  material: string;
  transparency: number;
  reflectance: number;
  anchored: boolean;
  canCollide: boolean;
  canTouch: boolean;
  castShadow: boolean;
  group: string;
  light?: { class: string; color: V3; brightness: number; range: number; shadows: boolean; angle?: number; face?: string };
}
type Frame = { pos: V3; x: V3; y: V3; z: V3 };

const probe: ModelSpec = {
  name: "Probe",
  parts: [
    { name: "Floor", size: [20, 1, 20], pos: [0, 0.5, 0], color: "#6b8f4e", material: "Grass" },
    { name: "Tilted", size: [2, 1, 4], pos: [-6, 3, -6], rot: [30, 0, 15], color: "#a0522d", material: "Brick" },
    { name: "Spun", size: [3, 2, 1], pos: [6, 2, -6], rot: [0, 45, 0], material: "Metal", reflectance: 0.3 },
    { name: "Compound", size: [1, 3, 2], pos: [0, 4, 6], rot: [-45, 120, 10], material: "Wood", transparency: 0.25 },
    { name: "Bulb", shape: "ball", size: [2, 2, 2], pos: [-6, 2, 6], color: "#ffcc66", material: "Neon", collide: false, light: { type: "point", range: 18, brightness: 2, color: "#ffd9a0" } },
    { name: "CylX", shape: "cylinder", size: [4, 1, 1], pos: [6, 1, 6], material: "Concrete" },
    { name: "CylY", shape: "cylinder", axis: "y", size: [1, 5, 1], pos: [8, 3, 0], material: "Concrete" },
    { name: "CylZ", shape: "cylinder", axis: "z", size: [1.5, 1.5, 6], pos: [-8, 1, 0], material: "Slate" },
    { name: "CylYTilted", shape: "cylinder", axis: "y", size: [0.8, 4, 0.8], pos: [0, 3, -8], rot: [20, 30, 0], material: "Metal" },
    { name: "Ramp", shape: "wedge", size: [4, 2, 6], pos: [0, 2, 0], rot: [0, 90, 0], material: "Cobblestone" },
    { name: "RoofL", shape: "wedge", size: [6, 2, 3], pos: [0, 8, 1.5], rot: [0, 180, 0], material: "Slate", group: "House/Roof" },
    { name: "Lamp", size: [0.5, 0.5, 0.5], pos: [3, 6, 3], group: "House", light: { type: "spot", angle: 60, face: "Bottom", range: 20, shadows: true } },
    { name: "Panel", size: [2, 2, 0.2], pos: [-3, 6, 3], group: "House", light: { type: "surface", face: "Front", angle: 120, brightness: 3 } },
    { name: "Window", size: [4, 3, 0.2], pos: [0, 3, -3], color: "#9fd3ff", material: "Glass", transparency: 0.5 },
    { name: "Shield", size: [2, 2, 2], pos: [9, 1, 9], color: "#66ccff", material: "ForceField" },
  ],
};

const dir = mkdtempSync(join(tmpdir(), "forge-roundtrip-"));
const pullFile = join(dir, "pull.luau");
writeFileSync(pullFile, pullSelectionLuau());

function run(spec: ModelSpec, placement: "keep" | "origin") {
  const importFile = join(dir, `${Math.random().toString(36).slice(2)}.luau`);
  const specFile = `${importFile}.json`;
  writeFileSync(importFile, modelToLuau(spec, { placement, select: false, optimize: false }).code);
  writeFileSync(specFile, JSON.stringify(spec));
  const out = execFileSync(LUNE, ["run", join(import.meta.dirname, "lune", "roundtrip-harness.luau"), importFile, pullFile, specFile], { encoding: "utf8" });
  const line = (tag: string) => JSON.parse(out.split("\n").find((l) => l.startsWith(tag + " "))!.slice(tag.length + 1));
  const parts: RbxPart[] = line("PARTS");
  return { parts: Object.fromEntries(parts.map((p) => [p.name, p])), count: parts.length, expect: line("EXPECT") as Record<string, Frame>, pull: line("PULL") };
}

const near = (a: number[], b: number[], eps = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const parallel = (a: number[], b: number[]) => Math.abs(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) - 1) < 1e-4;
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe.skipIf(!luneAvailable)("3D models: spec → Roblox instances → spec (executed in Lune)", () => {
  const spec = sanitizeModelSpec(ModelSpecSchema.parse(probe));
  const first = luneAvailable ? run(spec, "keep") : (null as never);

  it("creates every part with the right class, shape and group", () => {
    expect(first.count).toBe(spec.parts.length);
    for (const p of spec.parts) {
      const r = first.parts[p.name!];
      const shape = p.shape ?? "block";
      expect(r.class, p.name).toBe(shape === "wedge" ? "WedgePart" : "Part");
      if (shape !== "wedge") expect(r.shape, p.name).toBe({ block: "Block", ball: "Ball", cylinder: "Cylinder" }[shape]);
      expect(r.group, p.name).toBe(p.group ?? "");
    }
  });

  it("puts each part where Roblox's CFrame.Angles says it goes", () => {
    for (const p of spec.parts) {
      const r = first.parts[p.name!];
      const e = first.expect[p.name!];
      expect(near(r.pos, e.pos), `${p.name} position ${r.pos} vs ${e.pos}`).toBe(true);
      if (p.shape === "cylinder" && p.axis && p.axis !== "x") {
        // The cylinder's length (Roblox's local X) must run along the spec's rotated axis.
        expect(parallel(r.right, p.axis === "y" ? e.y : e.z), `${p.name} axis`).toBe(true);
        expect(r.size[0]).toBeCloseTo(p.axis === "y" ? p.size[1] : p.size[2], 4);
        expect(r.size[1]).toBeCloseTo(Math.min(p.size[0], p.axis === "y" ? p.size[2] : p.size[1]), 4);
        expect(r.size[2]).toBeCloseTo(r.size[1], 4);
      } else {
        expect(near(r.right, e.x) && near(r.up, e.y) && near(r.back, e.z), `${p.name} rotation`).toBe(true);
        expect(near(r.size, p.size, 1e-4), `${p.name} size ${r.size}`).toBe(true);
      }
    }
  });

  it("keeps colour, material, transparency, reflectance and collision", () => {
    for (const p of spec.parts) {
      const r = first.parts[p.name!];
      expect(r.color, p.name).toEqual(rgb(p.color ?? "#a3a2a5"));
      expect(r.material, p.name).toBe(p.material ?? "Plastic");
      expect(r.transparency).toBeCloseTo(p.transparency ?? 0, 4);
      expect(r.reflectance).toBeCloseTo(p.reflectance ?? 0, 4);
      expect(r.canCollide, p.name).toBe(p.collide ?? true);
      expect(r.anchored, p.name).toBe(true);
    }
    // Static-geometry defaults: no touch events, no shadows from neon or tiny parts.
    expect(first.parts.Floor).toMatchObject({ canTouch: false, castShadow: true });
    expect(first.parts.Bulb.castShadow).toBe(false);
    expect(first.parts.Lamp.castShadow).toBe(false);
  });

  it("creates lights with their settings", () => {
    expect(first.parts.Bulb.light).toEqual({ class: "PointLight", color: rgb("#ffd9a0"), brightness: 2, range: 18, shadows: false });
    expect(first.parts.Lamp.light).toMatchObject({ class: "SpotLight", angle: 60, face: "Bottom", range: 20, shadows: true, color: [255, 255, 255] });
    expect(first.parts.Panel.light).toMatchObject({ class: "SurfaceLight", angle: 120, face: "Front", brightness: 3, range: 12 });
  });

  it("pulls the model back into a spec that rebuilds the same parts", () => {
    expect(first.pull.kind).toBe("model");
    expect(Object.keys(first.pull.skipped)).toHaveLength(0); // an empty Luau table encodes as {}
    const pulled = sanitizeModelSpec(ModelSpecSchema.parse(first.pull.spec));
    expect(pulled.parts.map((p) => p.name).sort()).toEqual(spec.parts.map((p) => p.name).sort());

    // Both imported at the origin, the original and the pulled copy must coincide.
    const a = run(spec, "origin");
    const b = run(pulled, "origin");
    for (const name of Object.keys(a.parts)) {
      const pa = a.parts[name];
      const pb = b.parts[name];
      for (const k of ["pos", "size", "right", "up", "back"] as const) {
        expect(near(pa[k], pb[k], 0.01), `${name}.${k}: ${pa[k]} vs ${pb[k]}`).toBe(true);
      }
      const { pos: _p, size: _s, right: _r, up: _u, back: _b, transparency: ta, reflectance: ra, light: la, ...restA } = pa;
      const { pos: _p2, size: _s2, right: _r2, up: _u2, back: _b2, transparency: tb, reflectance: rb, light: lb, ...restB } = pb;
      expect(restB, name).toEqual(restA);
      expect(tb).toBeCloseTo(ta, 3);
      expect(rb).toBeCloseTo(ra, 3);
      if (la || lb) {
        const { brightness: ba, ...la2 } = la!;
        const { brightness: bb, ...lb2 } = lb!;
        expect(lb2, `${name} light`).toEqual(la2);
        expect(bb).toBeCloseTo(ba, 3);
      }
    }
  });
});
