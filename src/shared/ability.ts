// Abilities: a character animation plus visual effects timed to it — a fireball thrown from the
// hand, a shockwave when the fist hits the ground, an aura while a spell charges. Previewed live
// on an R15/R6 dummy in the browser; imported into Studio as a folder (KeyframeSequence, effect
// templates and a Play module) plus a Tool that casts it, so it can be tried in a play-test.
//
// Effects attach to a body part (they follow it), to the ground under the character, or to the
// spot the character stood on. A traveling effect flies with a velocity in the character's frame
// (forward is -Z) until its duration ends or it hits the ground, then an impact effect plays.

import { z } from "zod";
import { animationLength, AnimationSpecSchema, RIG_TYPES, sanitizeAnimationSpec, type AnimationSpec, type RigType } from "./animation.ts";
import { sanitizeVfxSpec, scaleVfx, tintVfx, VfxSpecSchema, vfxTail, type VfxSpec } from "./vfx.ts";
import { expandVfxInput, VfxInputSchema } from "./vfx-presets.ts";
import { expandModelInput, ModelSpecInputSchema, ModelSpecSchema, sanitizeModelSpec, type ModelSpec } from "./model.ts";
import type { Vec3 } from "./math.ts";

export const ATTACH_POINTS = ["root", "rightHand", "leftHand", "head", "torso", "rightFoot", "leftFoot", "ground", "world"] as const;
export type AttachPoint = (typeof ATTACH_POINTS)[number];
export type BodyPoint = Exclude<AttachPoint, "ground" | "world">;

/** Where each attach point is on each rig: a part and an offset in that part's frame. */
export const ATTACH: Record<RigType, Record<BodyPoint, { part: string; offset: Vec3 }>> = {
  R15: {
    root: { part: "HumanoidRootPart", offset: [0, 0, 0] },
    rightHand: { part: "RightHand", offset: [0, -0.15, 0] },
    leftHand: { part: "LeftHand", offset: [0, -0.15, 0] },
    head: { part: "Head", offset: [0, 0, 0] },
    torso: { part: "UpperTorso", offset: [0, 0, 0] },
    rightFoot: { part: "RightFoot", offset: [0, -0.15, 0] },
    leftFoot: { part: "LeftFoot", offset: [0, -0.15, 0] },
  },
  R6: {
    root: { part: "HumanoidRootPart", offset: [0, 0, 0] },
    rightHand: { part: "Right Arm", offset: [0, -1, 0] },
    leftHand: { part: "Left Arm", offset: [0, -1, 0] },
    head: { part: "Head", offset: [0, 0, 0] },
    torso: { part: "Torso", offset: [0, 0, 0] },
    rightFoot: { part: "Right Leg", offset: [0, -1, 0] },
    leftFoot: { part: "Left Leg", offset: [0, -1, 0] },
  },
};

const vec3 = z.array(z.number()).length(3);
const ASSET_ID = /^[av]_[a-z0-9]{6}$/;

/** An inline animation: create_animation's fields, name and rig optional (the ability's rig is used). */
export const InlineAnimationSchema = AnimationSpecSchema.partial({ name: true, rig: true });
/** An inline effect: create_vfx's fields, name optional. */
export const InlineVfxSchema = VfxSpecSchema.partial({ name: true });
const VfxRef = z.union([z.string().regex(ASSET_ID), InlineVfxSchema]);

export const TravelSchema = z.object({
  velocity: vec3.describe("studs/s in the character's frame (x right, y up, z back; forward is -z), e.g. [0, 0, -70]"),
  gravity: z.number().min(0).max(400).optional().describe("downward pull, studs/s², default 0"),
  stopOnHit: z.boolean().optional().describe("end at the ground or a part it hits, default true"),
});

export const AbilityEventSchema = z.object({
  name: z.string().max(60).optional(),
  at: z.number().min(0).max(30).describe("seconds from the start"),
  vfx: VfxRef.describe("effect asset id (v_…) or an inline effect in create_vfx format"),
  attach: z.enum(ATTACH_POINTS).optional().describe("default root"),
  offset: vec3.optional().describe("studs from the attach point, in the character's frame (the part's frame with follow part)"),
  follow: z.enum(["character", "part"]).optional().describe("attached effects turn with the character (default) or with the body part"),
  duration: z.number().min(0.05).max(30).optional().describe("seconds until it stops emitting (traveling: flight time), default 1"),
  travel: TravelSchema.optional(),
  impact: VfxRef.optional().describe("effect played where a traveling effect ends or hits"),
  scale: z.number().min(0.1).max(10).optional(),
});

// ---------------------------------------------------------------------------
// Summons (a Stand behind the player, a clone, a spirit) and props (a sword in the hand, a rock
// wall rising from the ground, a thrown spear).

const hex = z.string().regex(/^#?[0-9a-fA-F]{6}$/);
const ANIM_ID = /^a_[a-z0-9]{6}$/;
const MODEL_ID = /^m_[a-z0-9]{6}$/;
export const SUMMON_MATERIALS = ["ForceField", "Neon", "Glass", "SmoothPlastic", "Plastic"] as const;
export const SUMMON_DEFAULTS = { offset: [1.6, 1, 2.2] as Vec3, color: "#8f6bff", material: "ForceField" as const, transparency: 0.2, scale: 1.15, fade: 0.25, hover: 0.15 };

export const SummonSchema = z.object({
  name: z.string().max(60).optional(),
  at: z.number().min(0).max(30).describe("seconds from the start"),
  duration: z.number().min(0.1).max(30).optional().describe("seconds before it vanishes, default until the ability ends"),
  rig: z.enum(RIG_TYPES).optional().describe("default the ability's rig"),
  animation: z.union([z.literal("caster"), z.string().regex(ANIM_ID), InlineAnimationSchema]).optional()
    .describe('"caster" copies the caster\'s animation in sync; an animation id or inline keyframes start when it appears; default: it hovers'),
  offset: vec3.optional().describe("from the caster's root in the caster's frame (x right, y up, z back), default [1.6, 1, 2.2]: behind the right shoulder"),
  path: z.array(z.object({ t: z.number().min(0).max(30), offset: vec3 })).max(20).optional().describe("moves: offsets reached at seconds after it appears (e.g. rush in front to punch, then back)"),
  turn: z.number().min(-180).max(180).optional().describe("yaw degrees relative to the caster, default 0"),
  color: hex.optional().describe("default #8f6bff"),
  material: z.enum(SUMMON_MATERIALS).optional().describe("default ForceField (ghostly)"),
  transparency: z.number().min(0).max(0.95).optional().describe("default 0.2"),
  scale: z.number().min(0.25).max(5).optional().describe("size against the caster, default 1.15"),
  appear: z.enum(["fade", "grow", "pop"]).optional().describe("default fade"),
  fade: z.number().min(0).max(3).optional().describe("seconds to appear and to vanish, default 0.25"),
  hover: z.number().min(0).max(2).optional().describe("bobs up and down this many studs, default 0.15"),
  vfx: VfxRef.optional().describe("aura on its torso: effect id or inline effect"),
});

export const PropSchema = z.object({
  name: z.string().max(60).optional(),
  at: z.number().min(0).max(30).describe("seconds from the start"),
  duration: z.number().min(0.05).max(30).optional().describe("seconds before it vanishes, default until the ability ends"),
  model: z.union([z.string().regex(MODEL_ID), ModelSpecSchema.partial({ name: true })]).describe("model id (m_…) or inline {parts}; model origin (0,0,0) = the grip / attach point"),
  attach: z.enum(ATTACH_POINTS).optional().describe("default rightHand"),
  offset: vec3.optional().describe("studs from the attach point"),
  rot: vec3.optional().describe("degrees like CFrame.Angles; in a hand (follow part) -y runs out past the fingers"),
  follow: z.enum(["character", "part"]).optional().describe("on a body point: turn with the part (default) or only follow it"),
  scale: z.number().min(0.05).max(20).optional(),
  appear: z.enum(["pop", "fade", "grow", "rise"]).optional().describe("default fade; rise comes up out of the ground"),
  vanish: z.enum(["pop", "fade", "shrink", "sink"]).optional().describe("default fade"),
  fade: z.number().min(0).max(3).optional().describe("seconds to appear and to vanish, default 0.2"),
  spin: vec3.optional().describe("degrees per second"),
  travel: TravelSchema.optional().describe("thrown: flies from where it appears"),
  impact: VfxRef.optional().describe("effect where a thrown prop lands"),
});

export const AbilitySpecSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  rig: z.enum(RIG_TYPES),
  animation: z.union([z.string().regex(ASSET_ID), InlineAnimationSchema]).optional().describe("animation asset id (a_…) or inline keyframes in create_animation format"),
  events: z.array(AbilityEventSchema).max(40).default([]),
  summons: z.array(SummonSchema).max(6).optional(),
  props: z.array(PropSchema).max(20).optional(),
  length: z.number().min(0.1).max(30).optional().describe("seconds, default: until the animation and effects are done"),
  cooldown: z.number().min(0).max(120).optional().describe("seconds between casts of the Studio Tool, default 1"),
});

export type AbilityEvent = z.infer<typeof AbilityEventSchema>;
export type AbilitySummon = z.infer<typeof SummonSchema>;
export type AbilityProp = z.infer<typeof PropSchema>;
export type AbilitySpec = z.infer<typeof AbilitySpecSchema>;
type VfxRefValue = z.infer<typeof VfxRef>;

// What Claude may send: inline effects in create_vfx input format (presets, tint, scale).
const VfxRefInput = z.union([z.string().regex(ASSET_ID), VfxInputSchema]);
export const AbilityEventInputSchema = AbilityEventSchema.extend({
  vfx: VfxRefInput.describe("effect asset id (v_…) or an inline effect in create_vfx format"),
  impact: VfxRefInput.optional().describe("effect played where a traveling effect ends or hits"),
});
export const SummonInputSchema = SummonSchema.extend({ vfx: VfxRefInput.optional().describe("aura on its torso: effect id or inline effect") });
export const PropInputSchema = PropSchema.extend({
  model: z.union([z.string().regex(MODEL_ID), ModelSpecInputSchema.partial({ name: true })]).describe("model id (m_…) or inline {parts} like create_model; origin = the grip"),
  impact: VfxRefInput.optional(),
});
export const AbilitySpecInputSchema = AbilitySpecSchema.extend({
  events: z.array(AbilityEventInputSchema).max(40).default([]),
  summons: z.array(SummonInputSchema).max(6).optional(),
  props: z.array(PropInputSchema).max(20).optional(),
});
export type AbilityEventInput = z.infer<typeof AbilityEventInputSchema>;
export type AbilitySpecInput = z.infer<typeof AbilitySpecInputSchema>;

/** Inline effects are named after the event, else the preset, else the ability. */
function expandRef(ref: z.infer<typeof VfxRefInput>, eventName: string | undefined, abilityName: string): VfxRefValue {
  if (typeof ref === "string") return ref;
  return expandVfxInput(ref, eventName ?? (ref.preset ? undefined : abilityName));
}

/** An event with its inline effects expanded (presets, tint and scale applied). */
export function expandAbilityEvent(e: AbilityEventInput | Record<string, unknown>, abilityName: string): AbilityEvent {
  const ev = AbilityEventInputSchema.parse(e);
  const out: Record<string, unknown> = { ...ev, vfx: expandRef(ev.vfx, ev.name, abilityName) };
  if (ev.impact !== undefined) out.impact = expandRef(ev.impact, ev.name && `${ev.name} Impact`, `${abilityName} Impact`);
  return AbilityEventSchema.parse(out);
}

export function expandSummon(raw: unknown, abilityName: string): AbilitySummon {
  const s = SummonInputSchema.parse(raw);
  const name = s.name ?? "Stand";
  return SummonSchema.parse({ ...s, ...(s.vfx !== undefined ? { vfx: expandRef(s.vfx, `${name} Aura`, abilityName) } : {}) });
}

export function expandProp(raw: unknown, abilityName: string): AbilityProp {
  const p = PropInputSchema.parse(raw);
  const name = p.name ?? (typeof p.model === "string" ? "Prop" : p.model.name ?? "Prop");
  const model = typeof p.model === "string" ? p.model : sanitizeModelSpec(expandModelInput({ ...p.model, name: p.model.name ?? name }));
  return PropSchema.parse({ ...p, model, ...(p.impact !== undefined ? { impact: expandRef(p.impact, `${name} Impact`, abilityName) } : {}) });
}

export function expandAbilityInput(input: AbilitySpecInput): AbilitySpec {
  const out = AbilitySpecSchema.parse({
    ...input,
    events: input.events.map((e) => expandAbilityEvent(e, input.name)),
    ...(input.summons ? { summons: input.summons.map((s) => expandSummon(s, input.name)) } : {}),
    ...(input.props ? { props: input.props.map((p) => expandProp(p, input.name)) } : {}),
  });
  if (!out.events.length && !out.summons?.length && !out.props?.length) throw new Error("An ability needs at least one event, summon or prop.");
  return out;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function sanitizeAbilitySpec(spec: AbilitySpec): AbilitySpec {
  const events = [...spec.events]
    .map((e) => ({
      ...e,
      at: r3(e.at),
      ...(typeof e.vfx === "string" ? {} : { vfx: sanitizeVfxSpec({ ...e.vfx, name: e.vfx.name ?? e.name ?? spec.name }) }),
      ...(e.impact && typeof e.impact !== "string" ? { impact: sanitizeVfxSpec({ ...e.impact, name: e.impact.name ?? `${e.name ?? spec.name} Impact` }) } : {}),
    }))
    .sort((a, b) => a.at - b.at);
  const out: AbilitySpec = { ...spec, name: spec.name.trim() || "Ability", events };
  if (spec.animation && typeof spec.animation !== "string") {
    out.animation = sanitizeAnimationSpec({ ...spec.animation, name: spec.animation.name ?? spec.name, rig: spec.animation.rig ?? spec.rig });
  }
  if (spec.summons?.length) {
    out.summons = spec.summons.map((s, i) => {
      const name = s.name ?? `Stand${i ? ` ${i + 1}` : ""}`;
      const rig = s.rig ?? spec.rig;
      return {
        ...s,
        at: r3(s.at),
        ...(s.animation && typeof s.animation === "object" ? { animation: sanitizeAnimationSpec({ ...s.animation, name: s.animation.name ?? name, rig }) } : {}),
        ...(s.vfx && typeof s.vfx !== "string" ? { vfx: sanitizeVfxSpec({ ...s.vfx, name: s.vfx.name ?? `${name} Aura` }) } : {}),
      };
    }).sort((a, b) => a.at - b.at);
  } else delete out.summons;
  if (spec.props?.length) {
    out.props = spec.props.map((p) => ({
      ...p,
      at: r3(p.at),
      ...(typeof p.model !== "string" ? { model: sanitizeModelSpec({ ...p.model, name: p.model.name ?? p.name ?? "Prop" }) } : {}),
      ...(p.impact && typeof p.impact !== "string" ? { impact: sanitizeVfxSpec({ ...p.impact, name: p.impact.name ?? `${p.name ?? "Prop"} Impact` }) } : {}),
    })).sort((a, b) => a.at - b.at);
  } else delete out.props;
  return out;
}

// ---------------------------------------------------------------------------
// Resolving references (asset ids) into the specs they point at

export interface ResolvedEvent {
  event: AbilityEvent;
  index: number;
  vfx: VfxSpec;
  impact?: VfxSpec;
  /** Unique template names used in Studio (Effects folder). */
  templateName: string;
  impactName?: string;
}

export interface ResolvedSummon {
  summon: AbilitySummon;
  index: number;
  rig: RigType;
  /** Its own animation (null: it hovers); `caster` plays the caster's in sync. */
  animation: AnimationSpec | null;
  caster: boolean;
  vfx?: VfxSpec;
  /** Unique names in Studio (Summons folder; the aura goes in Effects). */
  templateName: string;
  auraName?: string;
  /** Seconds from the start until it starts to vanish. */
  until: number;
}

export interface ResolvedProp {
  prop: AbilityProp;
  index: number;
  model: ModelSpec;
  impact?: VfxSpec;
  templateName: string;
  impactName?: string;
  until: number;
}

export interface ResolvedAbility {
  spec: AbilitySpec;
  animation: AnimationSpec | null;
  events: ResolvedEvent[];
  summons: ResolvedSummon[];
  props: ResolvedProp[];
  /** Referenced assets that don't exist (or aren't the right kind). */
  missing: string[];
  length: number;
}

type Lookup = (id: string) => { kind: string; spec: unknown } | undefined;

export function abilityRefs(spec: AbilitySpec): string[] {
  const ids = new Set<string>();
  if (typeof spec.animation === "string") ids.add(spec.animation);
  for (const e of spec.events) {
    if (typeof e.vfx === "string") ids.add(e.vfx);
    if (typeof e.impact === "string") ids.add(e.impact);
  }
  for (const m of spec.summons ?? []) {
    if (typeof m.animation === "string" && m.animation !== "caster") ids.add(m.animation);
    if (typeof m.vfx === "string") ids.add(m.vfx);
  }
  for (const p of spec.props ?? []) {
    if (typeof p.model === "string") ids.add(p.model);
    if (typeof p.impact === "string") ids.add(p.impact);
  }
  return [...ids];
}

export function resolveAbility(spec: AbilitySpec, lookup: Lookup): ResolvedAbility {
  const missing: string[] = [];
  const vfxOf = (ref: VfxRefValue, fallbackName: string): VfxSpec | null => {
    if (typeof ref !== "string") return { ...ref, name: ref.name ?? fallbackName } as VfxSpec;
    const a = lookup(ref);
    if (!a || a.kind !== "vfx") {
      missing.push(ref);
      return null;
    }
    return a.spec as VfxSpec;
  };
  let animation: AnimationSpec | null = null;
  if (typeof spec.animation === "string") {
    const a = lookup(spec.animation);
    if (a && a.kind === "animation") animation = a.spec as AnimationSpec;
    else missing.push(spec.animation);
  } else if (spec.animation) {
    animation = { ...spec.animation, name: spec.animation.name ?? spec.name, rig: spec.animation.rig ?? spec.rig } as AnimationSpec;
  }
  const used = new Set<string>();
  const unique = (base: string) => {
    const clean = base.replace(/[^\w ]/g, "").trim() || "Effect";
    let n = clean;
    for (let i = 2; used.has(n); i++) n = `${clean} ${i}`;
    used.add(n);
    return n;
  };
  const events: ResolvedEvent[] = [];
  spec.events.forEach((event, index) => {
    const base = vfxOf(event.vfx, event.name ?? `Effect ${index + 1}`);
    if (!base) return;
    const k = event.scale ?? 1;
    const vfx = scaleVfx(base, k);
    const impactBase = event.impact ? vfxOf(event.impact, `${event.name ?? vfx.name} Impact`) : null;
    const impact = impactBase ? scaleVfx(impactBase, k) : undefined;
    events.push({
      event, index, vfx, impact,
      templateName: unique(event.name ?? vfx.name),
      ...(impact ? { impactName: unique(impact.name) } : {}),
    });
  });
  // Summons and props stay until the rest of the ability is done unless given a duration.
  const base = abilityLength({ spec: { ...spec, length: undefined }, animation, events, summons: [], props: [] });
  const until = (at: number, duration: number | undefined) => r3(at + (duration ?? Math.max(1, base - at)));
  const usedSummons = new Set<string>(), usedProps = new Set<string>();
  const uniqueIn = (set: Set<string>, base: string, fallback: string) => {
    const clean = base.replace(/[^\w ]/g, "").trim() || fallback;
    let n = clean;
    for (let i = 2; set.has(n); i++) n = `${clean} ${i}`;
    set.add(n);
    return n;
  };
  const summons: ResolvedSummon[] = [];
  (spec.summons ?? []).forEach((summon, index) => {
    const caster = summon.animation === "caster";
    const rig = caster ? spec.rig : summon.rig ?? spec.rig;
    let anim: AnimationSpec | null = caster ? animation : null;
    if (typeof summon.animation === "string" && !caster) {
      const a = lookup(summon.animation);
      if (a && a.kind === "animation") anim = { ...(a.spec as AnimationSpec), rig };
      else missing.push(summon.animation);
    } else if (summon.animation && typeof summon.animation === "object") {
      anim = { ...summon.animation, name: summon.animation.name ?? summon.name ?? "Stand", rig } as AnimationSpec;
    }
    const templateName = uniqueIn(usedSummons, summon.name ?? "Stand", "Stand");
    const vfx = summon.vfx ? vfxOf(summon.vfx, `${templateName} Aura`) ?? undefined : undefined;
    summons.push({
      summon, index, rig, animation: anim, caster, templateName, until: until(summon.at, summon.duration),
      ...(vfx ? { vfx, auraName: unique(`${templateName} Aura`) } : {}),
    });
  });
  const props: ResolvedProp[] = [];
  (spec.props ?? []).forEach((prop, index) => {
    let model: ModelSpec | null = null;
    if (typeof prop.model === "string") {
      const a = lookup(prop.model);
      if (a && a.kind === "model") model = a.spec as ModelSpec;
      else missing.push(prop.model);
    } else model = { ...prop.model, name: prop.model.name ?? prop.name ?? "Prop" } as ModelSpec;
    if (!model) return;
    const templateName = uniqueIn(usedProps, prop.name ?? model.name, "Prop");
    const impact = prop.impact ? vfxOf(prop.impact, `${templateName} Impact`) ?? undefined : undefined;
    props.push({
      prop, index, model, templateName, until: until(prop.at, prop.duration),
      ...(impact ? { impact, impactName: unique(impact.name) } : {}),
    });
  });
  const resolved: ResolvedAbility = { spec, animation, events, summons, props, missing, length: 0 };
  resolved.length = abilityLength(resolved);
  return resolved;
}

/** Seconds the ability takes: the animation, every effect (with the fade of the last particles), summon and prop. */
export function abilityLength(r: Pick<ResolvedAbility, "spec" | "animation" | "events" | "summons" | "props">): number {
  if (r.spec.length) return r.spec.length;
  let t = r.animation ? animationLength(r.animation) : 0;
  for (const e of r.events) {
    const end = e.event.at + (e.event.duration ?? 1);
    t = Math.max(t, end + vfxTail(e.vfx), e.impact ? end + vfxTail(e.impact) : 0);
  }
  for (const m of r.summons) t = Math.max(t, m.until + (m.summon.fade ?? SUMMON_DEFAULTS.fade) + (m.vfx ? vfxTail(m.vfx) * 0.5 : 0));
  for (const p of r.props) {
    t = Math.max(t, p.until + (p.prop.fade ?? 0.2));
    if (p.impact && p.prop.travel) t = Math.max(t, p.until + vfxTail(p.impact));
  }
  return Math.min(30, Math.max(0.5, r3(t)));
}

// ---------------------------------------------------------------------------
// Edits

const PartialEvent = z.object({ index: z.number().int().min(0) }).catchall(z.any());
export const AbilityEditSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  description: z.string().max(500).optional(),
  rig: z.enum(RIG_TYPES).optional(),
  animation: AbilitySpecSchema.shape.animation,
  length: z.number().min(0.1).max(30).nullable().optional(),
  cooldown: z.number().min(0).max(120).optional(),
  add: z.array(AbilityEventInputSchema).optional(),
  update: z.array(PartialEvent).optional().describe("[{index, ...fields}] by position in events (sorted by at); null removes a field"),
  remove: z.array(z.number().int().min(0)).optional().describe("event indexes"),
  summons: z.array(SummonInputSchema).max(6).optional().describe("replaces the summons ([] removes them)"),
  props: z.array(PropInputSchema).max(20).optional().describe("replaces the props ([] removes them)"),
  tint: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional().describe("shift the colors of every inline effect to this hue"),
});
export type AbilityEdit = z.infer<typeof AbilityEditSchema>;

export function applyAbilityEdit(spec: AbilitySpec, edit: AbilityEdit): { spec: AbilitySpec; missing: number[] } {
  const missing: number[] = [];
  let events = spec.events.map((e) => ({ ...e }));
  for (const u of edit.update ?? []) {
    if (!events[u.index]) {
      missing.push(u.index);
      continue;
    }
    const merged: Record<string, unknown> = { ...events[u.index] };
    for (const [k, v] of Object.entries(u)) {
      if (k === "index") continue;
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    events[u.index] = expandAbilityEvent(merged, spec.name);
  }
  if (edit.remove?.length) {
    const gone = new Set(edit.remove);
    for (const i of gone) if (!events[i]) missing.push(i);
    events = events.filter((_, i) => !gone.has(i));
  }
  events.push(...(edit.add ?? []).map((e) => expandAbilityEvent(e, edit.name ?? spec.name)));
  const summons = edit.summons ? edit.summons.map((m) => expandSummon(m, spec.name)) : spec.summons;
  const props = edit.props ? edit.props.map((p) => expandProp(p, spec.name)) : spec.props;
  if (!events.length && !summons?.length && !props?.length) throw new Error("An ability needs at least one event, summon or prop.");
  if (edit.tint) {
    const tint = edit.tint;
    events = events.map((e) => ({
      ...e,
      vfx: typeof e.vfx === "string" ? e.vfx : tintVfx(e.vfx, tint),
      ...(e.impact && typeof e.impact !== "string" ? { impact: tintVfx(e.impact, tint) } : {}),
    }));
  }
  let nextSummons = summons;
  if (edit.tint && nextSummons) {
    const tint = edit.tint;
    nextSummons = nextSummons.map((m) => ({ ...m, color: tint, ...(m.vfx && typeof m.vfx !== "string" ? { vfx: tintVfx(m.vfx, tint) } : {}) }));
  }
  const next: AbilitySpec = { ...spec, events, summons: nextSummons, props };
  for (const k of ["name", "description", "rig", "animation", "cooldown"] as const) {
    if (edit[k] !== undefined) (next as Record<string, unknown>)[k] = edit[k];
  }
  if (edit.length === null) delete next.length;
  else if (edit.length !== undefined) next.length = edit.length;
  return { spec: sanitizeAbilitySpec(AbilitySpecSchema.parse(next)), missing };
}

export function abilitySummary(r: { spec: AbilitySpec; length?: number }): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const bits: string[] = [r.spec.rig];
  if (r.spec.events.length || (!r.spec.summons?.length && !r.spec.props?.length)) bits.push(count(r.spec.events.length, "effect", "effects"));
  if (r.spec.summons?.length) bits.push(count(r.spec.summons.length, "summon", "summons"));
  if (r.spec.props?.length) bits.push(count(r.spec.props.length, "prop", "props"));
  if (r.length) bits.push(`${Math.round(r.length * 10) / 10}s`);
  return bits.join(" · ");
}
