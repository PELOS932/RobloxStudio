// Plays an ability in three.js: the rig runs the animation and every event's effect is spawned at
// its time, attached to a body part, the ground or the cast spot, or flown as a projectile that
// ends in an impact effect. Deterministic (seeded), so scrubbing re-simulates from the start.
import * as THREE from "three";
import { buildTracks, poseRig, RIGS, sampleTracks, type RigType } from "../../shared/animation.ts";
import { ATTACH, SUMMON_DEFAULTS, type AbilityEvent, type ResolvedAbility, type ResolvedEvent, type ResolvedProp, type ResolvedSummon } from "../../shared/ability.ts";
import { animationLength } from "../../shared/animation.ts";
import { toNativeModel } from "../../shared/model.ts";
import type { Mat3, Vec3 } from "../../shared/math.ts";
import { applyPose, buildRig, type RigMeshes } from "./rig3d.ts";
import { createVfx, mulberry, type VfxRuntime } from "./vfx3d.ts";
import { materialFor, tileOf } from "./materials.ts";
import { partGeometry, partMatrix } from "./geometry.ts";

const STEP = 1 / 30;

interface Live {
  ev: ResolvedEvent;
  rt: VfxRuntime;
  born: number;
  stopped: boolean;
  /** Projectiles: where and how it flies (world). */
  origin?: THREE.Vector3;
  velocity?: THREE.Vector3;
  /** Fixed placement (ground / world / impact). */
  fixed?: THREE.Matrix4;
  impact?: boolean;
}

interface LiveSummon {
  rs: ResolvedSummon;
  meshes: RigMeshes;
  tracks: ReturnType<typeof buildTracks> | null;
  animLen: number;
  loops: boolean;
  aura: VfxRuntime | null;
  auraAt?: THREE.Matrix4;
}

interface LiveProp {
  rp: ResolvedProp;
  group: THREE.Group;
  materials: { m: THREE.Material; opacity: number }[];
  geometries: THREE.BufferGeometry[];
  height: number;
  life: number;
  fixed?: THREE.Matrix4;
  flight?: { origin: THREE.Vector3; velocity: THREE.Vector3; turn: THREE.Quaternion; landed?: THREE.Matrix4 };
}

const smooth = (k: number) => k * k * (3 - 2 * k);
const clamp01 = (k: number) => Math.max(0, Math.min(1, k));

/** Appear (0 → 1) and vanish (1 → 0) progress. */
function fades(age: number, life: number, fade: number): [number, number] {
  if (fade <= 0) return [1, age < life ? 1 : 0];
  return [clamp01(age / fade), clamp01((life + fade - age) / fade)];
}

/** A summon's offset along its path at this age (smooth between points). */
export function summonOffset(rs: ResolvedSummon, age: number): THREE.Vector3 {
  let last = new THREE.Vector3(...((rs.summon.offset ?? SUMMON_DEFAULTS.offset) as Vec3)), lastT = 0;
  for (const p of rs.summon.path ?? []) {
    const o = new THREE.Vector3(...(p.offset as Vec3));
    if (age <= p.t) {
      const span = p.t - lastT;
      return last.lerp(o, smooth(span > 0 ? clamp01((age - lastT) / span) : 1));
    }
    last = o;
    lastT = p.t;
  }
  return last;
}

export interface AbilityScene {
  group: THREE.Group;
  length: number;
  time(): number;
  /** Advance (play). Wraps around at the end when looping. */
  update(dt: number, camera: THREE.Camera): void;
  /** Jump to a time: re-simulates from 0 so effects look exactly as they would in playback. */
  seek(t: number, camera: THREE.Camera): void;
  /** Rig and effects together (for framing). */
  bounds(): THREE.Box3;
  dispose(): void;
}

function toMatrix(rot: Mat3, pos: Vec3 | THREE.Vector3): THREE.Matrix4 {
  const p = pos instanceof THREE.Vector3 ? pos : new THREE.Vector3(...pos);
  return new THREE.Matrix4().set(rot[0], rot[1], rot[2], p.x, rot[3], rot[4], rot[5], p.y, rot[6], rot[7], rot[8], p.z, 0, 0, 0, 1);
}

export function createAbilityScene(resolved: ResolvedAbility, rigType: RigType, opts: { loop?: boolean; seed?: number } = {}): AbilityScene {
  const group = new THREE.Group();
  const rig = RIGS[rigType];
  const meshes: RigMeshes = buildRig(rig);
  group.add(meshes.group);
  const anim = resolved.animation;
  const tracks = anim ? buildTracks(anim) : null;
  const animLen = anim ? animationLength(anim) : 0;
  const animLoops = !!anim && anim.loop !== false;
  const length = resolved.length;
  const loop = opts.loop ?? true;
  const seed = opts.seed ?? 1;
  let rng = mulberry(seed);
  let time = 0;
  let live: Live[] = [];
  let pending = [...resolved.events];
  let summons: LiveSummon[] = [];
  let pendingSummons = [...resolved.summons];
  let props: LiveProp[] = [];
  let pendingProps = [...resolved.props];
  let world = poseRig(rig, {});
  let casterAt = 0;

  const pose = (t: number) => {
    const at = !tracks ? 0 : animLoops ? t % animLen : Math.min(t, animLen);
    casterAt = at;
    world = poseRig(rig, tracks ? sampleTracks(tracks, at) : {});
    applyPose(meshes, world);
  };

  /** Attach frame for an event right now (character frame = world, the character stands at the origin facing -Z). */
  const frame = (ev: ResolvedEvent): THREE.Matrix4 => {
    const e = ev.event;
    const offset = new THREE.Vector3(...((e.offset ?? [0, 0, 0]) as Vec3));
    const where = e.attach ?? "root";
    if (where === "ground" || where === "world") {
      const root = world.get("HumanoidRootPart")!;
      const p = new THREE.Vector3(...root.pos);
      if (where === "ground") p.y = 0;
      return new THREE.Matrix4().makeTranslation(p.add(offset));
    }
    const a = ATTACH[rigType][where];
    const part = world.get(a.part) ?? world.get("HumanoidRootPart")!;
    const rot = toMatrix(part.rot, [0, 0, 0]);
    const anchor = new THREE.Vector3(...a.offset).applyMatrix4(rot).add(new THREE.Vector3(...part.pos));
    if (e.follow === "part") return toMatrix(part.rot, anchor).multiply(new THREE.Matrix4().makeTranslation(offset));
    return new THREE.Matrix4().makeTranslation(anchor.add(offset));
  };

  const spawn = (ev: ResolvedEvent, camera: THREE.Camera) => {
    const rt = createVfx(ev.vfx, rng, { external: true });
    const m = frame(ev);
    const item: Live = { ev, rt, born: ev.event.at, stopped: false };
    const travel = ev.event.travel;
    if (travel) {
      item.origin = new THREE.Vector3().setFromMatrixPosition(m);
      item.velocity = new THREE.Vector3(...(travel.velocity as Vec3));
    } else if (ev.event.attach === "ground" || ev.event.attach === "world") item.fixed = m;
    rt.setRoot(placeOf(item, ev.event.at));
    rt.burst();
    group.add(rt.object);
    live.push(item);
    void camera;
  };

  /** Where a live effect's root is at time t. */
  const placeOf = (item: Live, t: number): THREE.Matrix4 => {
    if (item.fixed) return item.fixed;
    if (item.origin && item.velocity) {
      const dt = t - item.born;
      const g = item.ev.event.travel?.gravity ?? 0;
      const p = item.origin.clone().addScaledVector(item.velocity, dt);
      p.y -= 0.5 * g * dt * dt;
      const dir = item.velocity.clone().setY(item.velocity.y - g * dt);
      const m = new THREE.Matrix4();
      if (dir.lengthSq() > 1e-6) m.lookAt(p, p.clone().add(dir), new THREE.Vector3(0, 1, 0));
      return m.setPosition(p);
    }
    return frame(item.ev);
  };

  const impact = (item: Live, at: THREE.Matrix4) => {
    if (!item.ev.impact) return;
    const rt = createVfx(item.ev.impact, rng, { external: true });
    // Impacts stand upright where the projectile ended.
    const m = new THREE.Matrix4().makeTranslation(new THREE.Vector3().setFromMatrixPosition(at));
    rt.setRoot(m);
    rt.burst();
    group.add(rt.object);
    live.push({ ev: { ...item.ev, vfx: item.ev.impact }, rt, born: time, stopped: false, fixed: m, impact: true });
    // An impact runs as long as its own effect (one-shots end by themselves).
    const end = live[live.length - 1];
    end.born = time;
  };

  // Summons ------------------------------------------------------------------
  const casterRoot = () => {
    const r = world.get("HumanoidRootPart")!;
    return toMatrix(r.rot, r.pos);
  };

  const spawnSummon = (rs: ResolvedSummon) => {
    const s = rs.summon;
    const meshes = buildRig(RIGS[rs.rig], {
      color: s.color ?? SUMMON_DEFAULTS.color,
      material: s.material ?? SUMMON_DEFAULTS.material,
      transparency: s.transparency ?? SUMMON_DEFAULTS.transparency,
    });
    meshes.group.matrixAutoUpdate = false;
    group.add(meshes.group);
    const anim = rs.caster ? null : rs.animation;
    let aura: VfxRuntime | null = null;
    if (rs.vfx) {
      aura = createVfx(rs.vfx, rng, { external: true });
      aura.burst();
      group.add(aura.object);
    }
    summons.push({
      rs, meshes, aura,
      tracks: anim ? buildTracks(anim) : null,
      animLen: anim ? animationLength(anim) : 0,
      loops: !!anim && anim.loop !== false,
    });
  };

  const updateSummon = (l: LiveSummon, dt: number, camera: THREE.Camera) => {
    const s = l.rs.summon;
    const age = time - s.at;
    const life = l.rs.until - s.at;
    const fade = s.fade ?? SUMMON_DEFAULTS.fade;
    const [fin, fout] = fades(age, life, fade);
    const appear = s.appear ?? "fade";
    const sRig = RIGS[l.rs.rig];
    // Its pose: the caster's animation in step, its own from when it appeared, or standing still.
    let poses = {};
    if (l.rs.caster && tracks) poses = sampleTracks(tracks, casterAt);
    else if (l.tracks) poses = sampleTracks(l.tracks, l.loops ? age % l.animLen : Math.min(age, l.animLen));
    const posed = poseRig(sRig, poses);
    applyPose(l.meshes, posed);
    const scale = (s.scale ?? SUMMON_DEFAULTS.scale) * (appear === "grow" ? Math.max(0.05, fin) : 1);
    const bob = (s.hover ?? SUMMON_DEFAULTS.hover) * Math.sin(age * 2.5);
    const hrp = sRig.parts[0].center;
    const m = casterRoot()
      .multiply(new THREE.Matrix4().makeTranslation(summonOffset(l.rs, age).add(new THREE.Vector3(0, bob, 0))))
      .multiply(new THREE.Matrix4().makeRotationY(((s.turn ?? 0) * Math.PI) / 180))
      .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
      .multiply(new THREE.Matrix4().makeTranslation(-hrp[0], -hrp[1], -hrp[2]));
    l.meshes.group.matrix.copy(m);
    l.meshes.group.matrixWorldNeedsUpdate = true;
    l.meshes.fade((appear === "fade" ? fin : 1) * fout);
    if (l.aura) {
      const torso = posed.get(l.rs.rig === "R15" ? "UpperTorso" : "Torso") ?? posed.get("HumanoidRootPart")!;
      l.auraAt = m.clone().multiply(new THREE.Matrix4().makeTranslation(...(torso.pos as Vec3)));
      l.aura.setRoot(l.auraAt);
      l.aura.update(dt, camera);
    }
  };

  // Props --------------------------------------------------------------------
  const spawnProp = (rp: ResolvedProp) => {
    const native = toNativeModel(rp.model);
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;
    const materials: LiveProp["materials"] = [];
    const geometries: THREE.BufferGeometry[] = [];
    for (const part of native.parts) {
      if (part.transparency >= 0.98) continue;
      const m = materialFor(part.material, part.color, part.transparency, part.reflectance).clone();
      m.transparent = true;
      materials.push({ m, opacity: m.opacity });
      const geo = partGeometry(part, tileOf(part.material));
      geometries.push(geo);
      const mesh = new THREE.Mesh(geo, m);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(partMatrix(part));
      mesh.castShadow = part.material !== "Neon";
      g.add(mesh);
    }
    group.add(g);
    const item: LiveProp = { rp, group: g, materials, geometries, height: Math.max(0.1, native.bounds.max[1]) * (rp.prop.scale ?? 1), life: rp.until - rp.prop.at };
    const where = rp.prop.attach ?? "rightHand";
    if (where === "ground" || where === "world") item.fixed = propBase(rp);
    if (rp.prop.travel) {
      const start = propBase(rp).multiply(eulerMatrix(rp.prop.rot));
      item.flight = {
        origin: new THREE.Vector3().setFromMatrixPosition(start),
        velocity: new THREE.Vector3(...(rp.prop.travel.velocity as Vec3)),
        turn: new THREE.Quaternion().setFromRotationMatrix(start),
      };
    }
    props.push(item);
  };

  const eulerMatrix = (deg: number[] | undefined, k = 1) =>
    new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(((deg?.[0] ?? 0) * k * Math.PI) / 180, ((deg?.[1] ?? 0) * k * Math.PI) / 180, ((deg?.[2] ?? 0) * k * Math.PI) / 180, "XYZ"));

  /** Where a prop's grip is right now (the attach frame with the offset). */
  const propBase = (rp: ResolvedProp): THREE.Matrix4 => {
    const where = rp.prop.attach ?? "rightHand";
    const offset = new THREE.Matrix4().makeTranslation(...((rp.prop.offset ?? [0, 0, 0]) as Vec3));
    if (where === "ground" || where === "world") {
      const root = world.get("HumanoidRootPart")!;
      const p = new THREE.Vector3(...root.pos);
      if (where === "ground") p.y = 0;
      return toMatrix(root.rot, p).multiply(offset);
    }
    const a = ATTACH[rigType][where];
    const part = world.get(a.part) ?? world.get("HumanoidRootPart")!;
    const anchor = new THREE.Vector3(...a.offset).applyMatrix4(toMatrix(part.rot, [0, 0, 0])).add(new THREE.Vector3(...part.pos));
    const turn = rp.prop.follow === "character" ? world.get("HumanoidRootPart")!.rot : part.rot;
    return toMatrix(turn, anchor).multiply(offset);
  };

  const updateProp = (l: LiveProp, camera: THREE.Camera) => {
    const p = l.rp.prop;
    const age = time - p.at;
    const fade = p.fade ?? 0.2;
    let m: THREE.Matrix4;
    if (l.flight && !l.flight.landed) {
      const g = p.travel?.gravity ?? 0;
      const at = l.flight.origin.clone().addScaledVector(l.flight.velocity, age);
      at.y -= 0.5 * g * age * age;
      const hit = p.travel?.stopOnHit !== false && at.y <= 0 && age > 0.05;
      if (hit) at.y = 0;
      m = new THREE.Matrix4().compose(at, l.flight.turn, new THREE.Vector3(1, 1, 1)).multiply(eulerMatrix(p.spin, age));
      if (hit || age >= l.life) {
        l.flight.landed = m.clone();
        l.life = Math.min(l.life, age);
        if (l.rp.impact) impactAt(l.rp, m);
      }
    } else if (l.flight?.landed) m = l.flight.landed.clone();
    else m = (l.fixed ? l.fixed.clone() : propBase(l.rp)).multiply(eulerMatrix(p.rot)).multiply(eulerMatrix(p.spin, age));
    const [fin, fout] = fades(age, l.life, fade);
    let show = 1, size = 1;
    const appear = p.appear ?? "fade", vanish = p.vanish ?? "fade";
    if (appear === "fade") show *= fin;
    else if (appear === "grow") size *= fin;
    if (vanish === "fade") show *= fout;
    else if (vanish === "shrink") size *= fout;
    else if (vanish === "pop" && age >= l.life) show = 0;
    let sink = 0;
    if (appear === "rise") sink += (1 - fin) * l.height;
    if (vanish === "sink") sink += (1 - fout) * l.height;
    if (sink > 0) m.premultiply(new THREE.Matrix4().makeTranslation(0, -sink, 0));
    const k = (p.scale ?? 1) * Math.max(0.01, size);
    m.multiply(new THREE.Matrix4().makeScale(k, k, k));
    l.group.matrix.copy(m);
    l.group.matrixWorldNeedsUpdate = true;
    for (const { m: mat, opacity } of l.materials) {
      mat.opacity = opacity * show;
      mat.visible = show > 0.002;
    }
    void camera;
  };

  const impactAt = (rp: ResolvedProp, at: THREE.Matrix4) => {
    const rt = createVfx(rp.impact!, rng, { external: true });
    const m = new THREE.Matrix4().makeTranslation(new THREE.Vector3().setFromMatrixPosition(at));
    rt.setRoot(m);
    rt.burst();
    group.add(rt.object);
    const ev = { event: { at: time, vfx: rp.impact! } as AbilityEvent, index: -1, vfx: rp.impact!, templateName: rp.impactName ?? "" } satisfies ResolvedEvent;
    live.push({ ev, rt, born: time, stopped: false, fixed: m, impact: true });
  };

  const clearExtras = () => {
    for (const l of summons) {
      group.remove(l.meshes.group);
      l.meshes.dispose();
      if (l.aura) {
        group.remove(l.aura.object);
        l.aura.dispose();
      }
    }
    for (const l of props) {
      group.remove(l.group);
      for (const { m } of l.materials) m.dispose();
      for (const g of l.geometries) g.dispose();
    }
    summons = [];
    props = [];
    pendingSummons = [...resolved.summons];
    pendingProps = [...resolved.props];
  };

  const reset = () => {
    clearExtras();
    for (const l of live) {
      group.remove(l.rt.object);
      l.rt.dispose();
    }
    live = [];
    pending = [...resolved.events];
    rng = mulberry(seed);
    time = 0;
    pose(0);
  };

  const step = (dt: number, camera: THREE.Camera) => {
    time += dt;
    pose(time);
    while (pending.length && pending[0].event.at <= time) spawn(pending.shift()!, camera);
    while (pendingSummons.length && pendingSummons[0].summon.at <= time) spawnSummon(pendingSummons.shift()!);
    while (pendingProps.length && pendingProps[0].prop.at <= time) spawnProp(pendingProps.shift()!);
    for (const l of [...summons]) {
      const end = l.rs.until + (l.rs.summon.fade ?? SUMMON_DEFAULTS.fade);
      if (time >= end) {
        group.remove(l.meshes.group);
        l.meshes.dispose();
        if (l.aura) {
          // The aura stops and its last particles fade where it was.
          l.aura.stop();
          live.push({ ev: { event: { at: time, vfx: l.rs.vfx! } as AbilityEvent, index: -1, vfx: l.rs.vfx!, templateName: "" }, rt: l.aura, born: time, stopped: true, fixed: l.auraAt ?? casterRoot() });
        }
        summons.splice(summons.indexOf(l), 1);
        continue;
      }
      updateSummon(l, dt, camera);
    }
    for (const l of [...props]) {
      if (time - l.rp.prop.at >= l.life + (l.rp.prop.fade ?? 0.2)) {
        group.remove(l.group);
        for (const { m } of l.materials) m.dispose();
        for (const g of l.geometries) g.dispose();
        props.splice(props.indexOf(l), 1);
        continue;
      }
      updateProp(l, camera);
    }
    for (const item of [...live]) {
      const m = placeOf(item, time);
      item.rt.setRoot(m);
      item.rt.update(dt, camera);
      if (!item.stopped) {
        const age = time - item.born;
        const duration = item.impact ? 1 : item.ev.event.duration ?? 1;
        const p = new THREE.Vector3().setFromMatrixPosition(m);
        const hit = item.velocity && item.ev.event.travel?.stopOnHit !== false && p.y <= 0.05 && age > 0.05;
        if (age >= duration || hit) {
          item.stopped = true;
          item.rt.stop();
          if (item.velocity) {
            if (hit) m.setPosition(p.setY(0));
            item.fixed = m;
            impact(item, m);
          }
        }
      }
      if (item.stopped && !item.rt.alive()) {
        group.remove(item.rt.object);
        item.rt.dispose();
        live.splice(live.indexOf(item), 1);
      }
    }
  };

  pose(0);
  return {
    group,
    length,
    time: () => time,
    update(dt, camera) {
      let left = Math.min(0.1, dt);
      while (left > 1e-6) {
        const d = Math.min(STEP, left);
        left -= d;
        if (time + d >= length) {
          if (!loop) {
            step(Math.max(0, length - time), camera);
            return;
          }
          reset();
          continue;
        }
        step(d, camera);
      }
    },
    seek(t, camera) {
      reset();
      const target = Math.max(0, Math.min(length, t));
      while (time + STEP <= target) step(STEP, camera);
      if (target - time > 1e-6) step(target - time, camera);
    },
    bounds() {
      group.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(meshes.group);
      for (const l of live) box.union(l.rt.bounds());
      for (const l of summons) box.union(new THREE.Box3().setFromObject(l.meshes.group));
      for (const l of props) box.union(new THREE.Box3().setFromObject(l.group));
      return box;
    },
    dispose() {
      reset();
      meshes.dispose();
    },
  };
}

export const VIEWS = {
  front: new THREE.Vector3(0.55, 0.3, -1),
  side: new THREE.Vector3(1, 0.3, -0.25),
  behind: new THREE.Vector3(0.4, 0.5, 1),
} as const;
export type AbilityView = keyof typeof VIEWS;

/** The view that shows an ability best: behind the character for projectiles and things built in front of it, else the front. */
export function defaultView(resolved: ResolvedAbility): AbilityView {
  const ahead = resolved.props.some((p) => p.prop.travel || ((p.prop.attach === "ground" || p.prop.attach === "world") && (p.prop.offset?.[2] ?? 0) < -2));
  return resolved.events.some((e) => e.event.travel) || ahead ? "behind" : "front";
}

/**
 * Frame the ability: centered between the character and where its effects go, close enough that
 * the character stays readable (far-flying projectiles may leave the frame; orbit or zoom out).
 */
export function abilityExtent(resolved: ResolvedAbility, rigType: RigType): { center: THREE.Vector3; radius: number } {
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(14, 6, -8);
  const scene = createAbilityScene(resolved, rigType, { loop: false, seed: 3 });
  const body = new THREE.Box3(new THREE.Vector3(-2, 0, -1), new THREE.Vector3(2, 5.5, 1));
  const effects = body.clone();
  try {
    for (let t = 0; t < scene.length; t += 0.2) {
      scene.update(0.2, cam);
      effects.union(scene.bounds());
    }
  } finally {
    scene.dispose();
  }
  effects.min.y = Math.max(-0.5, effects.min.y);
  const center = body.getCenter(new THREE.Vector3()).lerp(effects.getCenter(new THREE.Vector3()), 0.35);
  const size = effects.getSize(new THREE.Vector3());
  return { center, radius: Math.min(16, Math.max(5, size.length() / 2 * 0.6)) };
}
