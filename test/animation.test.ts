import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  animationLength, AnimationSpecSchema, applyAnimationEdit, bakedKeyframes, buildTracks, checkAnimation, ease, poseRig, RIGS, sampleTracks, sanitizeAnimationSpec,
  unsupportedJoints, type AnimationSpec,
} from "../src/shared/animation.ts";
import { namedPose, POSE_NAMES } from "../src/shared/poses.ts";
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

  it("builds keyframes from named poses, copies and mirrors", () => {
    const s = sanitizeAnimationSpec(AnimationSpecSchema.parse({
      name: "Combo", rig: "R15", loop: false,
      keyframes: [
        { t: 0, pose: "guard" },
        { t: 0.2, pose: "punch", poses: { neck: [5, 0, 0] } },
        { t: 0.4, from: 0.2, mirror: true },
        { t: 0.6, from: 0 },
      ],
    }));
    const [guard, punch, left, back] = s.keyframes;
    expect(guard.poses).toEqual(namedPose("guard"));
    expect(punch.poses.rightShoulder).toEqual([90, 0, 25]);
    expect(punch.poses.neck).toEqual([5, 0, 0]);
    // The mirrored punch is thrown with the left arm, turning the other way.
    expect(left.poses.leftShoulder).toEqual([90, 0, -25]);
    expect(left.poses.rightShoulder).toEqual([45, 0, -15]);
    expect(left.poses.waist).toEqual([-5, -25, 0]);
    expect(left.poses.neck).toEqual([5, 0, 0]);
    expect(back.poses).toEqual(guard.poses);
    for (const k of s.keyframes) expect(Object.keys(k).sort()).not.toContain("pose");
    // R6 keeps only the joints it has.
    const r6 = sanitizeAnimationSpec(AnimationSpecSchema.parse({ name: "P", rig: "R6", keyframes: [{ t: 0, pose: "punch" }] }));
    expect(unsupportedJoints(r6, RIGS.R6)).toEqual([]);
    expect(() => sanitizeAnimationSpec(AnimationSpecSchema.parse({ name: "X", rig: "R15", keyframes: [{ t: 0, from: 3 }] }))).toThrow(/No keyframe at 3s/);
  });

  it("every named pose keeps the knees and elbows bending the right way and stays on the floor", () => {
    for (const name of POSE_NAMES) {
      const spec = sanitizeAnimationSpec(AnimationSpecSchema.parse({ name, rig: "R15", loop: false, keyframes: [{ t: 0, pose: name }, { t: 1, pose: name }] }));
      const issues = checkAnimation(spec).filter((l) => !(name === "jump" && /never touch/.test(l)));
      expect(issues, name).toEqual([]);
    }
  });

  it("rebuilds a keyframe when an edit brings a named pose", () => {
    const base = sanitizeAnimationSpec(AnimationSpecSchema.parse({ name: "E", rig: "R15", keyframes: [{ t: 0, poses: { neck: [30, 0, 0], waist: [10, 0, 0] } }] }));
    const { spec } = applyAnimationEdit(base, { keyframes: [{ t: 0, pose: "cheer", poses: {} }] });
    expect(spec.keyframes[0].poses).toEqual(namedPose("cheer"));
    const merged = applyAnimationEdit(base, { keyframes: [{ t: 0, poses: { waist: [0, 0, 0] } }] }).spec;
    expect(merged.keyframes[0].poses).toEqual({ neck: [30, 0, 0], waist: [0, 0, 0] });
  });

  it("follow-through delays the arms and head, and keeps loops seamless", () => {
    const loop = sanitizeAnimationSpec(AnimationSpecSchema.parse({
      name: "Swing", rig: "R15", overlap: 0.05,
      keyframes: [
        { t: 0, poses: { waist: [0, 0, 0], rightShoulder: [0, 0, 0], rightElbow: [0, 0, 0] } },
        { t: 0.5, poses: { waist: [-20, 0, 0], rightShoulder: [60, 0, 0], rightElbow: [40, 0, 0] } },
        { t: 1, poses: { waist: [0, 0, 0], rightShoulder: [0, 0, 0], rightElbow: [0, 0, 0] } },
      ],
    }));
    const baked = bakedKeyframes(loop);
    const at = (t: number, j: string) => baked.find((k) => Math.abs(k.t - t) < 1e-6)?.poses[j as "waist"];
    expect(at(0.5, "waist")).toEqual([-20, 0, 0]);
    expect(at(0.55, "rightShoulder")).toEqual([60, 0, 0]);
    expect(at(0.6, "rightElbow")).toEqual([40, 0, 0]);
    expect(animationLength(loop)).toBe(1);
    // The start and end match for every joint, so the loop doesn't jump.
    const tracks = buildTracks(loop);
    const a = sampleTracks(tracks, 0), b = sampleTracks(tracks, 1);
    for (const j of Object.keys(a) as (keyof typeof a)[]) for (let i = 0; i < 9; i++) expect(b[j]!.rot[i]).toBeCloseTo(a[j]!.rot[i], 5);
    expect(checkAnimation(loop)).toEqual([]);
    // A one-shot lasts until the hands settle.
    expect(animationLength({ ...loop, loop: false })).toBeCloseTo(1.15, 6);
  });

  it("reports joints bent the wrong way, feet in the floor and loops that jump", () => {
    const bad = sanitizeAnimationSpec(AnimationSpecSchema.parse({
      name: "Bad", rig: "R15",
      keyframes: [
        { t: 0, poses: { root: { pos: [0, -1, 0] }, rightKnee: [30, 0, 0] } },
        { t: 1, poses: { root: { pos: [0, 0, 0] }, rightElbow: [-40, 0, 0], neck: [0, 0, 0] } },
      ],
    }));
    const lines = checkAnimation(bad);
    expect(lines[0]).toMatch(/^rightKnee bends backward \(x 30\) at 0s/);
    expect(lines[1]).toMatch(/^rightElbow bends backward/);
    expect(lines.some((l) => /feet go [\d.]+ studs into the floor at 0s/.test(l))).toBe(true);
    expect(lines.some((l) => /jumps when it loops \(root/.test(l))).toBe(true);
    expect(checkAnimation(byName("Walk Cycle"))).toEqual([]);
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
