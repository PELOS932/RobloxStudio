// Spec → Roblox XML model (.rbxmx). Drag the file into Studio (or right-click →
// Insert from File) to import without the MCP connection. Property names and
// types follow the rbx-dom reflection database; legacy aliases (Font, Image,
// CornerRadius, IgnoreGuiInset) are used where they keep older Studio builds happy.

import { toNativeModel, type ModelSpec, type NativePart } from "./model.ts";
import { optimizeParts } from "./optimize.ts";
import { hexToRgb } from "./math.ts";
import {
  AUTOMATIC_SIZE_ENUM, FILL_DIRECTION_ENUM, FONTS, HORIZONTAL_ALIGN_ENUM, MATERIAL_ENUM,
  NORMAL_ID_ENUM, PART_TYPE_ENUM, SCALE_TYPE_ENUM, SORT_ORDER_LAYOUT_ORDER, TEXT_X_ALIGN_ENUM,
  TEXT_Y_ALIGN_ENUM, VERTICAL_ALIGN_ENUM, ZINDEX_BEHAVIOR_SIBLING, APPLY_STROKE_MODE_BORDER, fontFamilyUrl,
} from "./roblox-data.ts";
import {
  AUTO_SCALE_ROOT, autoScaleSource, buildUiTree, cornerOf, gradientStops, paddingOf, resolveUiNode,
  type UiSpec, type UiTreeNode,
} from "./ui.ts";
import type { ScriptSpec } from "./script.ts";
import { jointTransform, poseOf, RIGS, type AnimationSpec, type Joint, type PoseValue } from "./animation.ts";
import { eulerXYZDeg } from "./math.ts";
import type { ImportOptions } from "./to-luau.ts";
import { vfxTree, type VfxSpec } from "./vfx.ts";
import { standaloneTool } from "./ability-studio.ts";
import type { ResolvedAbility } from "./ability.ts";
import type { InstNode, PropValue } from "./instance-tree.ts";

type Prop = string;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

const num = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "0");
const str = (name: string, v: string): Prop => `<string name="${name}">${esc(v)}</string>`;
const bool = (name: string, v: boolean): Prop => `<bool name="${name}">${v}</bool>`;
const float = (name: string, v: number): Prop => `<float name="${name}">${num(v)}</float>`;
const int = (name: string, v: number): Prop => `<int name="${name}">${Math.round(v)}</int>`;
const token = (name: string, v: number): Prop => `<token name="${name}">${v}</token>`;
const vec3 = (name: string, [x, y, z]: number[]): Prop => `<Vector3 name="${name}"><X>${num(x)}</X><Y>${num(y)}</Y><Z>${num(z)}</Z></Vector3>`;
const vec2 = (name: string, [x, y]: number[]): Prop => `<Vector2 name="${name}"><X>${num(x)}</X><Y>${num(y)}</Y></Vector2>`;
const udim = (name: string, s: number, o: number): Prop => `<UDim name="${name}"><S>${num(s)}</S><O>${Math.round(o)}</O></UDim>`;
const udim2 = (name: string, [xs, xo, ys, yo]: number[]): Prop =>
  `<UDim2 name="${name}"><XS>${num(xs)}</XS><XO>${Math.round(xo)}</XO><YS>${num(ys)}</YS><YO>${Math.round(yo)}</YO></UDim2>`;
// Full precision so the float32 Studio stores equals Color3.fromRGB(r, g, b).
const color3rgb = (name: string, [r, g, b]: number[]): Prop =>
  `<Color3 name="${name}"><R>${r / 255}</R><G>${g / 255}</G><B>${b / 255}</B></Color3>`;
const color3 = (name: string, hex: string): Prop => color3rgb(name, hexToRgb(hex));

function cframeBody(pos: number[], r: number[]): string {
  return `<X>${num(pos[0])}</X><Y>${num(pos[1])}</Y><Z>${num(pos[2])}</Z>` +
    ["R00", "R01", "R02", "R10", "R11", "R12", "R20", "R21", "R22"].map((k, i) => `<${k}>${num(r[i])}</${k}>`).join("");
}

function cframe(name: string, p: NativePart): Prop {
  return `<CoordinateFrame name="${name}">${cframeBody(p.pos, p.rot)}</CoordinateFrame>`;
}

/** Roblox binary attribute blob holding string/number attributes. */
function attributes(attrs: Record<string, string | number>): Prop {
  const chunks: number[] = [];
  const u32 = (n: number) => chunks.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  const bytes = (s: string) => {
    const b = new TextEncoder().encode(s);
    u32(b.length);
    chunks.push(...b);
  };
  const entries = Object.entries(attrs);
  u32(entries.length);
  for (const [k, v] of entries) {
    bytes(k);
    if (typeof v === "string") {
      chunks.push(0x02);
      bytes(v);
    } else {
      chunks.push(0x06); // double
      const buf = new DataView(new ArrayBuffer(8));
      buf.setFloat64(0, v, true);
      for (let i = 0; i < 8; i++) chunks.push(buf.getUint8(i));
    }
  }
  return `<BinaryString name="AttributesSerialize">${base64(new Uint8Array(chunks))}</BinaryString>`;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

class Writer {
  private ref = 0;
  out: string[] = [];
  open(className: string, props: Prop[]) {
    this.out.push(`<Item class="${className}" referent="RBX${this.ref++}"><Properties>${props.join("")}</Properties>`);
  }
  close() {
    this.out.push(`</Item>`);
  }
  leaf(className: string, props: Prop[]) {
    this.open(className, props);
    this.close();
  }
  toString() {
    return `<roblox version="4">\n${this.out.join("\n")}\n</roblox>\n`;
  }
}

function forgeAttrs(opts: ImportOptions): Prop[] {
  return opts.assetId ? [attributes({ ForgeAssetId: opts.assetId, ForgeVersion: opts.version ?? 1 })] : [];
}

// ---------------------------------------------------------------------------

export function modelToRbxmx(spec: ModelSpec, opts: ImportOptions = {}): string {
  const native = toNativeModel(spec, { performance: opts.performance ?? true, anchored: opts.anchored ?? true });
  const parts = (opts.optimize ?? true) ? optimizeParts(native.parts).parts : native.parts;
  const { min, max } = native.bounds;
  const pivot = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
  const w = new Writer();
  w.open("Model", [
    str("Name", spec.name),
    // Bottom-center pivot, same as the Luau importer, so the model sits on the ground when moved.
    `<OptionalCoordinateFrame name="WorldPivotData"><CFrame>${cframeBody(pivot, [1, 0, 0, 0, 1, 0, 0, 0, 1])}</CFrame></OptionalCoordinateFrame>`,
    ...forgeAttrs(opts),
  ]);

  // Build the group tree first so every group becomes one nested Model.
  type Group = { name: string; children: Map<string, Group>; parts: NativePart[] };
  const root: Group = { name: "", children: new Map(), parts: [] };
  for (const p of parts) {
    let g = root;
    for (const seg of p.group ? p.group.split("/") : []) {
      let next = g.children.get(seg);
      if (!next) g.children.set(seg, (next = { name: seg, children: new Map(), parts: [] }));
      g = next;
    }
    g.parts.push(p);
  }
  const writeGroup = (g: Group) => {
    for (const p of g.parts) writePart(w, p);
    for (const c of g.children.values()) {
      w.open("Model", [str("Name", c.name)]);
      writeGroup(c);
      w.close();
    }
  };
  writeGroup(root);
  w.close();
  return w.toString();
}

function writePart(w: Writer, p: NativePart) {
  const props: Prop[] = [
    str("Name", p.name),
    bool("Anchored", p.anchored),
    cframe("CFrame", p),
    bool("CanCollide", p.canCollide),
    bool("CanTouch", p.canTouch),
    bool("CastShadow", p.castShadow),
    `<Color3uint8 name="Color3uint8">${(p.color[0] << 16) | (p.color[1] << 8) | p.color[2]}</Color3uint8>`,
    token("Material", MATERIAL_ENUM[p.material]),
    float("Reflectance", p.reflectance),
    vec3("size", p.size),
    float("Transparency", p.transparency),
    token("TopSurface", 0),
    token("BottomSurface", 0),
  ];
  if (p.className === "Part") props.push(token("shape", PART_TYPE_ENUM[p.shape ?? "Block"]));
  if (!p.light) return w.leaf(p.className, props);
  w.open(p.className, props);
  const l = p.light;
  const lp: Prop[] = [
    str("Name", l.className),
    float("Brightness", l.brightness),
    color3rgb("Color", l.color),
    float("Range", l.range),
    bool("Shadows", l.shadows),
  ];
  if (l.className !== "PointLight") lp.push(float("Angle", l.angle), token("Face", NORMAL_ID_ENUM[l.face]));
  w.leaf(l.className, lp);
  w.close();
}

// ---------------------------------------------------------------------------

export function uiToRbxmx(spec: UiSpec, opts: ImportOptions = {}): string {
  const w = new Writer();
  w.open("ScreenGui", [
    str("Name", spec.name),
    bool("ResetOnSpawn", spec.resetOnSpawn ?? false),
    bool("IgnoreGuiInset", spec.ignoreInset ?? false),
    token("ZIndexBehavior", ZINDEX_BEHAVIOR_SIBLING),
    int("DisplayOrder", spec.displayOrder ?? 0),
    ...forgeAttrs(opts),
  ]);
  if (spec.autoScale) {
    w.open("Frame", [
      str("Name", AUTO_SCALE_ROOT),
      vec2("AnchorPoint", [0.5, 0.5]),
      udim2("Position", [0.5, 0, 0.5, 0]),
      udim2("Size", [1, 0, 1, 0]),
      float("BackgroundTransparency", 1),
      int("BorderSizePixel", 0),
    ]);
    w.leaf("UIScale", [str("Name", "AutoScale"), float("Scale", 1)]);
  }
  for (const t of buildUiTree(spec)) writeUiNode(w, t);
  if (spec.autoScale) {
    w.close();
    w.leaf("LocalScript", [str("Name", "AutoScaleController"), protectedString("Source", autoScaleSource(spec.autoScale))]);
  }
  w.close();
  return w.toString();
}

function protectedString(name: string, source: string): Prop {
  return `<ProtectedString name="${name}"><![CDATA[${source.replace(/]]>/g, "]]]]><![CDATA[>")}]]></ProtectedString>`;
}

const X_ALIGN = { left: TEXT_X_ALIGN_ENUM.Left, center: TEXT_X_ALIGN_ENUM.Center, right: TEXT_X_ALIGN_ENUM.Right };
const Y_ALIGN = { top: TEXT_Y_ALIGN_ENUM.Top, center: TEXT_Y_ALIGN_ENUM.Center, bottom: TEXT_Y_ALIGN_ENUM.Bottom };
const H_ALIGN = { left: HORIZONTAL_ALIGN_ENUM.Left, center: HORIZONTAL_ALIGN_ENUM.Center, right: HORIZONTAL_ALIGN_ENUM.Right };
const V_ALIGN = { top: VERTICAL_ALIGN_ENUM.Top, center: VERTICAL_ALIGN_ENUM.Center, bottom: VERTICAL_ALIGN_ENUM.Bottom };
const AUTO = { x: AUTOMATIC_SIZE_ENUM.X, y: AUTOMATIC_SIZE_ENUM.Y, xy: AUTOMATIC_SIZE_ENUM.XY };

function writeUiNode(w: Writer, t: UiTreeNode) {
  const n = t.node;
  const r = resolveUiNode(n);
  // Same rule as the Luau converter: only values that differ from the class defaults.
  const props: Prop[] = [str("Name", r.name), udim2("Position", r.pos), udim2("Size", r.size)];
  if (r.anchor[0] || r.anchor[1]) props.push(vec2("AnchorPoint", r.anchor));
  props.push(color3("BackgroundColor3", r.bg));
  if (r.bgT) props.push(float("BackgroundTransparency", r.bgT));
  props.push(int("BorderSizePixel", 0));
  if (r.z !== 1) props.push(int("ZIndex", r.z));
  if (r.order) props.push(int("LayoutOrder", r.order));
  if (!r.visible) props.push(bool("Visible", false));
  if (r.clip !== (n.type === "ScrollingFrame")) props.push(bool("ClipsDescendants", r.clip));
  if (r.rotation) props.push(float("Rotation", r.rotation));
  if (r.autoSize) props.push(token("AutomaticSize", AUTO[r.autoSize]));
  if (r.isText) {
    props.push(
      str("Text", r.text),
      color3("TextColor3", r.textColor),
      float("TextSize", r.textSize),
      `<Font name="FontFace"><Family><url>${fontFamilyUrl(r.font)}</url></Family><Weight>${FONTS[r.font].weight}</Weight><Style>${FONTS[r.font].style}</Style></Font>`,
    );
    if (r.textScaled) props.push(bool("TextScaled", true));
    if (r.textWrapped) props.push(bool("TextWrapped", true));
    if (r.xAlign !== "center") props.push(token("TextXAlignment", X_ALIGN[r.xAlign]));
    if (r.yAlign !== "center") props.push(token("TextYAlignment", Y_ALIGN[r.yAlign]));
    if (r.textT) props.push(float("TextTransparency", r.textT));
    if (r.rich) props.push(bool("RichText", true));
    if (n.truncate) props.push(token("TextTruncate", 1));
    if (n.textStroke) {
      props.push(color3("TextStrokeColor3", n.textStroke.color ?? "#000000"), float("TextStrokeTransparency", n.textStroke.transparency ?? 0));
    }
    if (n.type === "TextBox") {
      props.push(bool("ClearTextOnFocus", false));
      if (n.placeholder !== undefined) props.push(str("PlaceholderText", n.placeholder));
      if (n.placeholderColor) props.push(color3("PlaceholderColor3", n.placeholderColor));
    }
  }
  if (r.isImage) {
    props.push(`<Content name="Image"><url>${esc(n.image ?? "")}</url></Content>`);
    if (n.imageColor && n.imageColor.toLowerCase() !== "#ffffff") props.push(color3("ImageColor3", n.imageColor));
    if (n.imageT) props.push(float("ImageTransparency", n.imageT));
    if (n.scaleType && n.scaleType !== "Stretch") props.push(token("ScaleType", SCALE_TYPE_ENUM[n.scaleType]));
    if (n.slice) {
      const [x0, y0, x1, y1] = n.slice;
      props.push(`<Rect2D name="SliceCenter"><min><X>${num(x0)}</X><Y>${num(y0)}</Y></min><max><X>${num(x1)}</X><Y>${num(y1)}</Y></max></Rect2D>`);
    }
  }
  if (n.type === "ScrollingFrame") {
    props.push(
      udim2("CanvasSize", n.canvas ?? [0, 0, 0, 0]),
      int("ScrollBarThickness", n.scrollBar ?? 6),
      color3("ScrollBarImageColor3", n.scrollColor ?? "#ffffff"),
    );
    if (n.autoCanvas) props.push(token("AutomaticCanvasSize", AUTO[n.autoCanvas]));
  }
  w.open(n.type, props);

  const corner = cornerOf(n);
  if (corner) w.leaf("UICorner", [str("Name", "UICorner"), udim("CornerRadius", corner[0], corner[1])]);
  if (n.stroke) {
    const sp: Prop[] = [str("Name", "UIStroke"), token("ApplyStrokeMode", APPLY_STROKE_MODE_BORDER)];
    const strokeColor = (n.stroke.color ?? "#000000").toLowerCase();
    if (strokeColor !== "#000000") sp.push(color3("Color", strokeColor));
    if ((n.stroke.thickness ?? 1) !== 1) sp.push(float("Thickness", n.stroke.thickness ?? 1));
    if (n.stroke.transparency) sp.push(float("Transparency", n.stroke.transparency));
    w.leaf("UIStroke", sp);
  }
  if (n.gradient) {
    const g = n.gradient;
    const stops = gradientStops(g);
    const cs = stops
      .map((st) => {
        const [cr, cg, cb] = hexToRgb(st.color).map((v) => v / 255);
        return `${num(st.t)} ${cr} ${cg} ${cb} 0 `;
      })
      .join("");
    const gp: Prop[] = [str("Name", "UIGradient"), `<ColorSequence name="Color">${cs}</ColorSequence>`];
    if (g.rotation) gp.push(float("Rotation", g.rotation));
    if (g.transparency) {
      const ns = stops.map((st) => `${num(st.t)} ${num(st.transparency)} 0 `).join("");
      gp.push(`<NumberSequence name="Transparency">${ns}</NumberSequence>`);
    }
    w.leaf("UIGradient", gp);
  }
  const pad = paddingOf(n);
  if (pad) {
    const names = ["PaddingTop", "PaddingRight", "PaddingBottom", "PaddingLeft"];
    const pp = pad.map((v, i) => (v ? udim(names[i], 0, v) : "")).filter(Boolean);
    if (pp.length) w.leaf("UIPadding", [str("Name", "UIPadding"), ...pp]);
  }
  if (n.layout) {
    const l = n.layout;
    const align: Prop[] = [];
    if ((l.hAlign ?? "left") !== "left") align.push(token("HorizontalAlignment", H_ALIGN[l.hAlign!]));
    if ((l.vAlign ?? "top") !== "top") align.push(token("VerticalAlignment", V_ALIGN[l.vAlign!]));
    if (l.type === "list") {
      const lp: Prop[] = [str("Name", "UIListLayout")];
      if (l.dir === "horizontal") lp.push(token("FillDirection", FILL_DIRECTION_ENUM.Horizontal));
      if (l.gap) lp.push(udim("Padding", 0, l.gap));
      lp.push(...align, token("SortOrder", SORT_ORDER_LAYOUT_ORDER));
      if (l.wraps) lp.push(bool("Wraps", true));
      w.leaf("UIListLayout", lp);
    } else {
      const gap = l.cellGap ?? [5, 5];
      const gp: Prop[] = [str("Name", "UIGridLayout"), udim2("CellSize", l.cell ?? [0, 100, 0, 100])];
      if (gap[0] !== 5 || gap[1] !== 5) gp.push(udim2("CellPadding", [0, gap[0], 0, gap[1]]));
      if (l.dir === "vertical") gp.push(token("FillDirection", FILL_DIRECTION_ENUM.Vertical));
      gp.push(...align, token("SortOrder", SORT_ORDER_LAYOUT_ORDER));
      if (l.maxCells) gp.push(int("FillDirectionMaxCells", l.maxCells));
      w.leaf("UIGridLayout", gp);
    }
  }
  if (n.aspect) w.leaf("UIAspectRatioConstraint", [str("Name", "UIAspectRatioConstraint"), float("AspectRatio", n.aspect)]);
  for (const c of t.children) writeUiNode(w, c);
  w.close();
}

// ---------------------------------------------------------------------------

export function scriptToRbxmx(spec: ScriptSpec, opts: ImportOptions = {}): string {
  const w = new Writer();
  w.leaf(spec.kind, [str("Name", spec.name), protectedString("Source", spec.source), ...forgeAttrs(opts)]);
  return w.toString();
}

// Enum values (rbx-dom): PoseEasingStyle, PoseEasingDirection (In/Out swapped: Roblox poses use them
// backwards from TweenService), AnimationPriority.
const POSE_STYLE_TOKEN = { linear: 0, constant: 1, elastic: 2, bounce: 4, cubic: 5 } as const;
const POSE_DIR_TOKEN = { in: 1, out: 0, inOut: 2 } as const;
const PRIORITY_TOKEN = { Idle: 0, Movement: 1, Action: 2, Core: 1000 } as const;

/** A KeyframeSequence: drop it into Studio, then right-click → Save to Roblox to get an animation id. */
export function animationToRbxmx(spec: AnimationSpec, opts: ImportOptions = {}): string {
  const rig = RIGS[spec.rig];
  const joints = new Map(rig.joints.map((j) => [j.joint, j]));
  const children = new Map<string, string[]>();
  for (const j of rig.joints) children.set(j.part0, [...(children.get(j.part0) ?? []), j.part1]);
  const w = new Writer();
  w.open("KeyframeSequence", [
    str("Name", spec.name), bool("Loop", spec.loop ?? true), token("Priority", PRIORITY_TOKEN[spec.priority ?? "Action"]), ...forgeAttrs(opts),
  ]);
  for (const k of spec.keyframes) {
    w.open("Keyframe", [str("Name", k.name ?? "Keyframe"), float("Time", k.t)]);
    const posed = new Map<string, { pos: number[]; rot: number[] }>();
    for (const [name, value] of Object.entries(k.poses) as [Joint, PoseValue][]) {
      const j = joints.get(name);
      if (!j || !value) continue;
      const p = poseOf(value);
      posed.set(j.part1, jointTransform(j, { rot: eulerXYZDeg(p.rot), pos: p.pos }));
    }
    // Only branches that lead to a posed part; the rest of the hierarchy is left out.
    const needed = (part: string): boolean => posed.has(part) || (children.get(part) ?? []).some(needed);
    const visit = (part: string) => {
      const t = posed.get(part);
      // Container poses (Weight 0) only hold the hierarchy; everything else on them is default.
      w.open("Pose", t ? [
        str("Name", part),
        `<CoordinateFrame name="CFrame">${cframeBody(t.pos, t.rot)}</CoordinateFrame>`,
        float("Weight", 1),
        token("EasingStyle", POSE_STYLE_TOKEN[k.ease ?? "linear"]),
        token("EasingDirection", POSE_DIR_TOKEN[k.dir ?? "inOut"]),
      ] : [str("Name", part), float("Weight", 0)]);
      for (const c of children.get(part) ?? []) if (needed(c)) visit(c);
      w.close();
    };
    if (needed(rig.parts[0].name)) visit(rig.parts[0].name);
    w.close();
  }
  w.close();
  return w.toString();
}

// ---------------------------------------------------------------------------
// Generic instance trees (visual effects)

/** Serialized names that differ from the Luau property names. */
const XML_NAMES: Record<string, Record<string, string>> = {
  Fire: { Heat: "heat_xml", Size: "size_xml" },
  Smoke: { Opacity: "opacity_xml", RiseVelocity: "riseVelocity_xml", Size: "size_xml" },
  Part: { Size: "size" },
  Model: { WorldPivot: "WorldPivotData" },
};

function xmlProp(className: string, key: string, v: PropValue, refs: Map<string, string>): Prop {
  const name = XML_NAMES[className]?.[key] ?? key;
  if (typeof v === "number") return float(name, v);
  if (typeof v === "boolean") return bool(name, v);
  if (typeof v === "string") return str(name, v);
  if ("int" in v) return int(name, v.int);
  if ("enum" in v) return token(name, v.token);
  if ("v3" in v) return vec3(name, v.v3);
  if ("v2" in v) return vec2(name, v.v2);
  if ("rgb" in v) return color3rgb(name, v.rgb);
  if ("range" in v) return `<NumberRange name="${name}">${num(v.range[0])} ${num(v.range[1])} </NumberRange>`;
  // The legacy name for older Studio builds, plus the newer Content property (TextureContent…).
  if ("content" in v) return `<Content name="${name}"><url>${esc(v.content)}</url></Content><Content name="${name}Content"><uri>${esc(v.content)}</uri></Content>`;
  if ("ref" in v) return `<Ref name="${name}">${refs.get(v.ref) ?? "null"}</Ref>`;
  if ("nseq" in v) return `<NumberSequence name="${name}">${v.nseq.map((k) => `${num(k.t)} ${num(k.v)} ${num(k.e)} `).join("")}</NumberSequence>`;
  if ("cseq" in v) return `<ColorSequence name="${name}">${v.cseq.map((k) => `${num(k.t)} ${k.c.map((c) => c / 255).join(" ")} 0 `).join("")}</ColorSequence>`;
  const body = `${cframeBody(v.cf.pos, v.cf.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1])}`;
  return name === "WorldPivotData" ? `<OptionalCoordinateFrame name="${name}"><CFrame>${body}</CFrame></OptionalCoordinateFrame>` : `<CoordinateFrame name="${name}">${body}</CoordinateFrame>`;
}

function writeTree(roots: InstNode[], extraRootProps: Prop[] = []): string {
  // Referents in document order, so refs can point forward.
  const refs = new Map<string, string>();
  let n = 0;
  const number = (node: InstNode) => {
    if (node.id) refs.set(node.id, `RBX${n}`);
    n++;
    for (const c of node.children ?? []) number(c);
  };
  for (const r of roots) number(r);
  const w = new Writer();
  const visit = (node: InstNode, isRoot: boolean) => {
    const props: Prop[] = [str("Name", node.name)];
    for (const [k, v] of Object.entries(node.props ?? {})) props.push(xmlProp(node.className, k, v, refs));
    if (node.source !== undefined) props.push(protectedString("Source", node.source));
    if (node.attrs && Object.keys(node.attrs).length) props.push(attributes(node.attrs));
    if (isRoot) props.push(...extraRootProps);
    w.open(node.className, props);
    for (const c of node.children ?? []) visit(c, false);
    w.close();
  };
  for (const r of roots) visit(r, true);
  return w.toString();
}

export function vfxToRbxmx(spec: VfxSpec, opts: ImportOptions = {}): string {
  const tree = vfxTree(spec);
  tree.props = { ...tree.props, WorldPivot: { cf: { pos: [0, 0, 0] } } };
  return writeTree([tree], forgeAttrs(opts));
}

/** An ability as one self-contained Tool: drop it into StarterPack and play-test. */
export function abilityToRbxmx(r: ResolvedAbility, opts: ImportOptions = {}): string {
  return writeTree([standaloneTool(r)], forgeAttrs(opts));
}
