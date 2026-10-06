// Plays an ability in three.js: the rig runs the animation and every event's effect is spawned at
// its time, attached to a body part, the ground or the cast spot, or flown as a projectile that
// ends in an impact effect. Deterministic (seeded), so scrubbing re-simulates from the start.
import * as THREE from "three";
import { buildTracks, poseRig, RIGS, sampleTracks, type RigType } from "../../shared/animation.ts";
import { ATTACH, type ResolvedAbility, type ResolvedEvent } from "../../shared/ability.ts";
import { animationLength } from "../../shared/animation.ts";
import type { Mat3, Vec3 } from "../../shared/math.ts";
import { applyPose, buildRig, type RigMeshes } from "./rig3d.ts";
import { createVfx, mulberry, type VfxRuntime } from "./vfx3d.ts";

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
  let world = poseRig(rig, {});

  const pose = (t: number) => {
    const at = !tracks ? 0 : animLoops ? t % animLen : Math.min(t, animLen);
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

  const reset = () => {
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

/** The view that shows an ability best: behind the character for projectiles, else the front. */
export function defaultView(resolved: ResolvedAbility): AbilityView {
  return resolved.events.some((e) => e.event.travel) ? "behind" : "front";
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
