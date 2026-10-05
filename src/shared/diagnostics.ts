// Positioning checks for models, reported to Claude after create_model / edit_model so it can
// fix what would look wrong in Studio: parts that float, a stray part below the ground (which
// lifts the whole model on import), coplanar faces that flicker (z-fighting) and duplicates.

import { partBounds, toNativeModel, type ModelSpec, type NativePart } from "./model.ts";
import type { Vec3 } from "./math.ts";

export interface ModelIssues {
  /** Parts not connected (touching or overlapping, through other parts) to the lowest parts. */
  floating: string[];
  /** How far the lowest point is below y = 0, and the parts down there. */
  belowGround?: { depth: number; parts: string[] };
  /** Pairs of parts with overlapping coplanar faces of different colour or material. */
  zFighting: { a: string; b: string; face: string }[];
  /** Pairs of parts with the same size, position and rotation. */
  duplicates: [string, string][];
}

/** Gap still counted as touching (joints are often overlapped or spaced by a hair). */
const TOUCH = 0.06;
/** Faces closer than this are coplanar for the renderer. */
const COPLANAR = 0.004;
const FACES = [["Left", "Right"], ["Bottom", "Top"], ["Front", "Back"]] as const;

type Box = { min: Vec3; max: Vec3 };

function axisAligned(p: NativePart): boolean {
  return p.rot.every((v) => Math.abs(v) < 1e-6 || Math.abs(Math.abs(v) - 1) < 1e-6);
}

function overlap(a: Box, b: Box, k: number, slack: number): number {
  return Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) + slack;
}

export function checkModel(spec: ModelSpec): ModelIssues {
  const parts = toNativeModel(spec).parts;
  const boxes = parts.map(partBounds);
  const n = parts.length;
  const issues: ModelIssues = { floating: [], zFighting: [], duplicates: [] };
  if (!n) return issues;

  // Union-find over touching parts.
  const parent = parts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (i: number, j: number) => {
    const a = find(i), b = find(j);
    if (a !== b) parent[a] = b;
  };

  // Sweep along X so only nearby pairs are compared.
  const order = parts.map((_, i) => i).sort((i, j) => boxes[i].min[0] - boxes[j].min[0]);
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    const a = boxes[i];
    for (let oj = oi + 1; oj < n; oj++) {
      const j = order[oj];
      const b = boxes[j];
      if (b.min[0] > a.max[0] + TOUCH) break;
      if (overlap(a, b, 1, TOUCH) < 0 || overlap(a, b, 2, TOUCH) < 0) continue;
      join(i, j);

      const p = parts[i], q = parts[j];
      if (p.pos.every((v, k) => Math.abs(v - q.pos[k]) < 1e-3) && p.size.every((v, k) => Math.abs(v - q.size[k]) < 1e-3) && p.rot.every((v, k) => Math.abs(v - q.rot[k]) < 1e-4) && p.shape === q.shape && p.className === q.className) {
        issues.duplicates.push([p.name, q.name]);
        continue;
      }
      // Z-fighting: two opaque blocks whose faces lie in the same plane, facing the same way, overlapping in area.
      const block = (x: NativePart) => x.className === "Part" && x.shape === "Block" && x.transparency < 0.3 && axisAligned(x);
      if (!block(p) || !block(q)) continue;
      if (p.material === q.material && p.color.every((v, k) => v === q.color[k])) continue;
      for (let k = 0; k < 3 && issues.zFighting.length < 50; k++) {
        const u = (k + 1) % 3, v = (k + 2) % 3;
        if (overlap(a, b, u, 0) <= 0.05 || overlap(a, b, v, 0) <= 0.05) continue;
        // Report the top (usually visible) face before the bottom one.
        const side = Math.abs(a.max[k] - b.max[k]) < COPLANAR ? 1 : Math.abs(a.min[k] - b.min[k]) < COPLANAR ? 0 : null;
        if (side === null) continue;
        issues.zFighting.push({ a: p.name, b: q.name, face: FACES[k][side].toLowerCase() });
        break;
      }
    }
  }

  const minY = Math.min(...boxes.map((b) => b.min[1]));
  const grounded = new Set<number>();
  boxes.forEach((b, i) => b.min[1] <= minY + TOUCH && grounded.add(find(i)));
  // Glows and see-through effects often hover on purpose.
  issues.floating = parts.filter((p, i) => !grounded.has(find(i)) && p.material !== "Neon" && p.transparency < 0.5).map((p) => p.name);

  if (minY < -0.05) {
    issues.belowGround = {
      depth: Math.round(-minY * 100) / 100,
      parts: parts.filter((_, i) => boxes[i].min[1] < -0.05).sort((x, y) => partBounds(x).min[1] - partBounds(y).min[1]).map((p) => p.name),
    };
  }
  return issues;
}

const names = (list: string[], max = 5) => list.slice(0, max).join(", ") + (list.length > max ? ` +${list.length - max} more` : "");

/** Short lines for a tool result (empty when the model looks fine). */
export function describeIssues(issues: ModelIssues): string[] {
  const out: string[] = [];
  if (issues.belowGround) {
    out.push(`Below ground: the lowest point is y=-${issues.belowGround.depth} (${names(issues.belowGround.parts, 3)}). Studio sets the model's lowest point on the ground, so everything else will float ${issues.belowGround.depth} studs up. Keep part bottoms at y ≥ 0 unless that is intended.`);
  }
  if (issues.floating.length) {
    out.push(`Floating: ${issues.floating.length} part${issues.floating.length === 1 ? "" : "s"} touch nothing connected to the ground (${names(issues.floating)}). Lower them or add supports unless they should hover.`);
  }
  if (issues.zFighting.length) {
    const pairs = issues.zFighting.slice(0, 4).map((z) => `${z.a}/${z.b} (${z.face})`).join(", ");
    out.push(`Flicker: coplanar faces will z-fight: ${pairs}${issues.zFighting.length > 4 ? ` +${issues.zFighting.length - 4} more` : ""}. Move one part ~0.02 studs or change its size.`);
  }
  if (issues.duplicates.length) {
    out.push(`Duplicates: ${issues.duplicates.slice(0, 4).map(([a, b]) => `${a} = ${b}`).join(", ")}${issues.duplicates.length > 4 ? ` +${issues.duplicates.length - 4} more` : ""} (same size and position).`);
  }
  return out;
}
