import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  abilityLength, abilityRefs, AbilitySpecSchema, applyAbilityEdit, expandAbilityInput, resolveAbility, sanitizeAbilitySpec, type AbilitySpec,
} from "../src/shared/ability.ts";
import { abilityTrees, animationHash, playSource, standaloneTool } from "../src/shared/ability-studio.ts";
import { abilityToLuau } from "../src/shared/to-luau.ts";
import { abilityToRbxmx } from "../src/shared/to-rbxmx.ts";
import { sanitizeVfxSpec, VfxSpecSchema } from "../src/shared/vfx.ts";
import { bakedKeyframes, sanitizeAnimationSpec, AnimationSpecSchema, RIGS } from "../src/shared/animation.ts";

const LUNE = process.env.LUNE_BIN ?? "lune";
let luneAvailable = true;
try {
  execFileSync(LUNE, ["--version"], { stdio: "ignore" });
} catch {
  luneAvailable = false;
}

const starters = (JSON.parse(readFileSync("examples/starter-abilities.json", "utf8")) as unknown[]).map((raw) => sanitizeAbilitySpec(AbilitySpecSchema.parse(raw)));
const byName = (n: string) => starters.find((s) => s.name === n)!;
const none = () => undefined;

describe("ability specs", () => {
  it("ships valid starter abilities with sensible lengths", () => {
    expect(starters.map((s) => s.name)).toEqual(["Fireball", "Lightning Strike", "Healing Aura", "Ground Slam", "Frost Nova", "Blade Slash", "Stand Barrage", "Spirit Sword", "Earth Wall"]);
    for (const s of starters) {
      const r = resolveAbility(s, none);
      expect(r.missing).toEqual([]);
      expect(r.length).toBeGreaterThan(1);
      expect(r.length).toBeLessThan(6);
    }
    expect(byName("Frost Nova").rig).toBe("R6");
  });

  it("sorts events, names inline effects and gives templates unique names", () => {
    const spec = sanitizeAbilitySpec(AbilitySpecSchema.parse({
      name: "Twin", rig: "R15",
      events: [
        { at: 0.5, vfx: { emitters: [{ name: "A", type: "sparkles" }] } },
        { name: "Spark", at: 0.2, vfx: { emitters: [{ name: "A", type: "sparkles" }] } },
        { name: "Spark", at: 0.3, vfx: { emitters: [{ name: "A", type: "sparkles" }] }, travel: { velocity: [0, 0, -10] }, impact: { emitters: [{ name: "B", type: "sparkles" }] } },
      ],
    }));
    expect(spec.events.map((e) => e.at)).toEqual([0.2, 0.3, 0.5]);
    const r = resolveAbility(spec, none);
    expect(r.events.map((e) => [e.templateName, e.impactName])).toEqual([["Spark", undefined], ["Spark 2", "Spark Impact"], ["Twin", undefined]]);
  });

  it("resolves library references and reports missing ones", () => {
    const vfx = sanitizeVfxSpec(VfxSpecSchema.parse({ name: "Glow", emitters: [{ name: "G", type: "particles", lifetime: 2, rate: 5 }] }));
    const anim = sanitizeAnimationSpec(AnimationSpecSchema.parse({ name: "Wave", rig: "R15", keyframes: [{ t: 0, poses: {} }, { t: 2.5, poses: { neck: [10, 0, 0] } }] }));
    const lib: Record<string, { kind: string; spec: unknown }> = { v_glow01: { kind: "vfx", spec: vfx }, a_wave01: { kind: "animation", spec: anim } };
    const spec: AbilitySpec = { name: "Ref", rig: "R15", animation: "a_wave01", events: [{ at: 1, vfx: "v_glow01", scale: 2 }, { at: 0, vfx: "v_nope00" }] };
    expect(abilityRefs(spec).sort()).toEqual(["a_wave01", "v_glow01", "v_nope00"]);
    const r = resolveAbility(spec, (id) => lib[id]);
    expect(r.missing).toEqual(["v_nope00"]);
    expect(r.animation?.name).toBe("Wave");
    // Scaled copy of the library effect; the length covers its 2 s particles after a 1 s run.
    expect(r.events[0].vfx.emitters[0]).toMatchObject({ size: 2, speed: 10 });
    expect(r.length).toBe(4);
    expect(abilityLength({ ...r, spec: { ...spec, length: 1.5 } })).toBe(1.5);
  });

  it("edits events by index", () => {
    const base = byName("Fireball");
    const { spec, missing } = applyAbilityEdit(base, { update: [{ index: 1, duration: 2, offset: null }, { index: 9, at: 1 }], add: [{ at: 0.1, vfx: "v_abcdef", attach: "leftHand" }], cooldown: 3 });
    expect(missing).toEqual([9]);
    expect(spec.events.map((e) => e.at)).toEqual([0, 0.1, 0.45]);
    expect(spec.events[2]).toMatchObject({ duration: 2, name: "Fireball" });
    expect("offset" in spec.events[2]).toBe(false);
    expect(spec.cooldown).toBe(3);
    expect(() => applyAbilityEdit(base, { remove: [0, 1] })).toThrow(/at least one/);
  });

  it("accepts preset effects inline, tinted and scaled, and tints a whole ability", () => {
    const spec = sanitizeAbilitySpec(expandAbilityInput({
      name: "Blue Blast", rig: "R15",
      events: [
        { at: 0.6, vfx: { preset: "explosion", tint: "#3fa0ff", scale: 0.5 }, attach: "ground" },
        { name: "Bolt", at: 0.2, vfx: { emitters: [{ name: "Core", type: "particles", preset: "glow", size: 1.5 }] }, travel: { velocity: [0, 0, -40] }, impact: { preset: "explosion", scale: 0.4 } },
      ],
    }));
    const [bolt, blast] = spec.events;
    expect(typeof bolt.vfx !== "string" && bolt.vfx.name).toBe("Bolt");
    expect(typeof bolt.vfx !== "string" && bolt.vfx.emitters[0]).toMatchObject({ texture: "glow", size: 1.5, locked: true });
    expect(typeof bolt.impact !== "string" && bolt.impact?.name).toBe("Bolt Impact");
    expect(typeof blast.vfx !== "string" && blast.vfx.name).toBe("Explosion");
    expect(resolveAbility(spec, none).missing).toEqual([]);
    const red = applyAbilityEdit(spec, { tint: "#ff3030", update: [{ index: 1, vfx: { preset: "campfire" } }] }).spec;
    const campfire = red.events[1].vfx;
    expect(typeof campfire !== "string" && campfire.emitters.map((e) => e.name)).toEqual(["Flames", "Embers", "Smoke", "Glow"]);
    expect(typeof red.events[0].impact !== "string" && red.events[0].impact?.emitters[0]).not.toMatchObject({ color: "#fff1c1" });
  });

  it("builds a Studio folder, a Tool and a data-driven Play module", () => {
    const r = resolveAbility(byName("Fireball"), none);
    const { folder, tool } = abilityTrees(r);
    expect(folder.children!.map((c) => [c.className, c.name])).toEqual([["KeyframeSequence", "Animation"], ["Folder", "Effects"], ["ModuleScript", "Play"]]);
    expect(folder.children![1].children!.map((c) => c.name)).toEqual(["Charge", "Fireball", "Fireball Impact"]);
    expect(folder.attrs).toEqual({ AnimationId: "", AnimationHash: animationHash(r.animation) });
    expect(tool).toMatchObject({ className: "Tool", name: "Fireball", props: { RequiresHandle: false } });
    expect(tool.children!.map((c) => c.name)).toEqual(["Cast"]);
    expect(standaloneTool(r).children!.map((c) => c.name)).toEqual(["Cast", "Animation", "Effects", "Play"]);
    const play = playSource(r);
    expect(play).toContain('effect = "Fireball"');
    expect(play).toContain('impact = "Fireball Impact"');
    expect(play).toMatch(/velocity = \{ 0, -2\.5, -48 \}/);
    expect(play).toContain("RegisterKeyframeSequence");
    expect(animationHash(r.animation)).not.toBe(animationHash(resolveAbility(byName("Blade Slash"), none).animation));
  });
});

describe.skipIf(!luneAvailable)("abilities in Studio (executed in Lune)", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-ability-"));
  const harness = join(import.meta.dirname, "lune", "ability-harness.luau");
  const run = (spec: AbilitySpec) => {
    const r = resolveAbility(spec, none);
    const code = join(dir, "import.luau"), xml = join(dir, "tool.rbxmx");
    writeFileSync(code, abilityToLuau(r, { assetId: "b_test01", version: 1, select: false }).code);
    writeFileSync(xml, abilityToRbxmx(r, { assetId: "b_test01", version: 1 }));
    const out = execFileSync(LUNE, ["run", harness, code, xml], { encoding: "utf8" });
    const pick = (tag: string) => JSON.parse(out.split("\n").find((l) => l.startsWith(tag + " "))!.slice(tag.length + 1));
    return { r, imported: pick("IMPORTED"), exported: pick("EXPORTED") };
  };

  it.each(starters.map((s) => [s.name, s] as const))("%s: import and .rbxmx build the same ability, and its scripts compile", (_name, spec) => {
    const { r, imported, exported } = run(spec);
    expect(imported.play).toBe("ok");
    expect(imported.tool).toMatchObject({ name: spec.name, requiresHandle: false, cast: "ok", children: 1 });
    expect(imported.attrs).toEqual({ AnimationId: "", hash: true });
    expect(exported.tool).toMatchObject({ class: "Tool", cast: "ok" });
    expect(exported.play).toBe("ok");
    expect(exported.animation).toEqual(imported.animation);
    expect(exported.effects).toEqual(imported.effects);
    expect(imported.animation.keyframes).toHaveLength(bakedKeyframes(r.animation!).length);
    expect(exported.summons).toEqual(imported.summons);
    expect(exported.props).toEqual(imported.props);
    expect(Object.keys(imported.summons ?? {})).toEqual(r.summons.map((m) => m.templateName));
    expect(Object.keys(imported.props ?? {})).toEqual(r.props.map((p) => p.templateName));
    expect(imported.animation.loop).toBe(false);
    expect(Object.keys(imported.effects).sort()).toEqual([
      ...r.events.flatMap((e) => [e.templateName, ...(e.impactName ? [e.impactName] : [])]),
      ...r.summons.flatMap((m) => (m.auraName ? [m.auraName] : [])),
      ...r.props.flatMap((p) => (p.impactName ? [p.impactName] : [])),
    ].sort());
  });
});

describe.skipIf(!luneAvailable)("casting abilities in Studio (Play module run in Lune with a simulated clock)", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-cast-"));
  type Run = { effects: { name: string; spawn: number; removed?: number; start: number[]; last: number[]; samples: Record<string, number[]> | number[][]; shown: number; visible: number }[]; emits: Record<string, number>; errors: string[]; registered: number };
  const cast = (spec: AbilitySpec, seconds = 7): Run => {
    const r = resolveAbility(spec, none);
    const rig = RIGS[spec.rig];
    const code = join(dir, "import.luau"), rigFile = join(dir, "rig.json");
    writeFileSync(code, abilityToLuau(r, { assetId: "b_test01", version: 1, select: false }).code);
    writeFileSync(rigFile, JSON.stringify({ type: spec.rig, hipHeight: spec.rig === "R15" ? 2 : 0, parts: rig.parts.map((p) => ({ name: p.name, size: p.size, center: p.center })) }));
    const out = execFileSync(LUNE, ["run", join(import.meta.dirname, "lune", "ability-runtime.luau"), code, rigFile, String(seconds)], { encoding: "utf8" });
    const run = JSON.parse(out.split("\n").find((l) => l.startsWith("RUN "))!.slice(4)) as Run;
    // Lune writes empty tables as {}.
    const list = <T,>(v: T[] | Record<string, T>): T[] => (Array.isArray(v) ? v : Object.values(v));
    return { ...run, effects: list(run.effects), errors: list(run.errors), emits: Array.isArray(run.emits) ? {} : run.emits };
  };

  it("Fireball: charges on the hand, flies forward, explodes where it lands, then cleans up", () => {
    const run = cast(byName("Fireball"));
    expect(run.errors).toEqual([]);
    expect(run.registered).toBe(1); // the unpublished animation plays through a temporary Studio id
    const [charge, ball, impact] = run.effects;
    expect(charge).toMatchObject({ name: "Charge", start: [1.5, 1.92, 0] });
    expect(charge.spawn).toBeLessThan(0.05);
    expect(charge.removed!).toBeGreaterThan(0.85);
    expect(charge.removed!).toBeLessThan(1.2);
    expect(ball).toMatchObject({ name: "Fireball", start: [1.5, 1.92, -0.8] });
    expect(ball.spawn).toBeCloseTo(0.45, 1);
    // Hits the ground ~0.77 s later, ~37 studs ahead, and the impact plays there.
    expect(impact.name).toBe("Fireball Impact");
    expect(impact.spawn).toBeGreaterThan(1.15);
    expect(impact.spawn).toBeLessThan(1.3);
    expect(impact.start[1]).toBeCloseTo(0, 1);
    expect(impact.start[2]).toBeGreaterThan(-39);
    expect(impact.start[2]).toBeLessThan(-36);
    expect(ball.removed! - impact.spawn).toBeGreaterThan(0.5);
    expect(run.emits).toEqual({ Flash: 1, Shockwave: 1, Blast: 14, Smoke: 10, Sparks: 30 });
    for (const e of run.effects) expect(e.removed, e.name).toBeDefined();
  });

  it("Stand Barrage: the Stand fades in behind the caster, rushes in front, punches, comes back and goes", () => {
    const run = cast(byName("Stand Barrage"), 4);
    expect(run.errors).toEqual([]);
    const stand = run.effects.find((e) => e.name === "Stand")!;
    expect(stand.spawn).toBeCloseTo(0.1, 1);
    // Behind the right shoulder, a stud above the caster's root (2.92).
    expect(stand.start[0]).toBeCloseTo(1.6, 1);
    expect(stand.start[1]).toBeCloseTo(3.92, 1);
    expect(stand.start[2]).toBeCloseTo(2.2, 1);
    const at = (t: number) => (stand.samples as Record<string, number[]>)[String(Math.floor(t / 0.25))];
    expect(at(1)[3]).toBeCloseTo(-2.8, 1); // in front while it punches
    expect(at(1)[4]).toBeGreaterThan(0.8); // fully shown (ForceField at 0.15 transparency)
    expect(stand.removed!).toBeGreaterThan(2.3);
    expect(stand.removed!).toBeLessThan(2.45);
    expect(stand.last[2]).toBeCloseTo(2.2, 0);
    const aura = run.effects.find((e) => e.name === "Stand Aura")!;
    expect(aura.spawn).toBeCloseTo(0.1, 1);
    expect(aura.removed!).toBeGreaterThan(stand.removed!);
    expect(run.registered).toBe(2); // the caster's and the Stand's own animation
  });

  it("Earth Wall: three pillars rise out of the ground in front, hold, then sink and go", () => {
    const run = cast(byName("Earth Wall"), 4);
    expect(run.errors).toEqual([]);
    const pillars = run.effects.filter((e) => /^Pillar/.test(e.name));
    expect(pillars.map((p) => p.name)).toEqual(["Pillar", "Pillar 2", "Pillar 3"]);
    for (const p of pillars) {
      const samples = Object.values(p.samples as unknown as Record<string, number[]>);
      expect(p.start[1]).toBeLessThan(-1); // starts underground (rising)
      expect(Math.max(...samples.map((x) => x[2]))).toBeCloseTo(0, 1); // stands on the ground
      expect(p.start[2]).toBeLessThan(-4);
      expect(p.removed!).toBeGreaterThan(2.4);
    }
    expect(pillars[1].start[0]).toBeCloseTo(0, 1);
  });

  it("Spirit Sword: the blade appears in the right hand and fades after the slash", () => {
    const run = cast(byName("Spirit Sword"), 3);
    expect(run.errors).toEqual([]);
    const blade = run.effects.find((e) => e.name === "Spirit Blade")!;
    expect(blade.spawn).toBeCloseTo(0.05, 1);
    expect(blade.start).toEqual([1.5, 1.92, 0]); // the right hand of a dummy at rest
    expect(blade.shown).toBe(1);
    // Shown until 1.05 s, then a 0.15 s fade.
    expect(blade.removed!).toBeGreaterThan(1.15);
    expect(blade.removed!).toBeLessThan(1.3);
  });

  it("mesh effects grow, show and fade when an ability plays them", () => {
    const spec = sanitizeAbilitySpec(expandAbilityInput({
      name: "Nova", rig: "R15",
      events: [{ at: 0.2, attach: "ground", duration: 0.2, vfx: { preset: "energyBurst" } }],
    }));
    const run = cast(spec, 2);
    expect(run.errors).toEqual([]);
    const burst = run.effects.find((e) => e.name === "Energy Burst")! as unknown as { meshes: Record<string, { maxSize: number; minT: number; lastT: number }> };
    expect(burst.meshes.Dome.maxSize).toBeGreaterThan(14); // 1 → 16 studs
    expect(burst.meshes.Dome.minT).toBeLessThan(0.3);
    expect(burst.meshes.Core.maxSize).toBeCloseTo(2.5, 0); // shrinks from 2.5
    expect(burst.meshes.Pillar.maxSize).toBe(14); // a 14-stud pillar widening
    for (const m of Object.values(burst.meshes)) expect(m.lastT).toBe(1); // hidden again when done
  });

  it.each(starters.map((s) => [s.name, s] as const))("%s: every effect appears on cue without script errors", (_name, spec) => {
    const run = cast(spec);
    expect(run.errors).toEqual([]);
    const r = resolveAbility(spec, none);
    for (const e of r.events) {
      const hit = run.effects.find((x) => x.name === e.templateName);
      expect(hit, e.templateName).toBeDefined();
      expect(Math.abs(hit!.spawn - e.event.at)).toBeLessThan(0.05);
      if (e.impactName) expect(run.effects.some((x) => x.name === e.impactName)).toBe(true);
    }
  });
});
