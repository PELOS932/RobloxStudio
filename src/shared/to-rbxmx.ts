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
  TEXT_Y_ALIGN_ENUM, VERTICAL_ALIGN_ENUM, ZINDEX_BEHAVIOR_SIBLING, APPLY_STROKE_MODE_BORDER,
} from "./roblox-data.ts";
import { buildUiTree, cornerOf, paddingOf, resolveUiNode, type UiSpec, type UiTreeNode } from "./ui.ts";
import type { ScriptSpec } from "./script.ts";
import type { ImportOptions } from "./to-luau.ts";

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
  for (const t of buildUiTree(spec)) writeUiNode(w, t);
  w.close();
  return w.toString();
}

const X_ALIGN = { left: TEXT_X_ALIGN_ENUM.Left, center: TEXT_X_ALIGN_ENUM.Center, right: TEXT_X_ALIGN_ENUM.Right };
const Y_ALIGN = { top: TEXT_Y_ALIGN_ENUM.Top, center: TEXT_Y_ALIGN_ENUM.Center, bottom: TEXT_Y_ALIGN_ENUM.Bottom };
const H_ALIGN = { left: HORIZONTAL_ALIGN_ENUM.Left, center: HORIZONTAL_ALIGN_ENUM.Center, right: HORIZONTAL_ALIGN_ENUM.Right };
const V_ALIGN = { top: VERTICAL_ALIGN_ENUM.Top, center: VERTICAL_ALIGN_ENUM.Center, bottom: VERTICAL_ALIGN_ENUM.Bottom };
const AUTO = { x: AUTOMATIC_SIZE_ENUM.X, y: AUTOMATIC_SIZE_ENUM.Y, xy: AUTOMATIC_SIZE_ENUM.XY };

function writeUiNode(w: Writer, t: UiTreeNode) {
  const n = t.node;
  const r = resolveUiNode(n);
  const props: Prop[] = [
    str("Name", r.name),
    udim2("Position", r.pos),
    udim2("Size", r.size),
    vec2("AnchorPoint", r.anchor),
    color3("BackgroundColor3", r.bg),
    float("BackgroundTransparency", r.bgT),
    int("BorderSizePixel", 0),
    int("ZIndex", r.z),
    int("LayoutOrder", r.order),
    bool("Visible", r.visible),
    bool("ClipsDescendants", r.clip),
  ];
  if (r.rotation) props.push(float("Rotation", r.rotation));
  if (r.autoSize) props.push(token("AutomaticSize", AUTO[r.autoSize]));
  if (r.isText) {
    props.push(
      str("Text", r.text),
      color3("TextColor3", r.textColor),
      float("TextSize", r.textSize),
      token("Font", FONTS[r.font].value),
      bool("TextScaled", r.textScaled),
      bool("TextWrapped", r.textWrapped),
      token("TextXAlignment", X_ALIGN[r.xAlign]),
      token("TextYAlignment", Y_ALIGN[r.yAlign]),
      float("TextTransparency", r.textT),
      bool("RichText", r.rich),
    );
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
    props.push(
      `<Content name="Image"><url>${esc(n.image ?? "")}</url></Content>`,
      color3("ImageColor3", n.imageColor ?? "#ffffff"),
      float("ImageTransparency", n.imageT ?? 0),
      token("ScaleType", SCALE_TYPE_ENUM[n.scaleType ?? "Stretch"]),
    );
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
    w.leaf("UIStroke", [
      str("Name", "UIStroke"),
      token("ApplyStrokeMode", APPLY_STROKE_MODE_BORDER),
      color3("Color", n.stroke.color ?? "#000000"),
      float("Thickness", n.stroke.thickness ?? 1),
      float("Transparency", n.stroke.transparency ?? 0),
    ]);
  }
  if (n.gradient) {
    const g = n.gradient;
    const cs = g.colors
      .map((c, i) => {
        const [cr, cg, cb] = hexToRgb(c).map((v) => v / 255);
        return `${num(i / (g.colors.length - 1))} ${cr} ${cg} ${cb} 0 `;
      })
      .join("");
    const gp: Prop[] = [str("Name", "UIGradient"), `<ColorSequence name="Color">${cs}</ColorSequence>`, float("Rotation", g.rotation ?? 0)];
    if (g.transparency) {
      const ns = g.transparency.map((v, i) => `${num(i / (g.transparency!.length - 1))} ${num(v)} 0 `).join("");
      gp.push(`<NumberSequence name="Transparency">${ns}</NumberSequence>`);
    }
    w.leaf("UIGradient", gp);
  }
  const pad = paddingOf(n);
  if (pad) {
    w.leaf("UIPadding", [
      str("Name", "UIPadding"),
      udim("PaddingTop", 0, pad[0]),
      udim("PaddingRight", 0, pad[1]),
      udim("PaddingBottom", 0, pad[2]),
      udim("PaddingLeft", 0, pad[3]),
    ]);
  }
  if (n.layout) {
    const l = n.layout;
    const h = H_ALIGN[l.hAlign ?? "left"];
    const v = V_ALIGN[l.vAlign ?? "top"];
    if (l.type === "list") {
      const lp: Prop[] = [
        str("Name", "UIListLayout"),
        token("FillDirection", l.dir === "horizontal" ? FILL_DIRECTION_ENUM.Horizontal : FILL_DIRECTION_ENUM.Vertical),
        udim("Padding", 0, l.gap ?? 0),
        token("HorizontalAlignment", h),
        token("VerticalAlignment", v),
        token("SortOrder", SORT_ORDER_LAYOUT_ORDER),
      ];
      if (l.wraps) lp.push(bool("Wraps", true));
      w.leaf("UIListLayout", lp);
    } else {
      const gap = l.cellGap ?? [5, 5];
      const gp: Prop[] = [
        str("Name", "UIGridLayout"),
        udim2("CellSize", l.cell ?? [0, 100, 0, 100]),
        udim2("CellPadding", [0, gap[0], 0, gap[1]]),
        token("FillDirection", l.dir === "vertical" ? FILL_DIRECTION_ENUM.Vertical : FILL_DIRECTION_ENUM.Horizontal),
        token("HorizontalAlignment", h),
        token("VerticalAlignment", v),
        token("SortOrder", SORT_ORDER_LAYOUT_ORDER),
      ];
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
  const cdata = "<![CDATA[" + spec.source.replace(/]]>/g, "]]]]><![CDATA[>") + "]]>";
  w.leaf(spec.kind, [str("Name", spec.name), `<ProtectedString name="Source">${cdata}</ProtectedString>`, ...forgeAttrs(opts)]);
  return w.toString();
}
