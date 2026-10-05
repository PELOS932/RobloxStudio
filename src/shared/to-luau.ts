// Deterministic spec → Luau converters. The generated code runs through the
// Roblox Studio MCP (execute_luau) or can be pasted into the Studio command bar.
// It builds everything off-tree, parents once, wraps the change in a
// ChangeHistoryService recording (undo-able) and returns a small JSON summary.

import { luaLongString, luaNum, luaString } from "./luau.ts";
import { toNativeModel, type ModelSpec, type NativePart } from "./model.ts";
import { optimizeParts, type OptimizeStats } from "./optimize.ts";
import { hexToRgb } from "./math.ts";
import { FONTS, FONT_WEIGHT_NAMES, fontFamilyUrl } from "./roblox-data.ts";
import {
  AUTO_SCALE_ROOT, autoScaleSource, buildUiTree, cornerOf, gradientStops, paddingOf, resolveUiNode,
  type UiSpec, type UiTreeNode,
} from "./ui.ts";
import type { ScriptSpec } from "./script.ts";

export interface ImportOptions {
  assetId?: string;
  version?: number;
  /** Dot path from game. Defaults: Workspace (models), StarterGui (UI), ServerScriptService (scripts). */
  parent?: string;
  /** Models only. camera = in front of the Studio camera on the ground; origin = at 0,0,0; keep = spec coordinates. */
  placement?: "camera" | "origin" | "keep";
  /** Camera placement: turn the model's front (-Z) toward the camera, in 90° steps. */
  faceCamera?: boolean;
  /** Replace a previous import of the same asset (keeps its position). */
  replace?: boolean;
  /** Merge identical touching blocks to cut part count. */
  optimize?: boolean;
  /** Static-geometry performance flags (CanTouch off, no shadows for tiny/neon parts). */
  performance?: boolean;
  anchored?: boolean;
  select?: boolean;
}

export interface LuauResult {
  code: string;
  stats?: OptimizeStats;
}

const RUNTIME = String.raw`
local function forgeResolve(path)
	local node = game
	for segment in string.gmatch(path, "[^%.]+") do
		local nextNode = node:FindFirstChild(segment)
		if not nextNode and node == game then
			local ok, service = pcall(function() return game:GetService(segment) end)
			if ok then nextNode = service end
		end
		if not nextNode then error("Path not found: " .. path, 0) end
		node = nextNode
	end
	return node
end

local function forgeJson(value)
	local kind = type(value)
	if kind == "table" then
		local items = {}
		for k, v in value do
			table.insert(items, forgeJson(tostring(k)) .. ":" .. forgeJson(v))
		end
		return "{" .. table.concat(items, ",") .. "}"
	elseif kind == "string" then
		return '"' .. string.gsub(value, '[%c"\\]', function(c)
			return string.format("\\u%04x", string.byte(c))
		end) .. '"'
	elseif kind == "number" or kind == "boolean" then
		return tostring(value)
	end
	return "null"
end

local function forgeFindPrevious(parent, assetId)
	if not assetId then return nil end
	for _, child in parent:GetChildren() do
		if child:GetAttribute("ForgeAssetId") == assetId then return child end
	end
	return nil
end

local forgeHistory = nil
local forgeRecording = nil
pcall(function()
	forgeHistory = game:GetService("ChangeHistoryService")
	forgeRecording = forgeHistory:TryBeginRecording(FORGE_LABEL)
end)

local function forgeFinish(ok, result)
	if forgeRecording then
		pcall(function()
			forgeHistory:FinishRecording(forgeRecording, if ok then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel)
		end)
	end
	if not ok then return forgeJson({ ok = false, error = tostring(result) }) end
	return forgeJson(result)
end
`;

function header(kind: string, name: string, extra: string, opts: ImportOptions, label: string): string {
  return [
    `-- Studio Forge · ${kind} "${name.replace(/[\r\n]/g, " ")}"${extra}`,
    `-- Paste into the Studio command bar, or let Studio Forge import it through the Roblox Studio MCP.`,
    `local FORGE_ASSET_ID = ${opts.assetId ? luaString(opts.assetId) : "nil"}`,
    `local FORGE_VERSION = ${opts.version ?? 1}`,
    `local FORGE_LABEL = ${luaString(label)}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Models

export function modelToLuau(spec: ModelSpec, opts: ImportOptions = {}): LuauResult {
  const native = toNativeModel(spec, { performance: opts.performance ?? true, anchored: opts.anchored ?? true });
  let parts = native.parts;
  let stats: OptimizeStats | undefined;
  if (opts.optimize ?? true) {
    const r = optimizeParts(parts);
    parts = r.parts;
    stats = r.stats;
  }
  const { min, max } = native.bounds;
  const pivot = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);

  const materials: string[] = [];
  const matIndex = (m: string) => {
    let i = materials.indexOf(m);
    if (i < 0) i = materials.push(m) - 1;
    return i + 1;
  };

  // Group paths and the most common flag set are shared; trailing defaults are left out.
  const groups: string[] = [];
  const groupIndex = (g: string) => {
    if (!g) return 0;
    let i = groups.indexOf(g);
    if (i < 0) i = groups.push(g) - 1;
    return i + 1;
  };
  const flagCounts = new Map<number, number>();
  for (const p of parts) flagCounts.set(partFlags(p), (flagCounts.get(partFlags(p)) ?? 0) + 1);
  const defaultFlags = [...flagCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 13;

  const lines: string[] = [];
  for (const p of parts) {
    const call = partCall(p, matIndex(p.material), groupIndex(p.group), defaultFlags);
    if (p.light) {
      const l = p.light;
      const extra = l.className === "PointLight" ? "" : `, ${luaNum(l.angle)}, Enum.NormalId.${l.face}`;
      lines.push(
        `\tL(${call}, "${l.className}", ${l.color.join(", ")}, ${luaNum(l.brightness)}, ${luaNum(l.range)}, ${l.shadows}${extra})`,
      );
    } else {
      lines.push(`\t${call}`);
    }
  }

  const extra = stats && stats.after !== stats.before
    ? ` · ${parts.length} parts (optimized from ${stats.before})`
    : ` · ${parts.length} parts`;
  const code = `${header("model", spec.name, extra, opts, `Forge: import ${spec.name}`)}
local PARENT_PATH = ${luaString(opts.parent ?? "Workspace")}
local PLACEMENT = ${luaString(opts.placement ?? "camera")}
local REPLACE = ${opts.replace ?? true}
local SELECT = ${opts.select ?? true}
${RUNTIME}
local ok, result = pcall(function()
	local parent = forgeResolve(PARENT_PATH)
	local model = Instance.new("Model")
	model.Name = ${luaString(spec.name)}
	local groups = {}
	local function group(path)
		if path == nil then return model end
		local existing = groups[path]
		if existing then return existing end
		local parentPath, leaf = string.match(path, "^(.*)/([^/]+)$")
		local g = Instance.new("Model")
		g.Name = leaf or path
		g.Parent = if parentPath then group(parentPath) else model
		groups[path] = g
		return g
	end
	local MAT = { ${materials.map((m) => `Enum.Material.${m}`).join(", ")} }
	local SHAPE = { Enum.PartType.Block, Enum.PartType.Ball, Enum.PartType.Cylinder }
	local G = { ${groups.map((g) => luaString(g)).join(", ")} }
	local DEFAULT_FLAGS = ${defaultFlags}
	local count = 0
	-- flags: 1 CanCollide, 2 CanTouch, 4 CastShadow, 8 Anchored
	local function P(shape, name, sx, sy, sz, cf, r, g, b, mat, groupIndex, flags, transparency, reflectance)
		flags = flags or DEFAULT_FLAGS
		local part = Instance.new(if shape == 4 then "WedgePart" else "Part")
		if shape ~= 4 then part.Shape = SHAPE[shape] end
		part.Name = name
		part.Size = Vector3.new(sx, sy, sz)
		part.CFrame = cf
		part.Color = Color3.fromRGB(r, g, b)
		part.Material = MAT[mat]
		part.Transparency = transparency or 0
		part.Reflectance = reflectance or 0
		part.Anchored = bit32.btest(flags, 8)
		part.CanCollide = bit32.btest(flags, 1)
		part.CanTouch = bit32.btest(flags, 2)
		part.CastShadow = bit32.btest(flags, 4)
		part.TopSurface = Enum.SurfaceType.Smooth
		part.BottomSurface = Enum.SurfaceType.Smooth
		part.Parent = group(G[groupIndex or 0])
		count += 1
		return part
	end
	local function L(part, className, r, g, b, brightness, range, shadows, angle, face)
		local light = Instance.new(className)
		light.Color = Color3.fromRGB(r, g, b)
		light.Brightness = brightness
		light.Range = range
		light.Shadows = shadows
		if angle then light.Angle = angle end
		if face then light.Face = face end
		light.Parent = part
	end
	local C = CFrame.new
${lines.join("\n")}

	local pivot = CFrame.new(${pivot.map((v) => luaNum(v)).join(", ")})
	model.WorldPivot = pivot
	local function pivotTo(target)
		-- Model:PivotTo moves every part natively; the loop below is the fallback.
		if pcall(function() model:PivotTo(target) end) then return end
		local delta = target * pivot:Inverse()
		for _, d in model:GetDescendants() do
			if d:IsA("BasePart") then d.CFrame = delta * d.CFrame end
		end
		model.WorldPivot = target
	end

	local function pivotOf(instance)
		local ok, cf = pcall(function() return instance:GetPivot() end)
		if ok and cf then return cf end
		ok, cf = pcall(function() return instance.WorldPivot end)
		if ok and cf then return cf end
		if instance:IsA("BasePart") then return instance.CFrame end
		return pivot
	end

	local previous = if REPLACE then forgeFindPrevious(parent, FORGE_ASSET_ID) else nil
	if previous then
		pivotTo(pivotOf(previous))
		previous.Parent = nil
	elseif PLACEMENT == "camera" then
		local placed = pcall(function()
			local cam = workspace.CurrentCamera.CFrame
			local extent = ${luaNum(extent)}
			local params = RaycastParams.new()
			params.FilterType = Enum.RaycastFilterType.Exclude
			params.FilterDescendantsInstances = { model }
			-- Where the camera looks (the middle of the viewport), if that is a floor far enough away…
			local target
			local look = workspace:Raycast(cam.Position, cam.LookVector * math.max(256, extent * 8), params)
			if look and look.Normal.Y > 0.6 and look.Distance > extent * 0.8 then
				target = look.Position
			else
				-- …otherwise straight ahead, dropped onto whatever is below.
				local ahead = cam.Position + cam.LookVector * math.max(16, extent * 1.5)
				local hit = workspace:Raycast(ahead + Vector3.new(0, 500, 0), Vector3.new(0, -2000, 0), params)
				target = Vector3.new(ahead.X, if hit then hit.Position.Y else 0, ahead.Z)
			end
			-- On whole studs, with the model's front (-Z) turned toward the camera in 90° steps.
			local x, z = math.round(target.X), math.round(target.Z)
			local dx, dz = cam.Position.X - x, cam.Position.Z - z
			local yaw = 0
			if ${opts.faceCamera ?? true} and dx * dx + dz * dz > 0.01 then
				yaw = math.round(math.atan2(-dx, -dz) / (math.pi / 2)) * (math.pi / 2)
			end
			pivotTo(CFrame.new(x, target.Y, z) * CFrame.Angles(0, yaw, 0))
		end)
		if not placed then pivotTo(CFrame.new(0, 0, 0)) end
	elseif PLACEMENT == "origin" then
		pivotTo(CFrame.new(0, 0, 0))
	end

	if FORGE_ASSET_ID then
		model:SetAttribute("ForgeAssetId", FORGE_ASSET_ID)
		model:SetAttribute("ForgeVersion", FORGE_VERSION)
	end
	model.Parent = parent
	if SELECT then
		pcall(function() game:GetService("Selection"):Set({ model }) end)
	end
	return { ok = true, kind = "model", path = model:GetFullName(), parts = count, replaced = previous ~= nil }
end)
return forgeFinish(ok, result)
`;
  return { code, stats };
}

function partFlags(p: NativePart): number {
  return (p.canCollide ? 1 : 0) | (p.canTouch ? 2 : 0) | (p.castShadow ? 4 : 0) | (p.anchored ? 8 : 0);
}

function partCall(p: NativePart, mat: number, group: number, defaultFlags: number): string {
  const shape = p.className === "WedgePart" ? 4 : p.shape === "Ball" ? 2 : p.shape === "Cylinder" ? 3 : 1;
  const isIdentity = p.rot.every((v, i) => Math.abs(v - [1, 0, 0, 0, 1, 0, 0, 0, 1][i]) < 1e-9);
  const pos = p.pos.map((v) => luaNum(v)).join(", ");
  const cf = isIdentity ? `C(${pos})` : `C(${pos}, ${p.rot.map((v) => luaNum(v, 6)).join(", ")})`;
  const args = [String(shape), luaString(p.name), ...p.size.map((v) => luaNum(v)), cf, ...p.color.map(String), String(mat)];
  // Optional tail: group index, flags, transparency, reflectance (defaults 0, DEFAULT_FLAGS, 0, 0).
  const tail = [String(group), String(partFlags(p)), luaNum(p.transparency, 3), luaNum(p.reflectance, 3)];
  const defaults = ["0", String(defaultFlags), "0", "0"];
  while (tail.length && tail[tail.length - 1] === defaults[tail.length - 1]) tail.pop();
  return `P(${[...args, ...tail].join(", ")})`;
}

// ---------------------------------------------------------------------------
// UI

// Short aliases keep the generated script small (U2/C3/V2/UD are defined in the script).
const color3 = (hex: string) => `C3(${hexToRgb(hex).join(", ")})`;
const udim2 = (u: number[]) => `U2(${u.map((v) => luaNum(v)).join(", ")})`;
const udim = (scale: number, offset: number) => `UD(${luaNum(scale)}, ${luaNum(offset)})`;
const X_ALIGN = { left: "Left", center: "Center", right: "Right" } as const;
const Y_ALIGN = { top: "Top", center: "Center", bottom: "Bottom" } as const;
const AUTO = { x: "X", y: "Y", xy: "XY" } as const;

interface UiEmit {
  out: string[];
  n: number;
  /** Font.new(...) expressions, shared through a table in the script. */
  fonts: string[];
}

function fontRef(font: keyof typeof FONTS, e: UiEmit): string {
  const expr = `Font.new(${luaString(fontFamilyUrl(font))}, Enum.FontWeight.${FONT_WEIGHT_NAMES[FONTS[font].weight]}, Enum.FontStyle.${FONTS[font].style})`;
  let i = e.fonts.indexOf(expr);
  if (i < 0) i = e.fonts.push(expr) - 1;
  return `F[${i + 1}]`;
}

/**
 * One node and its modifiers. Only values that differ from what Instance.new already
 * gives are written (the Lune parity test checks the result matches the .rbxmx export).
 */
function uiNodeLines(t: UiTreeNode, parentRef: string, e: UiEmit) {
  const { out } = e;
  const n = t.node;
  const r = resolveUiNode(n);
  const ref = `N[${++e.n}]`;
  const props: string[] = [`Name = ${luaString(r.name)}`, `Position = ${udim2(r.pos)}`, `Size = ${udim2(r.size)}`];
  if (r.anchor[0] || r.anchor[1]) props.push(`AnchorPoint = V2(${luaNum(r.anchor[0])}, ${luaNum(r.anchor[1])})`);
  props.push(`BackgroundColor3 = ${color3(r.bg)}`);
  if (r.bgT) props.push(`BackgroundTransparency = ${luaNum(r.bgT, 3)}`);
  props.push(`BorderSizePixel = 0`);
  if (r.z !== 1) props.push(`ZIndex = ${r.z}`);
  if (r.order) props.push(`LayoutOrder = ${r.order}`);
  if (!r.visible) props.push(`Visible = false`);
  if (r.clip !== (n.type === "ScrollingFrame")) props.push(`ClipsDescendants = ${r.clip}`);
  if (r.rotation) props.push(`Rotation = ${luaNum(r.rotation)}`);
  if (r.autoSize) props.push(`AutomaticSize = Enum.AutomaticSize.${AUTO[r.autoSize]}`);
  if (r.isText) {
    props.push(`Text = ${luaString(r.text)}`, `TextColor3 = ${color3(r.textColor)}`, `TextSize = ${luaNum(r.textSize)}`, `FontFace = ${fontRef(r.font, e)}`);
    if (r.textScaled) props.push(`TextScaled = true`);
    if (r.textWrapped) props.push(`TextWrapped = true`);
    if (r.xAlign !== "center") props.push(`TextXAlignment = Enum.TextXAlignment.${X_ALIGN[r.xAlign]}`);
    if (r.yAlign !== "center") props.push(`TextYAlignment = Enum.TextYAlignment.${Y_ALIGN[r.yAlign]}`);
    if (r.textT) props.push(`TextTransparency = ${luaNum(r.textT, 3)}`);
    if (r.rich) props.push(`RichText = true`);
    if (n.truncate) props.push(`TextTruncate = Enum.TextTruncate.AtEnd`);
    if (n.textStroke) {
      props.push(
        `TextStrokeColor3 = ${color3(n.textStroke.color ?? "#000000")}`,
        `TextStrokeTransparency = ${luaNum(n.textStroke.transparency ?? 0, 3)}`,
      );
    }
    if (n.type === "TextBox") {
      props.push(`ClearTextOnFocus = false`);
      if (n.placeholder !== undefined) props.push(`PlaceholderText = ${luaString(n.placeholder)}`);
      if (n.placeholderColor) props.push(`PlaceholderColor3 = ${color3(n.placeholderColor)}`);
    }
  }
  if (r.isImage) {
    props.push(`Image = ${luaString(n.image ?? "")}`);
    if (n.imageColor && n.imageColor.toLowerCase() !== "#ffffff") props.push(`ImageColor3 = ${color3(n.imageColor)}`);
    if (n.imageT) props.push(`ImageTransparency = ${luaNum(n.imageT, 3)}`);
    if (n.scaleType && n.scaleType !== "Stretch") props.push(`ScaleType = Enum.ScaleType.${n.scaleType}`);
    if (n.slice) props.push(`SliceCenter = Rect.new(${n.slice.map((v) => luaNum(v)).join(", ")})`);
  }
  if (n.type === "ScrollingFrame") {
    props.push(`CanvasSize = ${udim2(n.canvas ?? [0, 0, 0, 0])}`);
    props.push(`ScrollBarThickness = ${luaNum(n.scrollBar ?? 6)}`);
    props.push(`ScrollBarImageColor3 = ${color3(n.scrollColor ?? "#ffffff")}`);
    if (n.autoCanvas) props.push(`AutomaticCanvasSize = Enum.AutomaticSize.${AUTO[n.autoCanvas]}`);
  }
  out.push(`\t${ref} = new(${luaString(n.type)}, ${parentRef}, { ${props.join(", ")} })`);

  const corner = cornerOf(n);
  if (corner) out.push(`\tnew("UICorner", ${ref}, { CornerRadius = ${udim(corner[0], corner[1])} })`);
  if (n.stroke) {
    const sp = [`ApplyStrokeMode = Enum.ApplyStrokeMode.Border`];
    const color = (n.stroke.color ?? "#000000").toLowerCase();
    if (color !== "#000000") sp.push(`Color = ${color3(color)}`);
    if ((n.stroke.thickness ?? 1) !== 1) sp.push(`Thickness = ${luaNum(n.stroke.thickness ?? 1)}`);
    if (n.stroke.transparency) sp.push(`Transparency = ${luaNum(n.stroke.transparency, 3)}`);
    out.push(`\tnew("UIStroke", ${ref}, { ${sp.join(", ")} })`);
  }
  if (n.gradient) {
    const g = n.gradient;
    const stops = gradientStops(g);
    const kps = stops.map((st) => `ColorSequenceKeypoint.new(${luaNum(st.t)}, ${color3(st.color)})`);
    const gp = [`Color = ColorSequence.new({ ${kps.join(", ")} })`];
    if (g.rotation) gp.push(`Rotation = ${luaNum(g.rotation)}`);
    if (g.transparency) {
      const tk = stops.map((st) => `NumberSequenceKeypoint.new(${luaNum(st.t)}, ${luaNum(st.transparency, 3)})`);
      gp.push(`Transparency = NumberSequence.new({ ${tk.join(", ")} })`);
    }
    out.push(`\tnew("UIGradient", ${ref}, { ${gp.join(", ")} })`);
  }
  const pad = paddingOf(n);
  if (pad) {
    const names = ["PaddingTop", "PaddingRight", "PaddingBottom", "PaddingLeft"];
    const pp = pad.map((v, i) => (v ? `${names[i]} = ${udim(0, v)}` : "")).filter(Boolean);
    if (pp.length) out.push(`\tnew("UIPadding", ${ref}, { ${pp.join(", ")} })`);
  }
  if (n.layout) {
    const l = n.layout;
    const hAlign = l.hAlign ?? "left";
    const vAlign = l.vAlign ?? "top";
    const align: string[] = [];
    if (hAlign !== "left") align.push(`HorizontalAlignment = Enum.HorizontalAlignment.${X_ALIGN[hAlign]}`);
    if (vAlign !== "top") align.push(`VerticalAlignment = Enum.VerticalAlignment.${Y_ALIGN[vAlign]}`);
    if (l.type === "list") {
      const lp: string[] = [];
      if (l.dir === "horizontal") lp.push(`FillDirection = Enum.FillDirection.Horizontal`);
      if (l.gap) lp.push(`Padding = ${udim(0, l.gap)}`);
      lp.push(...align, `SortOrder = Enum.SortOrder.LayoutOrder`);
      if (l.wraps) lp.push(`Wraps = true`);
      out.push(`\tnew("UIListLayout", ${ref}, { ${lp.join(", ")} })`);
    } else {
      const gap = l.cellGap ?? [5, 5];
      const gp = [`CellSize = ${udim2(l.cell ?? [0, 100, 0, 100])}`];
      if (gap[0] !== 5 || gap[1] !== 5) gp.push(`CellPadding = U2(0, ${luaNum(gap[0])}, 0, ${luaNum(gap[1])})`);
      if (l.dir === "vertical") gp.push(`FillDirection = Enum.FillDirection.Vertical`);
      gp.push(...align, `SortOrder = Enum.SortOrder.LayoutOrder`);
      if (l.maxCells) gp.push(`FillDirectionMaxCells = ${l.maxCells}`);
      out.push(`\tnew("UIGridLayout", ${ref}, { ${gp.join(", ")} })`);
    }
  }
  if (n.aspect) out.push(`\tnew("UIAspectRatioConstraint", ${ref}, { AspectRatio = ${luaNum(n.aspect)} })`);
  for (const c of t.children) uiNodeLines(c, ref, e);
}

export function uiToLuau(spec: UiSpec, opts: ImportOptions = {}): LuauResult {
  const e: UiEmit = { out: [], n: 0, fonts: [] };
  const rootRef = spec.autoScale ? "scaleRoot" : "gui";
  for (const root of buildUiTree(spec)) uiNodeLines(root, rootRef, e);
  const out = e.out;
  const autoScale = spec.autoScale
    ? `
	-- Proportional scaling from the design resolution (see AutoScaleController).
	local scaleRoot = new("Frame", gui, { Name = ${luaString(AUTO_SCALE_ROOT)}, AnchorPoint = V2(0.5, 0.5), Position = U2(0.5, 0, 0.5, 0), Size = U2(1, 0, 1, 0), BackgroundTransparency = 1, BorderSizePixel = 0 })
	new("UIScale", scaleRoot, { Name = "AutoScale", Scale = 1 })
	local controller = Instance.new("LocalScript")
	controller.Name = "AutoScaleController"
	controller.Source = ${luaLongString(autoScaleSource(spec.autoScale))}
	controller.Parent = gui`
    : "";
  const code = `${header("UI", spec.name, ` · ${spec.nodes.length} elements`, opts, `Forge: import ${spec.name}`)}
local PARENT_PATH = ${luaString(opts.parent ?? "StarterGui")}
local REPLACE = ${opts.replace ?? true}
local SELECT = ${opts.select ?? true}
${RUNTIME}
local ok, result = pcall(function()
	local parent = forgeResolve(PARENT_PATH)
	local gui = Instance.new("ScreenGui")
	gui.Name = ${luaString(spec.name)}
	gui.ResetOnSpawn = ${spec.resetOnSpawn ?? false}
	gui.IgnoreGuiInset = ${spec.ignoreInset ?? false}
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	gui.DisplayOrder = ${spec.displayOrder ?? 0}
	local function new(className, parentInstance, props)
		local object = Instance.new(className)
		for key, value in props do
			(object :: any)[key] = value
		end
		object.Parent = parentInstance
		return object
	end
	local U2, C3, V2, UD = UDim2.new, Color3.fromRGB, Vector2.new, UDim.new
	local F = { ${e.fonts.join(", ")} }
	local N = {}${autoScale}
${out.join("\n")}

	local previous = if REPLACE then forgeFindPrevious(parent, FORGE_ASSET_ID) else nil
	if previous then previous.Parent = nil end
	if FORGE_ASSET_ID then
		gui:SetAttribute("ForgeAssetId", FORGE_ASSET_ID)
		gui:SetAttribute("ForgeVersion", FORGE_VERSION)
	end
	gui.Parent = parent
	if SELECT then
		pcall(function() game:GetService("Selection"):Set({ gui }) end)
	end
	return { ok = true, kind = "ui", path = gui:GetFullName(), elements = #N, replaced = previous ~= nil }
end)
return forgeFinish(ok, result)
`;
  return { code };
}

// ---------------------------------------------------------------------------
// Scripts

export function scriptToLuau(spec: ScriptSpec, opts: ImportOptions = {}): LuauResult {
  const code = `${header("script", spec.name, ` · ${spec.kind}`, opts, `Forge: import ${spec.name}`)}
local PARENT_PATH = ${luaString(opts.parent ?? spec.parent ?? "ServerScriptService")}
local REPLACE = ${opts.replace ?? true}
local SELECT = ${opts.select ?? true}
local SOURCE = ${luaLongString(spec.source)}
${RUNTIME}
local ok, result = pcall(function()
	local parent = forgeResolve(PARENT_PATH)
	local script = Instance.new(${luaString(spec.kind)})
	script.Name = ${luaString(spec.name)}
	script.Source = SOURCE
	local previous = if REPLACE then forgeFindPrevious(parent, FORGE_ASSET_ID) else nil
	if previous then previous.Parent = nil end
	if FORGE_ASSET_ID then
		script:SetAttribute("ForgeAssetId", FORGE_ASSET_ID)
		script:SetAttribute("ForgeVersion", FORGE_VERSION)
	end
	script.Parent = parent
	if SELECT then
		pcall(function() game:GetService("Selection"):Set({ script }) end)
	end
	return { ok = true, kind = "script", path = script:GetFullName(), lines = #string.split(SOURCE, "\\n"), replaced = previous ~= nil }
end)
return forgeFinish(ok, result)
`;
  return { code };
}
