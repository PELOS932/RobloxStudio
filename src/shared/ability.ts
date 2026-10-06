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
import { sanitizeVfxSpec, scaleVfx, VfxSpecSchema, vfxTail, type VfxSpec } from "./vfx.ts";
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

export const AbilitySpecSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  rig: z.enum(RIG_TYPES),
  animation: z.union([z.string().regex(ASSET_ID), InlineAnimationSchema]).optional().describe("animation asset id (a_…) or inline keyframes in create_animation format"),
  events: z.array(AbilityEventSchema).min(1).max(40),
  length: z.number().min(0.1).max(30).optional().describe("seconds, default: until the animation and effects are done"),
  cooldown: z.number().min(0).max(120).optional().describe("seconds between casts of the Studio Tool, default 1"),
});

export type AbilityEvent = z.infer<typeof AbilityEventSchema>;
export type AbilitySpec = z.infer<typeof AbilitySpecSchema>;
type VfxRefValue = z.infer<typeof VfxRef>;

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

export interface ResolvedAbility {
  spec: AbilitySpec;
  animation: AnimationSpec | null;
  events: ResolvedEvent[];
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
  const resolved: ResolvedAbility = { spec, animation, events, missing, length: 0 };
  resolved.length = abilityLength(resolved);
  return resolved;
}

/** Seconds the ability takes: the animation and every effect, including the fade of the last particles. */
export function abilityLength(r: Pick<ResolvedAbility, "spec" | "animation" | "events">): number {
  if (r.spec.length) return r.spec.length;
  let t = r.animation ? animationLength(r.animation) : 0;
  for (const e of r.events) {
    const end = e.event.at + (e.event.duration ?? 1);
    t = Math.max(t, end + vfxTail(e.vfx), e.impact ? end + vfxTail(e.impact) : 0);
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
  add: z.array(AbilityEventSchema).optional(),
  update: z.array(PartialEvent).optional().describe("[{index, ...fields}] by position in events (sorted by at); null removes a field"),
  remove: z.array(z.number().int().min(0)).optional().describe("event indexes"),
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
    events[u.index] = AbilityEventSchema.parse(merged);
  }
  if (edit.remove?.length) {
    const gone = new Set(edit.remove);
    for (const i of gone) if (!events[i]) missing.push(i);
    events = events.filter((_, i) => !gone.has(i));
  }
  events.push(...(edit.add ?? []));
  if (!events.length) throw new Error("An ability needs at least one event.");
  const next: AbilitySpec = { ...spec, events };
  for (const k of ["name", "description", "rig", "animation", "cooldown"] as const) {
    if (edit[k] !== undefined) (next as Record<string, unknown>)[k] = edit[k];
  }
  if (edit.length === null) delete next.length;
  else if (edit.length !== undefined) next.length = edit.length;
  return { spec: sanitizeAbilitySpec(AbilitySpecSchema.parse(next)), missing };
}

export function abilitySummary(r: { spec: AbilitySpec; length?: number }): string {
  const n = r.spec.events.length;
  return `${r.spec.rig} · ${n} effect${n === 1 ? "" : "s"}${r.length ? ` · ${Math.round(r.length * 10) / 10}s` : ""}`;
}
