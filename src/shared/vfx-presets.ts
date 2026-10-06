// Whole-effect presets (the starter effects) and the create_vfx input format built on them:
// `{preset: "explosion", tint: "#3fa0ff", scale: 0.5}` is a complete blue mini explosion, and
// listed emitters add to the preset or override its emitters by name.

import { z } from "zod";
import starters from "../../examples/starter-vfx.json";
import { EmitterSchema, sanitizeVfxSpec, scaleVfx, tintVfx, VfxSpecSchema, type VfxEmitter, type VfxSpec } from "./vfx.ts";

const BY_NAME: Record<string, string> = {
  campfire: "Campfire",
  magicAura: "Magic Aura",
  explosion: "Explosion",
  portal: "Portal",
  swordSlash: "Sword Slash Trail",
  lightningArc: "Lightning Arc",
  snowfall: "Snowfall",
  healingPad: "Healing Pickup",
  energyBurst: "Energy Burst",
  forceShield: "Force Shield",
};
export const EFFECT_PRESET_NAMES = Object.keys(BY_NAME) as [string, ...string[]];

const PRESETS = new Map<string, VfxSpec>(
  Object.entries(BY_NAME).map(([key, name]) => {
    const raw = (starters as unknown[]).find((s) => (s as { name?: string }).name === name);
    if (!raw) throw new Error(`starter effect "${name}" is missing`);
    return [key, sanitizeVfxSpec(VfxSpecSchema.parse(raw))];
  }),
);

export function effectPreset(name: string): VfxSpec {
  const spec = PRESETS.get(name);
  if (!spec) throw new Error(`Unknown effect preset "${name}" (${EFFECT_PRESET_NAMES.join(", ")}).`);
  return structuredClone(spec);
}

const hex = z.string().regex(/^#?[0-9a-fA-F]{6}$/);

/** create_vfx input: a full effect, or a preset with changes. */
export const VfxInputSchema = VfxSpecSchema.extend({
  name: z.string().min(1).max(60).optional().describe("required unless preset"),
  emitters: z.array(EmitterSchema).max(40).optional(),
  preset: z.enum(EFFECT_PRESET_NAMES).optional().describe("start from a ready-made effect; emitters add to it or replace its emitters with the same name"),
  tint: hex.optional().describe("shift every color to this hue"),
  scale: z.number().min(0.05).max(20).optional().describe("scale sizes, speeds and offsets"),
});
export type VfxInput = z.infer<typeof VfxInputSchema>;

/** A saved effect from create_vfx input (presets expanded, then scaled and tinted). */
export function expandVfxInput(input: VfxInput, fallbackName?: string): VfxSpec {
  const base = input.preset ? effectPreset(input.preset) : null;
  const emitters: VfxEmitter[] = base ? base.emitters : [];
  for (const e of input.emitters ?? []) {
    const i = emitters.findIndex((x) => x.name === e.name);
    if (i < 0) emitters.push(e);
    else emitters[i] = e.type === emitters[i].type ? EmitterSchema.parse({ ...emitters[i], ...e }) : e;
  }
  if (!emitters.length) throw new Error("Give emitters, or a preset.");
  const name = input.name ?? fallbackName ?? base?.name;
  if (!name) throw new Error("Give the effect a name.");
  const spec: VfxSpec = { name, emitters };
  const description = input.description ?? base?.description;
  if (description) spec.description = description;
  const motion = input.motion ?? base?.motion;
  if (motion) spec.motion = motion;
  let out = sanitizeVfxSpec(VfxSpecSchema.parse(spec));
  if (input.scale && input.scale !== 1) out = scaleVfx(out, input.scale);
  if (input.tint) out = tintVfx(out, input.tint);
  return out;
}
