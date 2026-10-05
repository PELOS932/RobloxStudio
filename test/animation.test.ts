import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  animationLength, AnimationSpecSchema, buildTracks, ease, poseRig, RIGS, sampleTracks, sanitizeAnimationSpec, unsupportedJoints, type AnimationSpec,
} from "../src/shared/animation.ts";
import { animationToLuau } from "../src/shared/to-luau.ts";
import { animationToRbxmx } from "../src/shared/to-rbxmx.ts";

const LUNE = process.env.LUNE_BIN ?? "lune";
let luneAvailable = true;
try {
  execFileSync(LUNE, ["--version"], { stdio: "ignore" });
} catch {
  luneAvailable = false;
}

const starters: AnimationSpec[] = JSON.parse(readFileSync("examples/starter-animations.json", "utf8")).map((s: unknown) => sanitizeAnimationSpec(AnimationSpecSchema.parse(s)));
const byName = (n: string) => starters.find((s) => s.name === n)!;
const dir = mkdtempSync(join(tmpdir(), "forge-anim-"));

describe("animation specs", () => {
  it("parses the starter animations", () => {
    expect(starters.map((s) => s.name)).toEqual(["Idle Breathing", "Friendly Wave", "Walk Cycle", "Big Jump", "Sword Slash"]);
    expect(animationLength(byName("Walk Cycle"))).toBe(1);
  });

  it("merges keyframes at the same time and keeps them sorted", () => {
    const s = sanitizeAnimationSpec(AnimationSpecSchema.parse({
      name: "A", rig: "R15",
      keyframes: [{ t: 1, poses: { neck: [10, 0, 0] } }, { t: 0, poses: { neck: [0, 0, 0] } }, { t: 1, poses: { waist: [5, 0, 0] } }],
    }));
    expect(s.keyframes.map((k) => k.t)).toEqual([0, 1]);
    expect(Object.keys(s.keyframes[1].poses).sort()).toEqual(["neck", "waist"]);
  });

  it("interpolates each joint between the keyframes that pose it", () => {
    const s = sanitizeAnimationSpec(AnimationSpecSchema.parse({
      name: "A", rig: "R15",
      keyframes: [{ t: 0, poses: { neck: [0, 0, 0] } }, { t: 1, poses: { waist: [40, 0, 0] } }, { t: 2, poses: { neck: [40, 0, 0], waist: [0, 0, 0] } }],
    }));
    const mid = sampleTracks(buildTracks(s), 1);
    // neck: halfway between t=0 and t=2 → 20° about X
    expect(mid.neck!.rot[8]).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 6);
    expect(mid.waist!.rot[8]).toBeCloseTo(Math.cos((40 * Math.PI) / 180), 6);
  });

  it("eases like TweenService", () => {
    expect(ease("cubic", "in", 0.5)).toBeCloseTo(0.125, 6);
    expect(ease("cubic", "out", 0.5)).toBeCloseTo(0.875, 6);
    expect(ease("cubic", "inOut", 0.5)).toBeCloseTo(0.5, 6);
    expect(ease("constant", undefined, 0.9)).toBe(0);
    for (const style of ["linear", "cubic", "elastic", "bounce"] as const) {
      for (const d of ["in", "out", "inOut"] as const) expect(ease(style, d, 1)).toBeCloseTo(1, 6);
    }
  });

  it("knows which joints a rig can't play", () => {
    expect(unsupportedJoints(byName("Walk Cycle"), RIGS.R6).sort()).toEqual(["leftAnkle", "leftElbow", "leftKnee", "rightAnkle", "rightElbow", "rightKnee", "waist"]);
    expect(unsupportedJoints(byName("Sword Slash"), RIGS.R6)).toEqual([]);
  });

  it("raises a right arm sideways with positive z, and swings legs forward with positive x", () => {
    const world = poseRig(RIGS.R15, sampleTracks(buildTracks(byName("Friendly Wave")), 0));
    expect(world.get("RightUpperArm")!.pos[1]).toBeGreaterThan(4); // upper arm raised to the side…
    expect(world.get("RightHand")!.pos[1]).toBeGreaterThan(4.9); // …forearm up, hand above the head
    const walk = poseRig(RIGS.R15, sampleTracks(buildTracks(byName("Walk Cycle")), 0));
    expect(walk.get("RightFoot")!.pos[2]).toBeLessThan(-0.5); // forward is -Z
    expect(walk.get("LeftFoot")!.pos[2]).toBeGreaterThan(0.5);
  });
});

describe.skipIf(!luneAvailable)("animations in Studio (executed in Lune)", () => {
  const run = (spec: AnimationSpec, keyframe: number) => {
    const file = join(dir, `${Math.random().toString(36).slice(2)}.luau`);
    writeFileSync(file, animationToLuau(spec, { assetId: "a_test01", version: 1 }).code);
    const out = execFileSync(LUNE, ["run", join(import.meta.dirname, "lune", "anim-harness.luau"), file, String(keyframe)], { encoding: "utf8" });
    const line = (tag: string) => JSON.parse(out.split("\n").find((l) => l.startsWith(tag + " "))!.slice(tag.length + 1));
    return { parts: line("PARTS") as Record<string, number[]>, seq: line("SEQ") };
  };

  for (const name of ["Walk Cycle", "Big Jump", "Friendly Wave", "Sword Slash"]) {
    it(`poses the ${name} dummy exactly like the preview`, () => {
      const spec = byName(name);
      const rig = RIGS[spec.rig];
      const tracks = buildTracks(spec);
      // Keyframes that pose every animated joint (elsewhere Roblox interpolates the missing ones).
      const animated = new Set(spec.keyframes.flatMap((k) => Object.keys(k.poses)));
      const full = spec.keyframes.map((k, i) => (Object.keys(k.poses).length === animated.size ? i + 1 : 0)).filter(Boolean);
      expect(full.length).toBeGreaterThan(1);
      for (const k of full.slice(0, 3)) {
        const { parts, seq } = run(spec, k);
        expect(seq).toMatchObject({ name, keyframes: spec.keyframes.length, humanoid: spec.rig, motors: rig.joints.length });
        const preview = poseRig(rig, sampleTracks(tracks, spec.keyframes[k - 1].t));
        for (const part of rig.parts) {
          const want = preview.get(part.name)!;
          const got = parts[part.name];
          got.slice(0, 3).forEach((v, i) => expect(v, `${name} #${k} ${part.name} position`).toBeCloseTo(want.pos[i], 3));
          got.slice(3).forEach((v, i) => expect(v, `${name} #${k} ${part.name} rotation`).toBeCloseTo(want.rot[i], 4));
        }
      }
    });
  }

  it("keeps container poses out of the animation (Weight 0) and writes the easing", () => {
    const { seq } = run(byName("Walk Cycle"), 1);
    expect(seq.weights).toMatchObject({ HumanoidRootPart: 0, LowerTorso: 1, UpperTorso: 1, RightUpperArm: 1, RightLowerArm: 1 });
    expect(seq.loop).toBe(true);
    expect(seq.priority).toBe("Movement");
    expect(seq.style).toMatch(/^Cubic/);
    expect(seq.dir).toBe("InOut");
  });

  it("exports the same KeyframeSequence as .rbxmx", () => {
    const harness = join(import.meta.dirname, "lune", "harness.luau");
    const spec = byName("Big Jump");
    const dump = (mode: "luau" | "rbxmx", content: string) => {
      const file = join(dir, `${Math.random().toString(36).slice(2)}.${mode}`);
      writeFileSync(file, content);
      const out = execFileSync(LUNE, ["run", harness, mode, file, "ServerStorage"], { encoding: "utf8" });
      return out.slice(out.indexOf("DUMP\n") + 5).trim().split("\n");
    };
    const fromLuau = dump("luau", animationToLuau(spec, { assetId: "a_test01", version: 1 }).code)
      .filter((l) => l.includes("KeyframeSequence:"))
      .map((l) => l.replace(/^Model:RBX_ANIMSAVES\/ObjectValue:[^/]+\//, ""));
    const fromXml = dump("rbxmx", animationToRbxmx(spec, { assetId: "a_test01", version: 1 }));
    expect(fromLuau.length).toBeGreaterThan(10);
    expect(fromLuau.length).toBe(fromXml.length);
    // Same text; numbers equal up to float32 rounding.
    const split = (l: string) => ({ text: l.replace(/-?\d+(\.\d+)?/g, "#"), nums: (l.match(/-?\d+(\.\d+)?/g) ?? []).map(Number) });
    fromLuau.forEach((line, i) => {
      const a = split(line), b = split(fromXml[i]);
      expect(a.text).toBe(b.text);
      a.nums.forEach((n, k) => expect(Math.abs(n - b.nums[k])).toBeLessThan(2e-4));
    });
  });
});
