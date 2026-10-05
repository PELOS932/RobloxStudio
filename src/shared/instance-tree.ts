// A small, serializable description of Roblox instances: built once from a spec, then written
// as Luau (for live import through the Studio MCP) or as .rbxmx XML (to-rbxmx.ts).

import { luaLongString, luaNum, luaString } from "./luau.ts";
import type { Mat3, RGB, Vec3 } from "./math.ts";

export interface NumKey {
  t: number;
  v: number;
  e: number;
}
export interface ColorKey {
  t: number;
  c: RGB;
}

export type PropValue =
  | number
  | boolean
  | string
  | { int: number }
  | { enum: string; item: string; token: number }
  | { v3: Vec3 }
  | { v2: [number, number] }
  | { rgb: RGB }
  | { nseq: NumKey[] }
  | { cseq: ColorKey[] }
  | { range: [number, number] }
  | { ref: string }
  | { content: string }
  | { cf: { pos: Vec3; rot?: Mat3 } };

export interface InstNode {
  /** Lets other nodes point at this one ({ ref: id }). */
  id?: string;
  className: string;
  name: string;
  props?: Record<string, PropValue>;
  attrs?: Record<string, string | number>;
  /** Script source. */
  source?: string;
  children?: InstNode[];
}

export function luauValue(v: PropValue, refs: Map<string, string>): string {
  if (typeof v === "number") return luaNum(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") return luaString(v);
  if ("int" in v) return String(Math.round(v.int));
  if ("enum" in v) return `Enum.${v.enum}.${v.item}`;
  if ("v3" in v) return `Vector3.new(${v.v3.map((n) => luaNum(n)).join(", ")})`;
  if ("v2" in v) return `Vector2.new(${v.v2.map((n) => luaNum(n)).join(", ")})`;
  if ("rgb" in v) return `Color3.fromRGB(${v.rgb.map((n) => Math.round(n)).join(", ")})`;
  if ("range" in v) return `NumberRange.new(${luaNum(v.range[0])}, ${luaNum(v.range[1])})`;
  if ("content" in v) return luaString(v.content);
  if ("ref" in v) return refs.get(v.ref) ?? "nil";
  if ("nseq" in v) {
    return `NumberSequence.new({ ${v.nseq.map((k) => `NumberSequenceKeypoint.new(${luaNum(k.t, 4)}, ${luaNum(k.v, 4)}, ${luaNum(k.e, 4)})`).join(", ")} })`;
  }
  if ("cseq" in v) {
    return `ColorSequence.new({ ${v.cseq.map((k) => `ColorSequenceKeypoint.new(${luaNum(k.t, 4)}, Color3.fromRGB(${k.c.map((n) => Math.round(n)).join(", ")}))`).join(", ")} })`;
  }
  const { pos, rot } = v.cf;
  return rot ? `CFrame.new(${[...pos, ...rot].map((n) => luaNum(n)).join(", ")})` : `CFrame.new(${pos.map((n) => luaNum(n)).join(", ")})`;
}

/**
 * Luau that builds the nodes off-tree; `rootVars` name the root instances (left unparented).
 * References are assigned once everything exists, and children are parented before their
 * parents, so nothing appears half-built.
 */
export function treeToLuau(roots: InstNode[], table = "N"): { code: string; rootVars: string[] } {
  // One table instead of locals: Luau allows only 200 locals per function.
  const vars = new Map<InstNode, string>();
  const refs = new Map<string, string>();
  const assign = (node: InstNode) => {
    const v = `${table}[${vars.size + 1}]`;
    vars.set(node, v);
    if (node.id) refs.set(node.id, v);
    for (const c of node.children ?? []) assign(c);
  };
  for (const r of roots) assign(r);
  const lines: string[] = [];
  const later: string[] = [];
  const parents: string[] = [];
  const visit = (node: InstNode, parentVar: string | null) => {
    const v = vars.get(node)!;
    lines.push(`${v} = Instance.new(${luaString(node.className)})`);
    lines.push(`${v}.Name = ${luaString(node.name)}`);
    for (const [k, val] of Object.entries(node.props ?? {})) {
      (typeof val === "object" && "ref" in val ? later : lines).push(`${v}.${k} = ${luauValue(val, refs)}`);
    }
    for (const [k, val] of Object.entries(node.attrs ?? {})) lines.push(`${v}:SetAttribute(${luaString(k)}, ${typeof val === "number" ? luaNum(val) : luaString(val)})`);
    if (node.source !== undefined) lines.push(`${v}.Source = ${luaLongString(node.source)}`);
    for (const c of node.children ?? []) visit(c, v);
    if (parentVar) parents.push(`${v}.Parent = ${parentVar}`);
  };
  for (const r of roots) visit(r, null);
  return { code: [`local ${table} = {}`, ...lines, ...later, ...parents].join("\n"), rootVars: roots.map((r) => vars.get(r)!) };
}
