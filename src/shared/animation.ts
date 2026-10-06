// Character animations for R6 and R15 rigs.
//
// A spec is a list of keyframes. Each keyframe poses some joints with a rotation in degrees
// (applied like CFrame.Angles, R = Rx·Ry·Rz) in the joint's parent part frame, which at rest is
// the character's own frame: x = right, y = up, z = back (characters face -Z). A joint keeps
// interpolating between the keyframes that pose it, like Roblox poses. Positive x swings arms
// and legs forward and tilts the head back; positive y turns to the character's left; positive
// z tilts toward the character's right.
//
// The same joint names drive both rigs (R6 has no waist, elbows, wrists, knees or ankles and
// ignores them). For Studio, each pose becomes Motor6D.Transform:
// Part1 = Part0 · C0 · Transform · C1⁻¹, so Transform = Q⁻¹ · (offset · R) · Q with Q the
// joint's C0 rotation (identity for R15, rotated frames for R6).

import { z } from "zod";
import { applyMat, eulerXYZDeg, IDENTITY, matToEulerXYZDeg, mul, transpose, type Mat3, type Vec3 } from "./math.ts";
import { mirrorPoses, namedPose, POSE_NAMES } from "./poses.ts";

export const JOINTS = [
  "root", "waist", "neck",
  "leftShoulder", "leftElbow", "leftWrist", "rightShoulder", "rightElbow", "rightWrist",
  "leftHip", "leftKnee", "leftAnkle", "rightHip", "rightKnee", "rightAnkle",
] as const;
export type Joint = (typeof JOINTS)[number];
export const RIG_TYPES = ["R15", "R6"] as const;
export type RigType = (typeof RIG_TYPES)[number];
export const EASES = ["linear", "constant", "cubic", "elastic", "bounce"] as const;
export const EASE_DIRS = ["in", "out", "inOut"] as const;
export const PRIORITIES = ["Core", "Idle", "Movement", "Action"] as const;

const vec3 = z.array(z.number()).length(3);
export const PoseSchema = z.union([
  vec3.describe("rotation [x,y,z] degrees"),
  z.object({ rot: vec3.optional().describe("degrees"), pos: vec3.optional().describe("offset in studs; on root it moves the whole body") }),
]);
export const KeyframeSchema = z.object({
  t: z.number().min(0).max(300).describe("seconds"),
  poses: z.partialRecord(z.enum(JOINTS), PoseSchema).default({}).describe("joint → [x,y,z] degrees, or {rot, pos}"),
  pose: z.enum(POSE_NAMES).optional().describe("start from a named pose; poses tweak it"),
  from: z.number().min(0).max(300).optional().describe("start from the keyframe at this time (e.g. 0 to end a loop where it began)"),
  mirror: z.boolean().optional().describe("flip pose/from left↔right (or this keyframe's own poses)"),
  ease: z.enum(EASES).optional().describe("easing toward the next keyframe, default linear"),
  dir: z.enum(EASE_DIRS).optional().describe("default inOut"),
  name: z.string().max(60).optional().describe("marker (KeyframeReached)"),
});
export const AnimationSpecSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  rig: z.enum(RIG_TYPES).describe("R15 (15 joints) or R6 (root, neck, shoulders, hips)"),
  loop: z.boolean().optional().describe("default true"),
  priority: z.enum(PRIORITIES).optional().describe("default Action"),
  length: z.number().min(0.05).max(300).optional().describe("seconds, default = last keyframe time"),
  overlap: z.number().min(0).max(0.25).optional().describe("follow-through: head, arms and hands trail the body by this many seconds per joint (0.03–0.08 looks natural)"),
  keyframes: z.array(KeyframeSchema).min(1).max(400),
});

export type PoseValue = z.infer<typeof PoseSchema>;
export type AnimKeyframe = z.infer<typeof KeyframeSchema>;
export type AnimationSpec = z.infer<typeof AnimationSpecSchema>;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Named poses, copies (from) and mirrors turned into plain joint poses. `from` reads the other
 * keyframe after its own expansion, so a walk cycle can be {t:0, pose:"walk"}, {t:0.5, from:0,
 * mirror:true}, {t:1, from:0}.
 */
function expandKeyframes(keyframes: AnimKeyframe[], rig: RigType): AnimKeyframe[] {
  const has = new Set<string>(RIGS[rig].joints.map((j) => j.joint));
  const done = new Map<AnimKeyframe, AnimKeyframe["poses"]>();
  const resolve = (k: AnimKeyframe, depth: number): AnimKeyframe["poses"] => {
    const hit = done.get(k);
    if (hit) return hit;
    if (depth > 20) throw new Error("Keyframes copy each other in a loop (from).");
    let base: Record<string, PoseValue> = {};
    if (k.pose) base = Object.fromEntries(Object.entries(namedPose(k.pose)).filter(([j]) => has.has(j))) as Record<string, PoseValue>;
    if (k.from !== undefined) {
      const src = keyframes.find((x) => x !== k && Math.abs(x.t - k.from!) < 1e-3);
      if (!src) throw new Error(`No keyframe at ${k.from}s to copy (from).`);
      base = { ...base, ...(resolve(src, depth + 1) as Record<string, PoseValue>) };
    }
    let own = { ...(k.poses ?? {}) } as Record<string, PoseValue>;
    if (k.mirror) {
      if (k.pose || k.from !== undefined) base = mirrorPoses(base);
      else own = mirrorPoses(own);
    }
    const poses = { ...base, ...own } as AnimKeyframe["poses"];
    done.set(k, poses);
    return poses;
  };
  return keyframes.map((k) => {
    const { pose: _pose, from: _from, mirror: _mirror, ...rest } = k;
    return { ...rest, poses: resolve(k, 0) };
  });
}

/** Sort keyframes, expand named poses/copies/mirrors, merge ones at the same time, round numbers. */
export function sanitizeAnimationSpec(spec: AnimationSpec): AnimationSpec {
  const byTime = new Map<number, AnimKeyframe>();
  for (const k of expandKeyframes([...spec.keyframes].sort((a, b) => a.t - b.t), spec.rig)) {
    const t = r3(k.t);
    const poses: AnimKeyframe["poses"] = {};
    for (const [joint, v] of Object.entries(k.poses) as [Joint, PoseValue][]) {
      if (!v) continue;
      poses[joint] = Array.isArray(v) ? (v.map(r3) as Vec3) : { ...(v.rot ? { rot: v.rot.map(r3) as Vec3 } : {}), ...(v.pos ? { pos: v.pos.map(r3) as Vec3 } : {}) };
    }
    const prev = byTime.get(t);
    byTime.set(t, prev ? { ...prev, ...k, t, poses: { ...prev.poses, ...poses } } : { ...k, t, poses });
  }
  const keyframes = [...byTime.values()];
  return { ...spec, keyframes, ...(spec.length !== undefined ? { length: r3(spec.length) } : {}) };
}

export function animationLength(spec: AnimationSpec): number {
  const last = spec.keyframes[spec.keyframes.length - 1]?.t ?? 0;
  // Without a set length, a one-shot lasts until its trailing joints (overlap) settle.
  const trail = spec.length === undefined && spec.loop === false ? (spec.overlap ?? 0) * MAX_LAG : 0;
  return Math.max(spec.length ?? 0, last + trail, 0.05);
}

export function poseOf(v: PoseValue | undefined): { rot: Vec3; pos: Vec3 } {
  if (!v) return { rot: [0, 0, 0], pos: [0, 0, 0] };
  if (Array.isArray(v)) return { rot: v as Vec3, pos: [0, 0, 0] };
  return { rot: (v.rot ?? [0, 0, 0]) as Vec3, pos: (v.pos ?? [0, 0, 0]) as Vec3 };
}

// --------------------------------------------------------------------- rigs

export interface RigPart {
  name: string;
  size: Vec3;
  /** Rest position of the part's center, character standing on y = 0. */
  center: Vec3;
  color: string;
  hidden?: boolean;
}

export interface RigJoint {
  joint: Joint;
  /** Motor6D name in Roblox. */
  motor: string;
  part0: string;
  part1: string;
  /** Rest position of the joint, character space. */
  pivot: Vec3;
  /** Rotation of C0 (and C1). */
  q: Mat3;
}

export interface Rig {
  type: RigType;
  parts: RigPart[];
  /** Parents before children. */
  joints: RigJoint[];
}

// Roblox's default rig colour (Medium stone grey), like the dummies Studio's Rig Builder makes.
const HEAD = "#a3a2a5", TORSO = "#a3a2a5", LEGS = "#a3a2a5";

const R6_ROOT_Q: Mat3 = [-1, 0, 0, 0, 0, 1, 0, 1, 0];
const R6_RIGHT_Q: Mat3 = [0, 0, 1, 0, 1, 0, -1, 0, 0];
const R6_LEFT_Q: Mat3 = [0, 0, -1, 0, 1, 0, 1, 0, 0];

const R6: Rig = {
  type: "R6",
  parts: [
    { name: "HumanoidRootPart", size: [2, 2, 1], center: [0, 3, 0], color: TORSO, hidden: true },
    { name: "Torso", size: [2, 2, 1], center: [0, 3, 0], color: TORSO },
    { name: "Head", size: [2, 1, 1], center: [0, 4.5, 0], color: HEAD },
    { name: "Right Arm", size: [1, 2, 1], center: [1.5, 3, 0], color: HEAD },
    { name: "Left Arm", size: [1, 2, 1], center: [-1.5, 3, 0], color: HEAD },
    { name: "Right Leg", size: [1, 2, 1], center: [0.5, 1, 0], color: LEGS },
    { name: "Left Leg", size: [1, 2, 1], center: [-0.5, 1, 0], color: LEGS },
  ],
  joints: [
    { joint: "root", motor: "RootJoint", part0: "HumanoidRootPart", part1: "Torso", pivot: [0, 3, 0], q: R6_ROOT_Q },
    { joint: "neck", motor: "Neck", part0: "Torso", part1: "Head", pivot: [0, 4, 0], q: R6_ROOT_Q },
    { joint: "rightShoulder", motor: "Right Shoulder", part0: "Torso", part1: "Right Arm", pivot: [1, 3.5, 0], q: R6_RIGHT_Q },
    { joint: "leftShoulder", motor: "Left Shoulder", part0: "Torso", part1: "Left Arm", pivot: [-1, 3.5, 0], q: R6_LEFT_Q },
    { joint: "rightHip", motor: "Right Hip", part0: "Torso", part1: "Right Leg", pivot: [1, 2, 0], q: R6_RIGHT_Q },
    { joint: "leftHip", motor: "Left Hip", part0: "Torso", part1: "Left Leg", pivot: [-1, 2, 0], q: R6_LEFT_Q },
  ],
};

function r15(): Rig {
  const parts: RigPart[] = [
    { name: "HumanoidRootPart", size: [2, 2, 1], center: [0, 2.921, 0], color: TORSO, hidden: true },
    { name: "LowerTorso", size: [2, 0.4, 1], center: [0, 2.121, 0], color: TORSO },
    { name: "UpperTorso", size: [2, 1.6, 1], center: [0, 3.121, 0], color: TORSO },
    // The block rig's cube head.
    { name: "Head", size: [1.2, 1.2, 1.2], center: [0, 4.421, 0], color: HEAD },
  ];
  const joints: RigJoint[] = [
    { joint: "root", motor: "Root", part0: "HumanoidRootPart", part1: "LowerTorso", pivot: [0, 1.921, 0], q: IDENTITY },
    { joint: "waist", motor: "Waist", part0: "LowerTorso", part1: "UpperTorso", pivot: [0, 2.321, 0], q: IDENTITY },
    { joint: "neck", motor: "Neck", part0: "UpperTorso", part1: "Head", pivot: [0, 3.921, 0], q: IDENTITY },
  ];
  for (const [side, s] of [["Right", 1], ["Left", -1]] as const) {
    const lower = side.toLowerCase() as "right" | "left";
    parts.push(
      { name: `${side}UpperArm`, size: [1, 1.169, 1], center: [1.5 * s, 3.288, 0], color: HEAD },
      { name: `${side}LowerArm`, size: [1, 1.052, 1], center: [1.5 * s, 2.692, 0], color: HEAD },
      { name: `${side}Hand`, size: [1, 0.3, 1], center: [1.5 * s, 2.066, 0], color: HEAD },
      { name: `${side}UpperLeg`, size: [1, 1.217, 1], center: [0.5 * s, 1.501, 0], color: LEGS },
      { name: `${side}LowerLeg`, size: [1, 1.193, 1], center: [0.5 * s, 0.799, 0], color: LEGS },
      { name: `${side}Foot`, size: [1, 0.3, 1], center: [0.5 * s, 0.15, 0], color: LEGS },
    );
    joints.push(
      { joint: `${lower}Shoulder`, motor: `${side}Shoulder`, part0: "UpperTorso", part1: `${side}UpperArm`, pivot: [1 * s, 3.684, 0], q: IDENTITY },
      { joint: `${lower}Elbow`, motor: `${side}Elbow`, part0: `${side}UpperArm`, part1: `${side}LowerArm`, pivot: [1.5 * s, 2.954, 0], q: IDENTITY },
      { joint: `${lower}Wrist`, motor: `${side}Wrist`, part0: `${side}LowerArm`, part1: `${side}Hand`, pivot: [1.5 * s, 2.191, 0], q: IDENTITY },
      { joint: `${lower}Hip`, motor: `${side}Hip`, part0: "LowerTorso", part1: `${side}UpperLeg`, pivot: [0.5 * s, 1.921, 0], q: IDENTITY },
      { joint: `${lower}Knee`, motor: `${side}Knee`, part0: `${side}UpperLeg`, part1: `${side}LowerLeg`, pivot: [0.5 * s, 1.093, 0], q: IDENTITY },
      { joint: `${lower}Ankle`, motor: `${side}Ankle`, part0: `${side}LowerLeg`, part1: `${side}Foot`, pivot: [0.5 * s, 0.251, 0], q: IDENTITY },
    );
  }
  return { type: "R15", parts, joints };
}

export const RIGS: Record<RigType, Rig> = { R6, R15: r15() };

// ------------------------------------------------------------ interpolation

type Quat = [number, number, number, number]; // x, y, z, w

function quatFromMat(m: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  return [x, y, z, w];
}

function matFromQuat([x, y, z, w]: Quat): Mat3 {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

function slerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (cos < 0) {
    cos = -cos;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (cos > 0.9995) {
    const out = a.map((v, i) => v + (bb[i] - v) * t) as Quat;
    const len = Math.hypot(...out);
    return out.map((v) => v / len) as Quat;
  }
  const theta = Math.acos(cos);
  const sa = Math.sin((1 - t) * theta) / Math.sin(theta), sb = Math.sin(t * theta) / Math.sin(theta);
  return a.map((v, i) => v * sa + bb[i] * sb) as Quat;
}

const bounceOut = (t: number) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
const elasticOut = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1);

/** Progress between two keyframes, like TweenService easing. */
export function ease(style: (typeof EASES)[number] | undefined, dir: (typeof EASE_DIRS)[number] | undefined, t: number): number {
  const d = dir ?? "inOut";
  const curve = (f: (x: number) => number) => (d === "in" ? 1 - f(1 - t) : d === "out" ? f(t) : t < 0.5 ? (1 - f(1 - 2 * t)) / 2 : (1 + f(2 * t - 1)) / 2);
  switch (style) {
    case "constant":
      return 0;
    case "cubic":
      return curve((x) => 1 - Math.pow(1 - x, 3));
    case "elastic":
      return curve(elasticOut);
    case "bounce":
      return curve(bounceOut);
    default:
      return t;
  }
}

export interface JointPose {
  rot: Mat3;
  pos: Vec3;
}

interface TrackKey {
  t: number;
  q: Quat;
  pos: Vec3;
  ease?: AnimKeyframe["ease"];
  dir?: AnimKeyframe["dir"];
}

/** Per-joint key lists, built once per spec (overlap applied). */
export function buildTracks(spec: AnimationSpec): Map<Joint, TrackKey[]> {
  return rawTracks(bakedKeyframes(spec));
}

function rawTracks(keyframes: AnimKeyframe[]): Map<Joint, TrackKey[]> {
  const tracks = new Map<Joint, TrackKey[]>();
  for (const k of keyframes) {
    for (const [joint, v] of Object.entries(k.poses) as [Joint, PoseValue][]) {
      if (!v) continue;
      const p = poseOf(v);
      const list = tracks.get(joint) ?? [];
      list.push({ t: k.t, q: quatFromMat(eulerXYZDeg(p.rot)), pos: p.pos, ease: k.ease, dir: k.dir });
      tracks.set(joint, list);
    }
  }
  return tracks;
}

/** Every joint's pose at time t (seconds, already wrapped for looping). */
export function sampleTracks(tracks: Map<Joint, TrackKey[]>, t: number): Partial<Record<Joint, JointPose>> {
  const out: Partial<Record<Joint, JointPose>> = {};
  for (const [joint, keys] of tracks) {
    let i = keys.length - 1;
    while (i > 0 && keys[i].t > t) i--;
    const a = keys[i], b = keys[i + 1];
    if (!b || t <= a.t) {
      const k = t <= keys[0].t ? keys[0] : a;
      out[joint] = { rot: matFromQuat(k.q), pos: k.pos };
      continue;
    }
    const f = ease(a.ease, a.dir, (t - a.t) / (b.t - a.t));
    out[joint] = {
      rot: matFromQuat(slerp(a.q, b.q, f)),
      pos: [0, 1, 2].map((n) => a.pos[n] + (b.pos[n] - a.pos[n]) * f) as Vec3,
    };
  }
  return out;
}

// ---------------------------------------------------------------- follow-through

/** How many overlap steps each joint trails the body by (legs stay planted). */
const LAG: Partial<Record<Joint, number>> = { neck: 1, leftShoulder: 1, rightShoulder: 1, leftElbow: 2, rightElbow: 2, leftWrist: 3, rightWrist: 3 };
const MAX_LAG = 3;

/**
 * The keyframes as played: with overlap, each trailing joint's keys move later (wrapping around
 * in loops, with matching keys at the start and end), so arms and head follow through. Used by
 * the preview and by every Studio export, so both play the same thing.
 */
export function bakedKeyframes(spec: AnimationSpec): AnimKeyframe[] {
  const o = spec.overlap ?? 0;
  if (!o) return spec.keyframes;
  const loop = spec.loop !== false;
  const len = animationLength(spec);
  const tracks = rawTracks(spec.keyframes);
  const out = new Map<number, AnimKeyframe>();
  const key = (t: number, from?: AnimKeyframe): AnimKeyframe => {
    const at = Math.round(t * 1000) / 1000;
    let k = out.get(at);
    if (!k) out.set(at, (k = { t: at, poses: {}, ...(from?.ease ? { ease: from.ease } : {}), ...(from?.dir ? { dir: from.dir } : {}) }));
    return k;
  };
  const asValue = (p: JointPose): PoseValue => {
    const rot = matToEulerXYZDeg(p.rot).map((v) => Math.round(v * 1000) / 1000) as Vec3;
    return p.pos.some((v) => Math.abs(v) > 1e-6) ? { rot, pos: p.pos } : rot;
  };
  for (const k of spec.keyframes) {
    const named = key(k.t, k);
    if (k.name) named.name = k.name;
    for (const [joint, v] of Object.entries(k.poses) as [Joint, PoseValue][]) {
      if (!v) continue;
      const d = (LAG[joint] ?? 0) * o;
      let t = k.t + d;
      if (loop && t > len + 1e-6) t -= len;
      key(t, k).poses[joint] = v;
    }
  }
  if (loop) {
    // The trailing joints' value at the loop seam, on both ends, so the loop stays seamless.
    for (const [joint, keys] of tracks) {
      const d = (LAG[joint] ?? 0) * o;
      if (!d || keys.length < 2) continue;
      const seam = asValue(sampleTracks(new Map([[joint, keys]]), Math.max(0, len - d))[joint]!);
      for (const t of [0, len]) {
        const k = key(t);
        if (!k.poses[joint]) k.poses[joint] = seam;
      }
    }
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/** World transform of every rig part for a set of joint poses (forward kinematics). */
export function poseRig(rig: Rig, poses: Partial<Record<Joint, JointPose>>): Map<string, { rot: Mat3; pos: Vec3 }> {
  const rest = new Map(rig.parts.map((p) => [p.name, p.center]));
  const world = new Map<string, { rot: Mat3; pos: Vec3 }>();
  const rootPart = rig.parts[0];
  world.set(rootPart.name, { rot: [...IDENTITY], pos: [...rootPart.center] });
  for (const j of rig.joints) {
    const w0 = world.get(j.part0)!;
    const c0 = rest.get(j.part0)!, c1 = rest.get(j.part1)!;
    const pose = poses[j.joint];
    const R = pose?.rot ?? IDENTITY;
    const d = pose?.pos ?? [0, 0, 0];
    const pv: Vec3 = [j.pivot[0] - c0[0], j.pivot[1] - c0[1], j.pivot[2] - c0[2]];
    const rel: Vec3 = [c1[0] - c0[0] - pv[0], c1[1] - c0[1] - pv[1], c1[2] - c0[2] - pv[2]];
    const turned = applyMat(R, rel);
    const local: Vec3 = [pv[0] + d[0] + turned[0], pv[1] + d[1] + turned[1], pv[2] + d[2] + turned[2]];
    const off = applyMat(w0.rot, local);
    world.set(j.part1, { rot: mul(w0.rot, R), pos: [w0.pos[0] + off[0], w0.pos[1] + off[1], w0.pos[2] + off[2]] });
  }
  return world;
}

/** Motor6D.Transform (Pose.CFrame) for a joint pose: Q⁻¹ · (offset · R) · Q. */
export function jointTransform(j: RigJoint, pose: { rot: Mat3; pos: Vec3 }): { rot: Mat3; pos: Vec3 } {
  const qt = transpose(j.q);
  return { rot: mul(mul(qt, pose.rot), j.q), pos: applyMat(qt, pose.pos) };
}

export function poseAt(spec: AnimationSpec, rig: Rig, t: number, tracks = buildTracks(spec)) {
  return poseRig(rig, sampleTracks(tracks, t));
}

// ------------------------------------------------------------------- checks

const angle = (a: Mat3, b: Mat3) => {
  const tr = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6] + a[7] * b[7] + a[8] * b[8];
  return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
};

/**
 * Problems Claude can fix before the user sees them: joints bending the wrong way, feet sinking
 * into the floor or never reaching it, and loops that jump at the seam. Short lines, worst first.
 */
export function checkAnimation(spec: AnimationSpec): string[] {
  const rig = RIGS[spec.rig];
  const out: string[] = [];
  const seen = new Set<string>();
  const once = (k: string, line: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    out.push(line);
  };
  for (const k of spec.keyframes) {
    for (const [joint, v] of Object.entries(k.poses) as [Joint, PoseValue][]) {
      const [x, y] = poseOf(v).rot;
      if (/Knee$/.test(joint) && x > 8) once(joint, `${joint} bends backward (x ${x}) at ${k.t}s: knees bend with -x`);
      if (/Elbow$/.test(joint) && x < -8) once(joint, `${joint} bends backward (x ${x}) at ${k.t}s: elbows bend with +x`);
      if (joint === "neck" && (Math.abs(x) > 75 || Math.abs(y) > 85)) once(joint, `neck turns past what a head can (${x}, ${y}) at ${k.t}s`);
    }
  }
  // Floor contact, sampled at 30 fps.
  const feet = rig.type === "R15" ? ["LeftFoot", "RightFoot"] : ["Left Leg", "Right Leg"];
  const sizes = new Map(rig.parts.map((p) => [p.name, p.size]));
  const tracks = buildTracks(spec);
  const len = animationLength(spec);
  let lowest = Infinity, lowestAt = 0, highest = -Infinity;
  for (let t = 0; t <= len + 1e-6; t += 1 / 30) {
    const world = poseRig(rig, sampleTracks(tracks, t));
    let low = Infinity;
    for (const f of feet) {
      const w = world.get(f)!;
      const h = sizes.get(f)!.map((v) => v / 2);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        low = Math.min(low, w.pos[1] + w.rot[3] * h[0] * sx + w.rot[4] * h[1] * sy + w.rot[5] * h[2] * sz);
      }
    }
    if (low < lowest) {
      lowest = low;
      lowestAt = t;
    }
    highest = Math.max(highest, -low);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  if (lowest < -0.3) out.push(`feet go ${r2(-lowest)} studs into the floor at ${r2(lowestAt)}s: raise root pos y or bend the knees less`);
  if (lowest > 0.5) out.push(`feet never touch the floor (lowest ${r2(lowest)} studs up): lower root pos y`);
  if (spec.loop !== false && spec.keyframes.length > 1) {
    const start = sampleTracks(tracks, 0), end = sampleTracks(tracks, len);
    const moved = (a: JointPose, b: JointPose) => angle(a.rot, b.rot) > 20 || Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) > 0.3;
    const jumps = (Object.keys(start) as Joint[]).filter((j) => end[j] && moved(start[j]!, end[j]!));
    if (jumps.length) out.push(`it jumps when it loops (${jumps.slice(0, 4).join(", ")}): end with the start pose ({t: ${r2(len)}, from: 0})`);
  }
  if (spec.keyframes.length === 1) out.push("only one keyframe: the pose never moves");
  return out.slice(0, 6);
}

export const jointsOf = (spec: AnimationSpec) => [...new Set(spec.keyframes.flatMap((k) => Object.keys(k.poses)))] as Joint[];

/** Joints this rig can't play (R6 has no elbows, knees …). */
export function unsupportedJoints(spec: AnimationSpec, rig: Rig): Joint[] {
  const has = new Set(rig.joints.map((j) => j.joint));
  return jointsOf(spec).filter((j) => !has.has(j));
}

// ------------------------------------------------------------------ editing

export const AnimationEditSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  rig: z.enum(RIG_TYPES).optional(),
  loop: z.boolean().optional(),
  priority: z.enum(PRIORITIES).optional(),
  length: z.number().min(0.05).max(300).optional(),
  keyframes: z.array(KeyframeSchema).optional().describe("merged into the keyframe at the same t (poses merge; ease/dir/name replace), or added"),
  remove: z.array(z.number()).optional().describe("times (s) of keyframes to delete"),
  clear: z.array(z.enum(JOINTS)).optional().describe("joints to remove from every keyframe"),
  speed: z.number().min(0.05).max(20).optional().describe("play faster (>1) or slower: all times are divided by it"),
  overlap: z.number().min(0).max(0.25).optional().describe("follow-through seconds per joint (0 = off)"),
});
export type AnimationEdit = z.infer<typeof AnimationEditSchema>;

export function applyAnimationEdit(spec: AnimationSpec, edit: AnimationEdit): { spec: AnimationSpec; missing: number[] } {
  const missing: number[] = [];
  let keyframes = spec.keyframes.map((k) => ({ ...k, poses: { ...k.poses } }));
  if (edit.remove?.length) {
    for (const t of edit.remove) if (!keyframes.some((k) => Math.abs(k.t - t) < 1e-3)) missing.push(t);
    keyframes = keyframes.filter((k) => !edit.remove!.some((t) => Math.abs(k.t - t) < 1e-3));
  }
  if (edit.clear?.length) {
    for (const k of keyframes) for (const j of edit.clear) delete k.poses[j];
    keyframes = keyframes.filter((k) => Object.keys(k.poses).length > 0);
  }
  for (const add of edit.keyframes ?? []) {
    const at = keyframes.find((k) => Math.abs(k.t - add.t) < 1e-3);
    // A named pose, copy or mirror rebuilds the keyframe; plain poses merge into it.
    const rebuild = add.pose !== undefined || add.from !== undefined || add.mirror;
    if (at) Object.assign(at, { ...add, t: at.t, poses: rebuild ? { ...add.poses } : { ...at.poses, ...add.poses } });
    else keyframes.push({ ...add, poses: { ...add.poses } });
  }
  let length = edit.length ?? spec.length;
  if (edit.speed) {
    keyframes = keyframes.map((k) => ({ ...k, t: k.t / edit.speed! }));
    if (length !== undefined) length /= edit.speed;
  }
  if (!keyframes.length) throw new Error("The edit would leave the animation without keyframes.");
  const next: AnimationSpec = {
    ...spec,
    ...(edit.name ? { name: edit.name } : {}),
    ...(edit.rig ? { rig: edit.rig } : {}),
    ...(edit.loop !== undefined ? { loop: edit.loop } : {}),
    ...(edit.priority ? { priority: edit.priority } : {}),
    ...(edit.overlap !== undefined ? { overlap: edit.overlap } : {}),
    ...(length !== undefined ? { length } : {}),
    keyframes,
  };
  return { spec: sanitizeAnimationSpec(next), missing };
}
