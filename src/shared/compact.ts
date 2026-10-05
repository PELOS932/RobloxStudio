// Shorter, equivalent forms of specs for get_asset: field bundles that repeat (a colour and
// material, a card's background and corners…) become named styles, the same shorthand
// create_model / create_ui accept. Expanding the result gives back the original spec.

import type { ModelSpec, PartSpec } from "./model.ts";
import type { UiNode, UiSpec } from "./ui.ts";

type Rec = Record<string, unknown>;

/** Move bundles of `fields` that repeat into styles (only where it saves characters). */
function factor<T extends Rec>(items: T[], fields: readonly string[], label: (bundle: Rec) => string) {
  const bundleOf = (it: T) => {
    const b: Rec = {};
    for (const f of fields) if (it[f] !== undefined) b[f] = it[f];
    return b;
  };
  const counts = new Map<string, { bundle: Rec; uses: number }>();
  for (const it of items) {
    const b = bundleOf(it);
    if (!Object.keys(b).length) continue;
    const key = JSON.stringify(b);
    const c = counts.get(key);
    if (c) c.uses++;
    else counts.set(key, { bundle: b, uses: 1 });
  }
  const styles: Record<string, Rec> = {};
  const nameOf = new Map<string, string>();
  const used = new Set<string>();
  // Biggest savings first, so the shortest names go to the most used styles.
  const ranked = [...counts.entries()]
    .map(([key, c]) => ({ key, ...c, saving: (key.length - 2 - 14) * c.uses - key.length }))
    .filter((c) => c.uses >= 2 && c.saving > 0)
    .sort((a, b) => b.saving - a.saving);
  for (const c of ranked) {
    const base = label(c.bundle).replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "s";
    let name = base, n = 2;
    while (used.has(name)) name = `${base}${n++}`;
    used.add(name);
    styles[name] = c.bundle;
    nameOf.set(c.key, name);
  }
  const out = items.map((it) => {
    const style = nameOf.get(JSON.stringify(bundleOf(it)));
    if (!style) return it;
    const rest: Rec = {};
    for (const [k, v] of Object.entries(it)) if (!fields.includes(k)) rest[k] = v;
    return { ...rest, style } as T & { style: string };
  });
  return { styles, items: out };
}

const PART_FIELDS = ["shape", "axis", "color", "material", "transparency", "reflectance", "collide", "group"] as const;

export function compactModel(spec: ModelSpec): Rec {
  const label = (b: Rec) => {
    const material = typeof b.material === "string" ? b.material.toLowerCase() : "plastic";
    const shape = b.shape && b.shape !== "block" ? `${String(b.shape)[0].toUpperCase()}${String(b.shape).slice(1)}` : "";
    const group = typeof b.group === "string" ? b.group.split("/").pop()! : "";
    return `${group ? group[0].toLowerCase() + group.slice(1) : material}${shape}${group ? material[0].toUpperCase() + material.slice(1, 4) : ""}`;
  };
  // Identical pieces (same size too) first, then shared looks.
  const sized = factor(spec.parts as unknown as Rec[], [...PART_FIELDS, "size"], label);
  const styled = sized.items.filter((p) => p.style);
  const rest = factor(sized.items.filter((p) => !p.style), PART_FIELDS, label);
  const styles = { ...sized.styles };
  for (const [k, v] of Object.entries(rest.styles)) {
    let name = k, n = 2;
    while (styles[name]) name = `${k}${n++}`;
    styles[name] = v;
    for (const p of rest.items) if (p.style === k) (p as Rec).style = name;
  }
  // Keep the original part order.
  const byName = new Map([...styled, ...rest.items].map((p) => [p.name, p]));
  const parts = spec.parts.map((p, i) => byName.get(p.name) ?? sized.items[i]);
  return { name: spec.name, ...(spec.description ? { description: spec.description } : {}), ...(Object.keys(styles).length ? { styles } : {}), parts };
}

// Everything that styles a node, but not what makes it unique (name, parent, text, position, size).
const NODE_FIELDS = [
  "bg", "bgT", "corner", "stroke", "gradient", "padding", "textColor", "textSize", "font", "xAlign", "yAlign",
  "textScaled", "textWrapped", "rich", "textT", "textStroke", "imageColor", "imageT", "scaleType", "clip", "autoSize", "layout",
] as const;

export function compactUi(spec: UiSpec): Rec {
  const { styles, items } = factor(spec.nodes as unknown as Rec[], NODE_FIELDS, (b) => (b.font ? "text" : b.corner !== undefined ? "card" : b.bg ? "panel" : "style"));
  const { nodes: _nodes, ...rest } = spec;
  return { ...rest, ...(Object.keys(styles).length ? { styles } : {}), nodes: items };
}

/** Parts in a group path (and its subgroups). */
export function partsInGroup(parts: PartSpec[], group: string): PartSpec[] {
  const g = group.replace(/^\/+|\/+$/g, "");
  return parts.filter((p) => p.group === g || p.group?.startsWith(g + "/"));
}

/** Nodes with these names plus all their descendants. */
export function nodesUnder(nodes: UiNode[], names: string[]): UiNode[] {
  const keep = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) if (n.parent && keep.has(n.parent) && !keep.has(n.name)) (keep.add(n.name), (grew = true));
  }
  return nodes.filter((n) => keep.has(n.name));
}

/** One line per group: part count and bounds, for very large models. */
export function modelOutline(spec: ModelSpec): string {
  const groups = new Map<string, { n: number; min: number[]; max: number[] }>();
  for (const p of spec.parts) {
    const g = p.group ?? "(top level)";
    const e = groups.get(g) ?? { n: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    e.n++;
    for (let k = 0; k < 3; k++) {
      e.min[k] = Math.min(e.min[k], p.pos[k] - p.size[k] / 2);
      e.max[k] = Math.max(e.max[k], p.pos[k] + p.size[k] / 2);
    }
    groups.set(g, e);
  }
  const r = (v: number) => Math.round(v * 10) / 10;
  return [...groups.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([g, e]) => `${g}: ${e.n} parts, x ${r(e.min[0])}..${r(e.max[0])}, y ${r(e.min[1])}..${r(e.max[1])}, z ${r(e.min[2])}..${r(e.max[2])}`)
    .join("\n");
}
