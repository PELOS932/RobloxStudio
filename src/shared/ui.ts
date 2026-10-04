import { z } from "zod";
import { FONT_NAMES, type FontName } from "./roblox-data.ts";
import { hexColor, normalizeHex, uniqueName } from "./model.ts";

export const UI_TYPES = ["Frame", "TextLabel", "TextButton", "TextBox", "ImageLabel", "ImageButton", "ScrollingFrame"] as const;
export type UiType = (typeof UI_TYPES)[number];

const udim2 = (d: string) => z.array(z.number()).length(4).describe(d);
const num2 = (d: string) => z.array(z.number()).length(2).describe(d);
const align = z.enum(["left", "center", "right"]);
const valign = z.enum(["top", "center", "bottom"]);

export const UiNodeSchema = z.object({
  name: z.string().min(1).max(60).describe("unique node name"),
  parent: z.string().optional().describe("parent node name; omit for top level"),
  type: z.enum(UI_TYPES),
  pos: udim2("UDim2 [xScale,xOffset,yScale,yOffset], default [0,0,0,0]").optional(),
  size: udim2("UDim2 [xScale,xOffset,yScale,yOffset], default [0,100,0,100]").optional(),
  anchor: num2("AnchorPoint [x,y], default [0,0]").optional(),
  bg: hexColor.optional().describe("BackgroundColor3, default #ffffff"),
  bgT: z.number().min(0).max(1).optional().describe("BackgroundTransparency; default 0, but 1 for TextLabel/ImageLabel/ImageButton"),
  rotation: z.number().optional(),
  z: z.number().int().optional().describe("ZIndex, default 1"),
  order: z.number().int().optional().describe("LayoutOrder"),
  visible: z.boolean().optional(),
  clip: z.boolean().optional().describe("ClipsDescendants"),
  autoSize: z.enum(["x", "y", "xy"]).optional().describe("AutomaticSize"),
  corner: z.union([z.number(), num2("[scale,offset]")]).optional().describe("UICorner radius: px, or [scale,offset] (0.5 scale = pill/circle)"),
  stroke: z
    .object({ color: hexColor.optional(), thickness: z.number().min(0).max(40).optional(), transparency: z.number().min(0).max(1).optional() })
    .optional()
    .describe("UIStroke border (outside the edge)"),
  gradient: z
    .object({
      colors: z.array(hexColor).min(2).max(8).describe("color stops (evenly spaced unless stops is given)"),
      stops: z.array(z.number().min(0).max(1)).min(2).max(8).optional().describe("stop positions 0..1, same length as colors"),
      rotation: z.number().optional().describe("degrees; 0 = left→right, 90 = top→bottom"),
      transparency: z.array(z.number().min(0).max(1)).min(2).max(8).optional().describe("per color stop (or evenly spaced)"),
    })
    .optional()
    .describe("UIGradient (multiplies node colors; use bg #ffffff for exact colors)"),
  padding: z.union([z.number(), z.array(z.number()).length(4)]).optional().describe("UIPadding px: all, or [top,right,bottom,left]"),
  layout: z
    .object({
      type: z.enum(["list", "grid"]),
      dir: z.enum(["vertical", "horizontal"]).optional().describe("list FillDirection, default vertical"),
      gap: z.number().optional().describe("list padding px"),
      hAlign: align.optional(),
      vAlign: valign.optional(),
      wraps: z.boolean().optional().describe("list only"),
      cell: udim2("grid CellSize UDim2").optional(),
      cellGap: num2("grid CellPadding px [x,y]").optional(),
      maxCells: z.number().int().optional().describe("grid FillDirectionMaxCells"),
    })
    .optional()
    .describe("UIListLayout/UIGridLayout; children are positioned by the layout and sorted by order"),
  aspect: z.number().positive().optional().describe("UIAspectRatioConstraint width/height"),
  text: z.string().max(2000).optional(),
  textColor: hexColor.optional().describe("default #ffffff"),
  textSize: z.number().min(1).max(100).optional().describe("px, default 18"),
  font: z.enum(FONT_NAMES).optional().describe("Enum.Font, default GothamMedium"),
  textScaled: z.boolean().optional(),
  textWrapped: z.boolean().optional(),
  xAlign: align.optional().describe("TextXAlignment, default center"),
  yAlign: valign.optional().describe("TextYAlignment, default center"),
  textT: z.number().min(0).max(1).optional().describe("TextTransparency"),
  textStroke: z.object({ color: hexColor.optional(), transparency: z.number().min(0).max(1).optional() }).optional(),
  rich: z.boolean().optional().describe("RichText"),
  truncate: z.boolean().optional().describe("TextTruncate AtEnd (… when text doesn't fit)"),
  placeholder: z.string().optional().describe("TextBox PlaceholderText"),
  placeholderColor: hexColor.optional(),
  image: z.string().optional().describe("rbxassetid://ID"),
  imageColor: hexColor.optional(),
  imageT: z.number().min(0).max(1).optional(),
  scaleType: z.enum(["Stretch", "Slice", "Tile", "Fit", "Crop"]).optional(),
  slice: z.array(z.number()).length(4).optional().describe("SliceCenter [x0,y0,x1,y1]"),
  canvas: udim2("ScrollingFrame CanvasSize").optional(),
  autoCanvas: z.enum(["x", "y", "xy"]).optional().describe("ScrollingFrame AutomaticCanvasSize"),
  scrollBar: z.number().min(0).max(40).optional().describe("ScrollBarThickness px, default 6"),
  scrollColor: hexColor.optional(),
});

export const UiSpecSchema = z.object({
  name: z.string().min(1).max(60).describe("ScreenGui name"),
  description: z.string().max(500).optional(),
  ignoreInset: z.boolean().optional().describe("IgnoreGuiInset (cover the top bar), default false"),
  resetOnSpawn: z.boolean().optional().describe("default false"),
  displayOrder: z.number().int().optional(),
  autoScale: z
    .object({
      width: z.number().min(200).max(4000).describe("design width px"),
      height: z.number().min(200).max(4000).describe("design height px"),
      min: z.number().min(0.1).max(1).optional().describe("smallest scale, default 0.35"),
      max: z.number().min(1).max(4).optional().describe("largest scale, default 1.5"),
    })
    .optional()
    .describe("Scale the whole UI proportionally from a design resolution (adds a UIScale + small LocalScript)"),
  nodes: z.array(UiNodeSchema).min(1).max(3000).describe("flat list; children reference parent by name; list order = sibling order"),
});

export type UiNode = z.infer<typeof UiNodeSchema>;
export type UiSpec = z.infer<typeof UiSpecSchema>;

export interface UiTreeNode {
  node: UiNode;
  children: UiTreeNode[];
}

/** Ensure unique names and valid parent references. Run once when an asset is saved. */
export function sanitizeUiSpec(spec: UiSpec): { spec: UiSpec; warnings: string[] } {
  const warnings: string[] = [];
  const used = new Set<string>();
  const renamed = new Map<string, string>();
  const nodes = spec.nodes.map((n, i) => {
    const base = n.name?.trim() || `${n.type}${i + 1}`;
    const name = uniqueName(base, used);
    if (name !== base) warnings.push(`renamed duplicate node "${base}" to "${name}"`);
    if (!renamed.has(base)) renamed.set(base, name);
    const out: UiNode = { ...n, name };
    for (const key of ["bg", "textColor", "placeholderColor", "imageColor", "scrollColor"] as const) {
      if (out[key]) out[key] = normalizeHex(out[key]!);
    }
    return out;
  });
  const names = new Set(nodes.map((n) => n.name));
  for (const n of nodes) {
    if (n.parent === undefined) continue;
    if (n.parent === n.name || !names.has(n.parent)) {
      warnings.push(`node "${n.name}" has unknown parent "${n.parent}", moved to top level`);
      delete n.parent;
    }
  }
  // Break cycles.
  const byName = new Map(nodes.map((n) => [n.name, n]));
  for (const n of nodes) {
    const seen = new Set<string>([n.name]);
    let p = n.parent;
    while (p) {
      if (seen.has(p)) {
        warnings.push(`parent cycle at "${n.name}", moved to top level`);
        delete n.parent;
        break;
      }
      seen.add(p);
      p = byName.get(p)?.parent;
    }
  }
  return { spec: { ...spec, name: spec.name.trim() || "ScreenGui", nodes }, warnings };
}

export function buildUiTree(spec: UiSpec): UiTreeNode[] {
  const map = new Map<string, UiTreeNode>();
  for (const n of spec.nodes) map.set(n.name, { node: n, children: [] });
  const roots: UiTreeNode[] = [];
  for (const n of spec.nodes) {
    const t = map.get(n.name)!;
    const parent = n.parent ? map.get(n.parent) : undefined;
    if (parent && parent !== t) parent.children.push(t);
    else roots.push(t);
  }
  return roots;
}

/** Resolved node with all defaults filled in. Preview and Luau export both read this, so they agree. */
export interface ResolvedUiNode {
  name: string;
  type: UiType;
  pos: [number, number, number, number];
  size: [number, number, number, number];
  anchor: [number, number];
  bg: string;
  bgT: number;
  rotation: number;
  z: number;
  order: number;
  visible: boolean;
  clip: boolean;
  autoSize: "x" | "y" | "xy" | null;
  isText: boolean;
  isImage: boolean;
  text: string;
  textColor: string;
  textSize: number;
  font: FontName;
  textScaled: boolean;
  textWrapped: boolean;
  xAlign: "left" | "center" | "right";
  yAlign: "top" | "center" | "bottom";
  textT: number;
  rich: boolean;
}

export function resolveUiNode(n: UiNode): ResolvedUiNode {
  const isText = n.type === "TextLabel" || n.type === "TextButton" || n.type === "TextBox";
  const isImage = n.type === "ImageLabel" || n.type === "ImageButton";
  const transparentByDefault = n.type === "TextLabel" || n.type === "ImageLabel" || n.type === "ImageButton";
  const v4 = (a: number[] | undefined, d: [number, number, number, number]) =>
    (a && a.length === 4 ? [a[0], a[1], a[2], a[3]] : d) as [number, number, number, number];
  return {
    name: n.name,
    type: n.type,
    pos: v4(n.pos, [0, 0, 0, 0]),
    size: v4(n.size, [0, 100, 0, 100]),
    anchor: n.anchor && n.anchor.length === 2 ? [n.anchor[0], n.anchor[1]] : [0, 0],
    bg: n.bg ?? "#ffffff",
    bgT: n.bgT ?? (transparentByDefault ? 1 : 0),
    rotation: n.rotation ?? 0,
    z: n.z ?? 1,
    order: n.order ?? 0,
    visible: n.visible ?? true,
    clip: n.clip ?? (n.type === "ScrollingFrame"),
    autoSize: n.autoSize ?? null,
    isText,
    isImage,
    text: n.text ?? (n.type === "TextBox" ? "" : isText ? n.name : ""),
    textColor: n.textColor ?? "#ffffff",
    textSize: n.textSize ?? 18,
    font: n.font ?? "GothamMedium",
    textScaled: n.textScaled ?? false,
    textWrapped: n.textWrapped ?? false,
    xAlign: n.xAlign ?? "center",
    yAlign: n.yAlign ?? "center",
    textT: n.textT ?? 0,
    rich: n.rich ?? false,
  };
}

export function paddingOf(n: UiNode): [number, number, number, number] | null {
  if (n.padding === undefined) return null;
  if (typeof n.padding === "number") return [n.padding, n.padding, n.padding, n.padding];
  const [t, r, b, l] = n.padding;
  return [t, r, b, l];
}

export function cornerOf(n: UiNode): [number, number] | null {
  if (n.corner === undefined) return null;
  if (typeof n.corner === "number") return [0, n.corner];
  return [n.corner[0], n.corner[1]];
}

// ---------------------------------------------------------------------------
// Editing (edit_ui tool)

export const UiEditSchema = z.object({
  add: z.array(UiNodeSchema).optional().describe("new nodes (appended; set parent)"),
  update: z
    .array(UiNodeSchema.partial().extend({ name: z.string().describe("existing node name") }))
    .optional()
    .describe("partial updates matched by name; only listed fields change"),
  remove: z.array(z.string()).optional().describe("node names to delete (descendants are deleted too)"),
  rename: z.string().optional().describe("new ScreenGui name"),
});
export type UiEdit = z.infer<typeof UiEditSchema>;

export function applyUiEdit(spec: UiSpec, edit: UiEdit): { spec: UiSpec; missing: string[]; warnings: string[] } {
  const missing: string[] = [];
  let nodes = spec.nodes.slice();
  if (edit.remove?.length) {
    const rm = new Set<string>();
    for (const n of edit.remove) {
      if (!nodes.some((x) => x.name === n)) missing.push(n);
      else rm.add(n);
    }
    // Remove descendants as well.
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of nodes) if (n.parent && rm.has(n.parent) && !rm.has(n.name)) {
        rm.add(n.name);
        grew = true;
      }
    }
    nodes = nodes.filter((n) => !rm.has(n.name));
  }
  for (const u of edit.update ?? []) {
    const i = nodes.findIndex((n) => n.name === u.name);
    if (i < 0) {
      missing.push(u.name);
      continue;
    }
    const merged: Record<string, unknown> = { ...nodes[i] };
    for (const [k, v] of Object.entries(u)) if (v !== undefined) merged[k] = v;
    nodes[i] = merged as UiNode;
  }
  if (edit.add?.length) nodes = nodes.concat(edit.add);
  const { spec: next, warnings } = sanitizeUiSpec({ ...spec, name: edit.rename ?? spec.name, nodes });
  return { spec: next, missing, warnings };
}

/** Gradient stop positions (explicit or evenly spaced) and transparency per stop. */
export function gradientStops(g: NonNullable<UiNode["gradient"]>): { t: number; color: string; transparency: number }[] {
  const n = g.colors.length;
  const pos = g.stops && g.stops.length === n ? g.stops : g.colors.map((_, i) => i / (n - 1));
  const tr = g.transparency;
  return g.colors.map((color, i) => {
    let transparency = 0;
    if (tr && tr.length === n) transparency = tr[i];
    else if (tr && tr.length >= 2) {
      const x = pos[i] * (tr.length - 1);
      const k = Math.min(tr.length - 2, Math.floor(x));
      transparency = tr[k] + (tr[k + 1] - tr[k]) * (x - k);
    }
    return { t: pos[i], color, transparency };
  });
}

export const AUTO_SCALE_ROOT = "AutoScaleRoot";

export function autoScaleSource(a: NonNullable<UiSpec["autoScale"]>): string {
  return `-- Studio Forge: keeps this UI proportional on every screen (designed at ${a.width}x${a.height}).
local gui = script.Parent
local root = gui:WaitForChild("${AUTO_SCALE_ROOT}")
local uiScale = root:WaitForChild("AutoScale")
local DESIGN = Vector2.new(${a.width}, ${a.height})

local function update()
	local size = gui.AbsoluteSize
	if size.X < 2 or size.Y < 2 then return end
	local scale = math.clamp(math.min(size.X / DESIGN.X, size.Y / DESIGN.Y), ${a.min ?? 0.35}, ${a.max ?? 1.5})
	uiScale.Scale = scale
	root.Size = UDim2.fromScale(1 / scale, 1 / scale)
end

gui:GetPropertyChangedSignal("AbsoluteSize"):Connect(update)
update()
`;
}
