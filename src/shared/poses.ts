// Named poses for animations: a keyframe can start from one ({t, pose: "punch", poses: {...tweaks}})
// and mirror it left↔right, so a punch combo or a walk cycle is a few short lines and the joint
// signs come out right. Values are R15 joints in the animation convention (degrees, x right,
// y up, z back; +x swings limbs forward, knees bend with -x, elbows with +x, +z raises the right
// arm sideways); R6 rigs use the joints they have. Feet stay on the floor unless the pose jumps.

import type { Vec3 } from "./math.ts";

type PoseLib = Record<string, Partial<Record<string, Vec3 | { rot?: Vec3; pos?: Vec3 }>>>;

/** A crouch of `a` degrees at the hips with the feet planted: how far the body drops. */
const drop = (a: number) => -Math.round(1.67 * (1 - Math.cos((a * Math.PI) / 180)) * 100) / 100;

// Shared leg sets.
const STANCE = { root: { pos: [0, -0.12, 0] as Vec3 }, leftHip: [30, 0, 0] as Vec3, leftKnee: [-30, 0, 0] as Vec3, rightHip: [-10, 0, 0] as Vec3, rightKnee: [-20, 0, 0] as Vec3, rightAnkle: [30, 0, 0] as Vec3 };
const WIDE = { root: { pos: [0, -0.06, 0] as Vec3 }, rightHip: [10, 0, 12] as Vec3, leftHip: [10, 0, -12] as Vec3, rightKnee: [-20, 0, 0] as Vec3, leftKnee: [-20, 0, 0] as Vec3, rightAnkle: [10, 0, -12] as Vec3, leftAnkle: [10, 0, 12] as Vec3 };

export const POSES = {
  idle: { rightShoulder: [0, 0, 6], leftShoulder: [0, 0, -6], rightElbow: [10, 0, 0], leftElbow: [10, 0, 0] },
  guard: {
    ...STANCE, waist: [-8, -10, 0], neck: [-5, 10, 0],
    leftShoulder: [60, 0, 10], leftElbow: [100, 0, 0], rightShoulder: [50, 0, -15], rightElbow: [120, 0, 0],
  },
  crouch: {
    root: { pos: [0, drop(50), 0] }, hips: [50, 0, 0], knees: [-100, 0, 0], ankles: [50, 0, 0], waist: [-25, 0, 0], neck: [15, 0, 0],
    rightShoulder: [30, 0, 8], leftShoulder: [30, 0, -8], elbows: [30, 0, 0],
  },
  jump: {
    root: { pos: [0, 1, 0] }, hips: [70, 0, 0], knees: [-90, 0, 0], ankles: [20, 0, 0], waist: [-10, 0, 0], neck: [10, 0, 0],
    rightShoulder: [150, 0, 20], leftShoulder: [150, 0, -20], elbows: [20, 0, 0],
  },
  land: {
    root: { pos: [0, drop(55), 0] }, hips: [55, 0, 0], knees: [-110, 0, 0], ankles: [55, 0, 0], waist: [-30, 0, 0], neck: [20, 0, 0],
    rightShoulder: [-20, 0, 50], leftShoulder: [-20, 0, -50], elbows: [20, 0, 0],
  },
  walk: {
    root: { pos: [0, -0.06, 0] }, rightHip: [25, 0, 0], rightKnee: [-5, 0, 0], rightAnkle: [-10, 0, 0],
    leftHip: [-20, 0, 0], leftKnee: [-15, 0, 0], leftAnkle: [25, 0, 0],
    leftShoulder: [25, 0, -4], rightShoulder: [-25, 0, 4], elbows: [15, 0, 0],
  },
  run: {
    root: { pos: [0, -0.15, 0] }, waist: [-12, 0, 0], neck: [10, 0, 0],
    rightHip: [45, 0, 0], rightKnee: [-30, 0, 0], rightAnkle: [10, 0, 0], leftHip: [-35, 0, 0], leftKnee: [-70, 0, 0], leftAnkle: [20, 0, 0],
    leftShoulder: [50, 0, -5], leftElbow: [80, 0, 0], rightShoulder: [-45, 0, 5], rightElbow: [70, 0, 0],
  },
  windup: {
    ...STANCE, waist: [0, -25, 0], neck: [0, 20, 0],
    rightShoulder: [-30, 0, 15], rightElbow: [110, 0, 0], leftShoulder: [70, 0, 15], leftElbow: [90, 0, 0],
  },
  punch: {
    ...STANCE, waist: [-5, 25, 0], neck: [0, -25, 0],
    rightShoulder: [90, 0, 25], rightElbow: [0, 0, 0], leftShoulder: [45, 0, 15], leftElbow: [120, 0, 0],
  },
  kick: {
    root: { pos: [0, -0.08, 0] }, waist: [15, 0, 0], rightHip: [95, 0, 0], rightKnee: [-10, 0, 0], rightAnkle: [-20, 0, 0],
    leftHip: [-10, 0, 0], leftKnee: [-15, 0, 0], leftAnkle: [25, 0, 0],
    rightShoulder: [-30, 0, 35], leftShoulder: [40, 0, -40], elbows: [40, 0, 0],
  },
  cast: {
    ...WIDE, waist: [-8, 0, 0], neck: [5, 0, 0],
    rightShoulder: [90, 0, -8], leftShoulder: [90, 0, 8], elbows: [10, 0, 0], wrists: [70, 0, 0],
  },
  raise: {
    ...WIDE, waist: [10, 0, 0], neck: [25, 0, 0],
    rightShoulder: [170, 0, 20], leftShoulder: [170, 0, -20], elbows: [10, 0, 0],
  },
  slam: {
    root: { pos: [0, drop(55), 0] }, hips: [55, 0, 0], knees: [-110, 0, 0], ankles: [55, 0, 0], waist: [-45, 0, 0], neck: [30, 0, 0],
    rightShoulder: [30, 0, -5], leftShoulder: [30, 0, 5], elbows: [0, 0, 0],
  },
  slashReady: {
    ...STANCE, waist: [5, -30, 0], neck: [0, 25, 0],
    rightShoulder: [150, 0, 30], rightElbow: [60, 0, 0], leftShoulder: [40, 0, -10], leftElbow: [60, 0, 0],
  },
  slash: {
    root: { pos: [0, -0.27, 0] }, waist: [-15, 30, 0], neck: [0, -25, 0],
    rightHip: [45, 0, 0], rightKnee: [-45, 0, 0], leftHip: [-20, 0, 0], leftKnee: [-25, 0, 0], leftAnkle: [45, 0, 0],
    rightShoulder: [60, 0, -30], rightElbow: [10, 0, 0], leftShoulder: [-20, 0, -20], leftElbow: [30, 0, 0],
  },
  point: {
    rightShoulder: [90, 0, 5], rightElbow: [0, 0, 0], leftShoulder: [0, 0, -8], leftElbow: [10, 0, 0], neck: [0, 0, 0],
  },
  block: {
    ...STANCE, waist: [-10, 0, 0], neck: [-10, 0, 0],
    rightShoulder: [80, 0, -25], rightElbow: [100, 0, 0], leftShoulder: [80, 0, 25], leftElbow: [100, 0, 0],
  },
  wave: { rightShoulder: [0, 0, 150], rightElbow: [20, 0, 0], leftShoulder: [0, 0, -6], neck: [0, 0, -5] },
  cheer: { rightShoulder: [10, 0, 150], leftShoulder: [10, 0, -150], elbows: [10, 0, 0], neck: [20, 0, 0] },
  hurt: {
    root: { pos: [0, -0.1, 0.4] }, waist: [25, 0, 0], neck: [25, 0, 0], hips: [25, 0, 0], knees: [-20, 0, 0],
    rightShoulder: [40, 0, 40], leftShoulder: [40, 0, -40], elbows: [20, 0, 0],
  },
  sit: {
    root: { pos: [0, -0.83, 0] }, hips: [90, 0, 0], knees: [-90, 0, 0],
    rightShoulder: [40, 0, 5], leftShoulder: [40, 0, -5], elbows: [30, 0, 0],
  },
  bow: { waist: [-45, 0, 0], neck: [-15, 0, 0], rightShoulder: [45, 0, 0], leftShoulder: [45, 0, 0] },
} satisfies PoseLib;

export type PoseName = keyof typeof POSES;
export const POSE_NAMES = Object.keys(POSES) as [PoseName, ...PoseName[]];

/** "hips", "knees", "elbows"… set both sides at once. */
const PAIRS: Record<string, [string, string]> = {
  hips: ["leftHip", "rightHip"], knees: ["leftKnee", "rightKnee"], ankles: ["leftAnkle", "rightAnkle"],
  shoulders: ["leftShoulder", "rightShoulder"], elbows: ["leftElbow", "rightElbow"], wrists: ["leftWrist", "rightWrist"],
};

/** A named pose as joint → value (both-side shorthands expanded). */
export function namedPose(name: PoseName): Record<string, Vec3 | { rot?: Vec3; pos?: Vec3 }> {
  const out: Record<string, Vec3 | { rot?: Vec3; pos?: Vec3 }> = {};
  for (const [k, v] of Object.entries(POSES[name])) {
    if (!v) continue;
    const pair = PAIRS[k];
    if (pair) for (const j of pair) out[j] = structuredClone(v);
    else out[k] = structuredClone(v);
  }
  return out;
}

const SWAP: Record<string, string> = {};
for (const [l, r] of Object.values(PAIRS)) {
  SWAP[l] = r;
  SWAP[r] = l;
}

/** The same poses for the other side: left↔right swapped, turns and side tilts reversed. */
export function mirrorPoses<T extends Record<string, unknown>>(poses: T): T {
  const flip = (r: number[]) => [r[0], -r[1] || 0, -r[2] || 0];
  const out: Record<string, unknown> = {};
  for (const [joint, v] of Object.entries(poses)) {
    if (!v) continue;
    let value: unknown;
    if (Array.isArray(v)) value = flip(v);
    else {
      const p = v as { rot?: number[]; pos?: number[] };
      value = { ...(p.rot ? { rot: flip(p.rot) } : {}), ...(p.pos ? { pos: [-p.pos[0] || 0, p.pos[1], p.pos[2]] } : {}) };
    }
    out[SWAP[joint] ?? joint] = value;
  }
  return out as T;
}
