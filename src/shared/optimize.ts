import { applyMat, matEquals, round, transpose, type Vec3 } from "./math.ts";
import type { NativePart } from "./model.ts";

const EPS = 1e-3;

export interface OptimizeStats {
  before: number;
  after: number;
  merged: number;
  removedInvisible: number;
}

function signature(p: NativePart): string | null {
  if (p.className !== "Part" || p.shape !== "Block" || p.light) return null;
  return [
    p.color.join(","), p.material, p.transparency, p.reflectance, p.canCollide, p.castShadow,
    p.canTouch, p.anchored, p.group, p.rot.map((v) => round(v, 4)).join(","),
  ].join("|");
}

function tryMerge(a: NativePart, b: NativePart): NativePart | null {
  if (!matEquals(a.rot, b.rot, 1e-5)) return null;
  const delta: Vec3 = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]];
  const d = applyMat(transpose(a.rot), delta); // b's center in a's local space
  for (let k = 0; k < 3; k++) {
    const i = (k + 1) % 3, j = (k + 2) % 3;
    if (Math.abs(d[i]) > EPS || Math.abs(d[j]) > EPS) continue;
    if (Math.abs(a.size[i] - b.size[i]) > EPS || Math.abs(a.size[j] - b.size[j]) > EPS) continue;
    const gap = Math.abs(d[k]) - (a.size[k] + b.size[k]) / 2;
    if (gap > EPS) continue;
    const lo = Math.min(-a.size[k] / 2, d[k] - b.size[k] / 2);
    const hi = Math.max(a.size[k] / 2, d[k] + b.size[k] / 2);
    const size: Vec3 = [...a.size];
    size[k] = round(hi - lo, 4);
    const off: Vec3 = [0, 0, 0];
    off[k] = (lo + hi) / 2;
    const w = applyMat(a.rot, off);
    return {
      ...a,
      size,
      pos: [round(a.pos[0] + w[0], 4), round(a.pos[1] + w[1], 4), round(a.pos[2] + w[2], 4)],
    };
  }
  return null;
}

/**
 * Reduce part count without changing how the model looks: merges blocks that share
 * a full face (or overlap along one axis) and have identical appearance, and drops
 * fully invisible, non-collidable parts.
 */
export function optimizeParts(parts: NativePart[]): { parts: NativePart[]; stats: OptimizeStats } {
  const before = parts.length;
  let removedInvisible = 0;
  const visible = parts.filter((p) => {
    const drop = p.transparency >= 1 && !p.canCollide && !p.light;
    if (drop) removedInvisible++;
    return !drop;
  });

  const buckets = new Map<string, NativePart[]>();
  const passthrough: { index: number; part: NativePart }[] = [];
  visible.forEach((p, index) => {
    const sig = signature(p);
    if (!sig) return passthrough.push({ index, part: p });
    const list = buckets.get(sig) ?? [];
    list.push(p);
    buckets.set(sig, list);
  });

  let merged = 0;
  const out: NativePart[] = [];
  for (const list of buckets.values()) {
    // Grow each block as far as possible, then repeat until a pass finds nothing new.
    for (let pass = 0, changed = true; changed && pass < 12; pass++) {
      changed = false;
      for (let i = 0; i < list.length; i++) {
        let j = i + 1;
        while (j < list.length) {
          const m = tryMerge(list[i], list[j]);
          if (m) {
            list[i] = m;
            list.splice(j, 1);
            merged++;
            changed = true;
            j = i + 1;
          } else j++;
        }
      }
    }
    out.push(...list);
  }
  for (const { part } of passthrough) out.push(part);
  return { parts: out, stats: { before, after: out.length, merged, removedInvisible } };
}
