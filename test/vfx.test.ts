import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyVfxEdit, colorKeys, isOneShot, numberKeys, oneShotLength, sampleColor, sampleNumber, sanitizeVfxSpec, textureUrl, VfxSpecSchema,
  vfxSummary, vfxTree, type VfxSpec,
} from "../src/shared/vfx.ts";
import { expandVfxInput } from "../src/shared/vfx-presets.ts";
import { vfxToLuau } from "../src/shared/to-luau.ts";
import { vfxToRbxmx } from "../src/shared/to-rbxmx.ts";
import type { InstNode } from "../src/shared/instance-tree.ts";

const LUNE = process.env.LUNE_BIN ?? "lune";
let luneAvailable = true;
try {
  execFileSync(LUNE, ["--version"], { stdio: "ignore" });
} catch {
  luneAvailable = false;
}

const starters = (JSON.parse(readFileSync("examples/starter-vfx.json", "utf8")) as unknown[]).map((raw) => sanitizeVfxSpec(VfxSpecSchema.parse(raw)));
const byName = (n: string) => starters.find((s) => s.name === n)!;

function find(node: InstNode, name: string, className?: string): InstNode | undefined {
  if (node.name === name && (!className || node.className === className)) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, name, className);
    if (hit) return hit;
  }
  return undefined;
}

describe("vfx specs", () => {
  it("reads sequences the way Roblox does", () => {
    expect(numberKeys(2, 1)).toEqual([{ t: 0, v: 2, e: 0 }, { t: 1, v: 2, e: 0 }]);
    expect(numberKeys([1, 3], 0).map((k) => k.v)).toEqual([1, 3]);
    const keys = numberKeys([[0.5, 4], [0.2, 2, 0.5], [0.9, 0]], 0);
    expect(keys.map((k) => k.t)).toEqual([0, 0.5, 1]); // sorted, first at 0, last at 1
    expect(keys[0]).toMatchObject({ v: 2, e: 0.5 });
    expect(sampleNumber(numberKeys([0, 10], 0), 0.25)).toBeCloseTo(2.5);
    const c = colorKeys(["#000000", "#ff8000"]);
    expect(sampleColor(c, 0.5)).toEqual([127.5, 64, 0]);
    expect(textureUrl("fire")).toBe("rbxasset://textures/particles/fire_main.dds");
    expect(textureUrl("rbxassetid://123")).toBe("rbxassetid://123");
  });

  it("ships valid starter effects", () => {
    expect(starters.map((s) => s.name)).toEqual(["Campfire", "Magic Aura", "Explosion", "Portal", "Sword Slash Trail", "Lightning Arc", "Snowfall", "Healing Pickup"]);
    expect(isOneShot(byName("Explosion"))).toBe(true);
    expect(isOneShot(byName("Campfire"))).toBe(false);
    expect(oneShotLength(byName("Explosion"))).toBeCloseTo(3.15);
    expect(vfxSummary(byName("Campfire"))).toBe("3 emitters · 1 light");
  });

  it("edits emitters by name, scales and renames", () => {
    const base = byName("Campfire");
    const { spec, missing } = applyVfxEdit(base, {
      update: [{ name: "Embers", rate: 30, drag: null }, { name: "Glow", rename: "Warmth", brightness: 4 }, { name: "Nope", rate: 1 }],
      remove: ["Smoke"],
      add: [{ name: "Sparks", type: "sparkles", pos: [0, 1, 0] }],
    });
    expect(missing).toEqual(["Nope"]);
    expect(spec.emitters.map((e) => e.name)).toEqual(["Flames", "Embers", "Warmth", "Sparks"]);
    const embers = spec.emitters[1];
    expect(embers).toMatchObject({ rate: 30 });
    expect("drag" in embers).toBe(false);
    const big = applyVfxEdit(base, { scale: 2 }).spec;
    expect(big.emitters[0]).toMatchObject({ pos: [0, 0.8, 0], shapeSize: [3.2, 0.4, 3.2] });
    expect((big.emitters[3] as { range: number }).range).toBe(32);
    expect(() => applyVfxEdit(base, { remove: base.emitters.map((e) => e.name) })).toThrow(/at least one/);
  });

  it("expands emitter presets with overrides (a burst makes a one-shot, a rate a stream)", () => {
    const spec = sanitizeVfxSpec(VfxSpecSchema.parse({
      name: "Torch",
      emitters: [
        { name: "Fire", type: "particles", preset: "flames", rate: 20, pos: [0, 2, 0] },
        { name: "Pop", type: "particles", preset: "embers", burst: 10 },
        { name: "Crackle", type: "particles", preset: "sparks", rate: 6 },
      ],
    }));
    const [fire, pop, crackle] = spec.emitters as Extract<VfxSpec["emitters"][number], { type: "particles" }>[];
    expect(fire).toMatchObject({ texture: "fire", rate: 20, pos: [0, 2, 0], lightEmission: 1 });
    expect("preset" in fire).toBe(false);
    expect(pop).toMatchObject({ texture: "spark", rate: 0, burst: 10 });
    expect(crackle.rate).toBe(6);
    expect(crackle.burst).toBeUndefined();
    // Sanitizing again changes nothing.
    expect(sanitizeVfxSpec(spec)).toEqual(spec);
  });

  it("builds whole effects from presets, scaled and tinted to a new hue", () => {
    const blue = expandVfxInput({ preset: "explosion", tint: "#3fa0ff", scale: 0.5 });
    expect(blue.name).toBe("Explosion");
    expect(blue.emitters.map((e) => e.name)).toEqual(["Flash", "Shockwave", "Fireball", "Smoke", "Sparks"]);
    expect(blue.emitters[0]).toMatchObject({ size: [[0, 2], [1, 6]] });
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
      const h = max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return ((h * 60) % 360 + 360) % 360;
    };
    const fireball = blue.emitters[2] as { color: [number, string][] };
    for (const [, c] of fireball.color) expect(Math.abs(hue(c) - 210)).toBeLessThan(25);
    // Smoke stays a dark grey (its faint warmth turns cool); one-shot timing comes along.
    const smoke = (blue.emitters[3] as { color: string }).color;
    const ch = [1, 3, 5].map((i) => parseInt(smoke.slice(i, i + 2), 16));
    expect(Math.max(...ch) - Math.min(...ch)).toBeLessThan(12);
    expect(ch[2]).toBeGreaterThan(ch[0]);
    expect(isOneShot(blue)).toBe(true);
    const grey = expandVfxInput({ preset: "campfire", name: "Ash Fire", tint: "#808080" });
    expect(grey.name).toBe("Ash Fire");
    const flames = grey.emitters[0] as { color: [number, string][] };
    for (const [, c] of flames.color) expect(c.slice(1, 3)).toBe(c.slice(3, 5));
  });

  it("adds to a preset or replaces its emitters by name", () => {
    const spec = expandVfxInput({
      preset: "campfire", name: "Blue Fire",
      emitters: [{ name: "Glow", type: "light", color: "#66ccff" }, { name: "Spark", type: "sparkles" }],
    });
    expect(spec.emitters.map((e) => e.name)).toEqual(["Flames", "Embers", "Smoke", "Glow", "Spark"]);
    expect(spec.emitters[3]).toMatchObject({ color: "#66ccff", brightness: 2.5, range: 16 });
    expect(() => expandVfxInput({ name: "Empty" })).toThrow(/emitters, or a preset/);
    expect(applyVfxEdit(byName("Campfire"), { tint: "#3fa0ff" }).spec.emitters[3]).not.toMatchObject({ color: "#ff9a4a" });
  });

  it("builds Roblox instances: attachments on an invisible root, parts for shaped emitters", () => {
    const tree = vfxTree(byName("Campfire"));
    expect(tree).toMatchObject({ className: "Model", name: "Campfire", props: { PrimaryPart: { ref: "root" } } });
    const root = find(tree, "Root", "Part")!;
    expect(root.props).toMatchObject({ Anchored: true, CanCollide: false, Transparency: 1 });
    // Disc-shaped flames get their own emitting part; embers sit on an attachment.
    expect(find(tree, "Flames", "Part")!.props).toMatchObject({ Size: { v3: [1.6, 0.2, 1.6] } });
    expect(find(tree, "Flames", "ParticleEmitter")!.props).toMatchObject({ Shape: { enum: "ParticleEmitterShape", item: "Disc" }, LightEmission: 1, Rate: 45 });
    expect(find(root, "Embers", "Attachment")!.props).toMatchObject({ CFrame: { cf: { pos: [0, 0.6, 0] } } });
    // One-shots: Rate 0, EmitCount attributes and a Play module.
    const boom = vfxTree(byName("Explosion"));
    expect(find(boom, "Sparks", "ParticleEmitter")).toMatchObject({ props: { Rate: 0 }, attrs: { EmitCount: 40 } });
    expect(find(boom, "Smoke", "ParticleEmitter")!.attrs).toEqual({ EmitCount: 14, EmitDelay: 0.15 });
    expect(find(boom, "Play", "ModuleScript")!.source).toMatch(/:Emit\(/);
    // Beams link two attachments whose X axis points up (curves bend up).
    const arc = vfxTree(byName("Lightning Arc"));
    expect(find(arc, "Bolt", "Beam")!.props).toMatchObject({ Attachment0: { ref: "Bolt#0" }, Attachment1: { ref: "Bolt#1" }, CurveSize0: 3, CurveSize1: -3, Segments: { int: 30 } });
    expect(find(arc, "Bolt0", "Attachment")!.props!.CFrame).toEqual({ cf: { pos: [-6, 3, 0], rot: [0, -1, 0, 1, 0, 0, 0, 0, 1] } });
  });

  it("generates compact import code", () => {
    for (const s of starters) {
      const { code } = vfxToLuau(s, { assetId: "v_test01", version: 1 });
      expect(code.length).toBeLessThan(16_000);
      expect(code).not.toMatch(/\bundefined\b|NaN/);
    }
  });
});

describe.skipIf(!luneAvailable)("vfx in Studio (executed in Lune)", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-vfx-"));
  const harness = join(import.meta.dirname, "lune", "vfx-harness.luau");

  const run = (spec: VfxSpec) => {
    const code = join(dir, "import.luau");
    const xml = join(dir, "effect.rbxmx");
    writeFileSync(code, vfxToLuau(spec, { assetId: "v_test01", version: 1, placement: "origin", select: false }).code);
    writeFileSync(xml, vfxToRbxmx(spec, { assetId: "v_test01", version: 1 }));
    const out = execFileSync(LUNE, ["run", harness, code, xml], { encoding: "utf8" });
    const pick = (tag: string) => JSON.parse(out.split("\n").find((l) => l.startsWith(tag + " "))!.slice(tag.length + 1));
    return { imported: pick("IMPORTED"), exported: pick("EXPORTED") };
  };

  it.each(starters.map((s) => [s.name, s] as const))("%s: the import and the .rbxmx build the same instances", (_name, spec) => {
    const { imported, exported } = run(spec);
    expect(Object.keys(imported).sort()).toEqual(Object.keys(exported).sort());
    for (const path of Object.keys(imported)) {
      expect(exported[path], path).toEqual(imported[path]);
    }
  });

  it("sets particle properties exactly", () => {
    const { imported } = run(byName("Campfire"));
    const embers = imported["Root.Embers.Embers"];
    expect(embers.class).toBe("ParticleEmitter");
    expect(embers.props).toMatchObject({
      Rate: 14, Lifetime: [1.2, 2.2], Speed: [4, 7], SpreadAngle: [25, 25], Drag: 1, LightEmission: 1, Acceleration: [0, 1.5, 0], EmissionDirection: "Top",
    });
    expect(embers.props.Size).toEqual([[0, 0.18, 0], [1, 0.05, 0]]);
    expect(imported["Smoke" in imported ? "Smoke" : "Root.Smoke.Smoke"].props.Rotation).toEqual([0, 360]);
    expect(imported["Root.Glow.Glow"]).toMatchObject({ class: "PointLight", props: { Range: 16, Brightness: 2.5 } });
    expect(imported["."].props.PrimaryPart).toBe("@Root");
  });
});
