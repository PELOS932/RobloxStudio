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

  const lines: string[] = [];
  for (const p of parts) {
    const call = partCall(p, matIndex(p.material));
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
	local count = 0
	local function P(shape, name, sx, sy, sz, cf, r, g, b, mat, transparency, reflectance, collide, touch, shadow, anchored, groupPath)
		local part = Instance.new(if shape == 4 then "WedgePart" else "Part")
		if shape ~= 4 then part.Shape = SHAPE[shape] end
		part.Name = name
		part.Size = Vector3.new(sx, sy, sz)
		part.CFrame = cf
		part.Color = Color3.fromRGB(r, g, b)
		part.Material = MAT[mat]
		part.Transparency = transparency
		part.Reflectance = reflectance
		part.Anchored = anchored
		part.CanCollide = collide
		part.CanTouch = touch
		part.CastShadow = shadow
		part.TopSurface = Enum.SurfaceType.Smooth
		part.BottomSurface = Enum.SurfaceType.Smooth
		part.Parent = group(groupPath)
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
			local camera = workspace.CurrentCamera
			local distance = math.max(16, ${luaNum(extent)} * 1.5)
			local target = camera.CFrame.Position + camera.CFrame.LookVector * distance
			local params = RaycastParams.new()
			params.FilterType = Enum.RaycastFilterType.Exclude
			params.FilterDescendantsInstances = { model }
			local hit = workspace:Raycast(target + Vector3.new(0, 500, 0), Vector3.new(0, -2000, 0), params)
			pivotTo(CFrame.new(target.X, if hit then hit.Position.Y else 0, target.Z))
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

function partCall(p: NativePart, mat: number): string {
  const shape = p.className === "WedgePart" ? 4 : p.shape === "Ball" ? 2 : p.shape === "Cylinder" ? 3 : 1;
  const isIdentity = p.rot.every((v, i) => Math.abs(v - [1, 0, 0, 0, 1, 0, 0, 0, 1][i]) < 1e-9);
  const pos = p.pos.map((v) => luaNum(v)).join(", ");
  const cf = isIdentity ? `C(${pos})` : `C(${pos}, ${p.rot.map((v) => luaNum(v, 6)).join(", ")})`;
  const g = p.group ? luaString(p.group) : "nil";
  return `P(${shape}, ${luaString(p.name)}, ${p.size.map((v) => luaNum(v)).join(", ")}, ${cf}, ${p.color.join(", ")}, ${mat}, ${luaNum(p.transparency, 3)}, ${luaNum(p.reflectance, 3)}, ${p.canCollide}, ${p.canTouch}, ${p.castShadow}, ${p.anchored}, ${g})`;
}

// ---------------------------------------------------------------------------
// UI

const color3 = (hex: string) => `Color3.fromRGB(${hexToRgb(hex).join(", ")})`;
const udim2 = (u: number[]) => `UDim2.new(${u.map((v) => luaNum(v)).join(", ")})`;
const X_ALIGN = { left: "Left", center: "Center", right: "Right" } as const;
const Y_ALIGN = { top: "Top", center: "Center", bottom: "Bottom" } as const;
const AUTO = { x: "X", y: "Y", xy: "XY" } as const;

function uiNodeLines(t: UiTreeNode, parentRef: string, out: string[], counter: { n: number }) {
  const n = t.node;
  const r = resolveUiNode(n);
  const ref = `N[${++counter.n}]`;
  const props: string[] = [
    `Name = ${luaString(r.name)}`,
    `Position = ${udim2(r.pos)}`,
    `Size = ${udim2(r.size)}`,
    `AnchorPoint = Vector2.new(${luaNum(r.anchor[0])}, ${luaNum(r.anchor[1])})`,
    `BackgroundColor3 = ${color3(r.bg)}`,
    `BackgroundTransparency = ${luaNum(r.bgT, 3)}`,
    `BorderSizePixel = 0`,
    `ZIndex = ${r.z}`,
    `LayoutOrder = ${r.order}`,
    `Visible = ${r.visible}`,
    `ClipsDescendants = ${r.clip}`,
  ];
  if (r.rotation) props.push(`Rotation = ${luaNum(r.rotation)}`);
  if (r.autoSize) props.push(`AutomaticSize = Enum.AutomaticSize.${AUTO[r.autoSize]}`);
  if (r.isText) {
    props.push(
      `Text = ${luaString(r.text)}`,
      `TextColor3 = ${color3(r.textColor)}`,
      `TextSize = ${luaNum(r.textSize)}`,
      `FontFace = Font.new(${luaString(fontFamilyUrl(r.font))}, Enum.FontWeight.${FONT_WEIGHT_NAMES[FONTS[r.font].weight]}, Enum.FontStyle.${FONTS[r.font].style})`,
      `TextScaled = ${r.textScaled}`,
      `TextWrapped = ${r.textWrapped}`,
      `TextXAlignment = Enum.TextXAlignment.${X_ALIGN[r.xAlign]}`,
      `TextYAlignment = Enum.TextYAlignment.${Y_ALIGN[r.yAlign]}`,
      `TextTransparency = ${luaNum(r.textT, 3)}`,
      `RichText = ${r.rich}`,
    );
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
    props.push(`ImageColor3 = ${color3(n.imageColor ?? "#ffffff")}`);
    props.push(`ImageTransparency = ${luaNum(n.imageT ?? 0, 3)}`);
    props.push(`ScaleType = Enum.ScaleType.${n.scaleType ?? "Stretch"}`);
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
  if (corner) out.push(`\tnew("UICorner", ${ref}, { CornerRadius = UDim.new(${luaNum(corner[0])}, ${luaNum(corner[1])}) })`);
  if (n.stroke) {
    out.push(
      `\tnew("UIStroke", ${ref}, { ApplyStrokeMode = Enum.ApplyStrokeMode.Border, Color = ${color3(n.stroke.color ?? "#000000")}, Thickness = ${luaNum(n.stroke.thickness ?? 1)}, Transparency = ${luaNum(n.stroke.transparency ?? 0, 3)} })`,
    );
  }
  if (n.gradient) {
    const g = n.gradient;
    const stops = gradientStops(g);
    const kps = stops.map((st) => `ColorSequenceKeypoint.new(${luaNum(st.t)}, ${color3(st.color)})`);
    const gp = [`Color = ColorSequence.new({ ${kps.join(", ")} })`, `Rotation = ${luaNum(g.rotation ?? 0)}`];
    if (g.transparency) {
      const tk = stops.map((st) => `NumberSequenceKeypoint.new(${luaNum(st.t)}, ${luaNum(st.transparency, 3)})`);
      gp.push(`Transparency = NumberSequence.new({ ${tk.join(", ")} })`);
    }
    out.push(`\tnew("UIGradient", ${ref}, { ${gp.join(", ")} })`);
  }
  const pad = paddingOf(n);
  if (pad) {
    out.push(
      `\tnew("UIPadding", ${ref}, { PaddingTop = UDim.new(0, ${luaNum(pad[0])}), PaddingRight = UDim.new(0, ${luaNum(pad[1])}), PaddingBottom = UDim.new(0, ${luaNum(pad[2])}), PaddingLeft = UDim.new(0, ${luaNum(pad[3])}) })`,
    );
  }
  if (n.layout) {
    const l = n.layout;
    const h = { left: "Left", center: "Center", right: "Right" }[l.hAlign ?? "left"];
    const v = { top: "Top", center: "Center", bottom: "Bottom" }[l.vAlign ?? "top"];
    if (l.type === "list") {
      const lp = [
        `FillDirection = Enum.FillDirection.${l.dir === "horizontal" ? "Horizontal" : "Vertical"}`,
        `Padding = UDim.new(0, ${luaNum(l.gap ?? 0)})`,
        `HorizontalAlignment = Enum.HorizontalAlignment.${h}`,
        `VerticalAlignment = Enum.VerticalAlignment.${v}`,
        `SortOrder = Enum.SortOrder.LayoutOrder`,
      ];
      if (l.wraps) lp.push(`Wraps = true`);
      out.push(`\tnew("UIListLayout", ${ref}, { ${lp.join(", ")} })`);
    } else {
      const cell = l.cell ?? [0, 100, 0, 100];
      const gap = l.cellGap ?? [5, 5];
      const gp = [
        `CellSize = ${udim2(cell)}`,
        `CellPadding = UDim2.new(0, ${luaNum(gap[0])}, 0, ${luaNum(gap[1])})`,
        `FillDirection = Enum.FillDirection.${l.dir === "vertical" ? "Vertical" : "Horizontal"}`,
        `HorizontalAlignment = Enum.HorizontalAlignment.${h}`,
        `VerticalAlignment = Enum.VerticalAlignment.${v}`,
        `SortOrder = Enum.SortOrder.LayoutOrder`,
      ];
      if (l.maxCells) gp.push(`FillDirectionMaxCells = ${l.maxCells}`);
      out.push(`\tnew("UIGridLayout", ${ref}, { ${gp.join(", ")} })`);
    }
  }
  if (n.aspect) out.push(`\tnew("UIAspectRatioConstraint", ${ref}, { AspectRatio = ${luaNum(n.aspect)} })`);
  for (const c of t.children) uiNodeLines(c, ref, out, counter);
}

export function uiToLuau(spec: UiSpec, opts: ImportOptions = {}): LuauResult {
  const out: string[] = [];
  const counter = { n: 0 };
  const rootRef = spec.autoScale ? "scaleRoot" : "gui";
  for (const root of buildUiTree(spec)) uiNodeLines(root, rootRef, out, counter);
  const autoScale = spec.autoScale
    ? `
	-- Proportional scaling from the design resolution (see AutoScaleController).
	local scaleRoot = new("Frame", gui, { Name = ${luaString(AUTO_SCALE_ROOT)}, AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.new(0.5, 0, 0.5, 0), Size = UDim2.new(1, 0, 1, 0), BackgroundTransparency = 1, BorderSizePixel = 0 })
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
