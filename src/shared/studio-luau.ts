// Luau snippets that read state back out of Studio (run through execute_luau).
// They return a JSON string in Studio Forge's own spec formats so selections
// can be edited by Claude and re-imported.

import { luaString } from "./luau.ts";
import { FONTS } from "./roblox-data.ts";

/** Max characters returned per execute_luau call (Studio caps results at ~100k). */
export const PULL_CHUNK = 60_000;

/** Shared buffer for results larger than one execute_luau reply. */
export const PULL_KEY = "__forgePull";

/**
 * Read instances into Studio Forge specs. By default it reads the Studio selection;
 * `target` can be any Luau expression returning a list of instances (after `prelude`).
 */
export function pullSelectionLuau(opts: { target?: string; prelude?: string; key?: string } = {}): string {
  const faces = Object.entries(FONTS).map(([name, f]) => `["${f.family}:${f.weight}:${f.style}"] = "${name}"`).join(", ");
  return String.raw`
local HttpService = game:GetService("HttpService")
local FONT_BY_FACE = { ${faces} }
${opts.prelude ?? ""}
local selection = ${opts.target ?? 'game:GetService("Selection"):Get()'}

local function r(n, d)
	local f = 10 ^ (d or 3)
	local v = math.round(n * f) / f
	if v == 0 then return 0 end
	return v
end
local function hex(c) return "#" .. string.lower(c:ToHex()) end
local function set(t, key, value, default)
	if value ~= default then t[key] = value end
end

local guiClasses = { Frame = true, TextLabel = true, TextButton = true, TextBox = true, ImageLabel = true, ImageButton = true, ScrollingFrame = true }
local function isGuiRoot(inst)
	return inst:IsA("ScreenGui") or guiClasses[inst.ClassName] == true
end

local wantsGui = false
for _, inst in selection do
	if isGuiRoot(inst) then wantsGui = true break end
end

local result
if #selection == 0 then
	result = { kind = "empty" }
elseif wantsGui then
	-- UI ------------------------------------------------------------------
	local nodes, skipped, used = {}, {}, {}
	local screen = nil
	local function uname(base)
		local name, n = base, 2
		while used[name] do name = base .. "_" .. n; n += 1 end
		used[name] = true
		return name
	end
	local function udim2(u) return { r(u.X.Scale, 4), u.X.Offset, r(u.Y.Scale, 4), u.Y.Offset } end
	local alignX = { [Enum.TextXAlignment.Left] = "left", [Enum.TextXAlignment.Right] = "right" }
	local alignY = { [Enum.TextYAlignment.Top] = "top", [Enum.TextYAlignment.Bottom] = "bottom" }
	local hAlign = { [Enum.HorizontalAlignment.Center] = "center", [Enum.HorizontalAlignment.Right] = "right" }
	local vAlign = { [Enum.VerticalAlignment.Center] = "center", [Enum.VerticalAlignment.Bottom] = "bottom" }
	local autoSize = { [Enum.AutomaticSize.X] = "x", [Enum.AutomaticSize.Y] = "y", [Enum.AutomaticSize.XY] = "xy" }

	local function walk(obj, parentName)
		if not guiClasses[obj.ClassName] then
			if obj:IsA("GuiObject") then table.insert(skipped, obj:GetFullName()) end
			return
		end
		local n = { name = uname(obj.Name), type = obj.ClassName }
		if parentName then n.parent = parentName end
		local isText = obj:IsA("TextLabel") or obj:IsA("TextButton") or obj:IsA("TextBox")
		local isImage = obj:IsA("ImageLabel") or obj:IsA("ImageButton")
		local defaultBgT = if obj:IsA("TextLabel") or isImage then 1 else 0
		local pos, size = udim2(obj.Position), udim2(obj.Size)
		if pos[1] ~= 0 or pos[2] ~= 0 or pos[3] ~= 0 or pos[4] ~= 0 then n.pos = pos end
		n.size = size
		if obj.AnchorPoint.X ~= 0 or obj.AnchorPoint.Y ~= 0 then n.anchor = { r(obj.AnchorPoint.X), r(obj.AnchorPoint.Y) } end
		set(n, "bg", hex(obj.BackgroundColor3), "#ffffff")
		set(n, "bgT", r(obj.BackgroundTransparency), defaultBgT)
		set(n, "rotation", r(obj.Rotation), 0)
		set(n, "z", obj.ZIndex, 1)
		set(n, "order", obj.LayoutOrder, 0)
		set(n, "visible", obj.Visible, true)
		set(n, "clip", obj.ClipsDescendants, obj:IsA("ScrollingFrame"))
		set(n, "autoSize", autoSize[obj.AutomaticSize], nil)
		if isText then
			n.text = obj.Text
			set(n, "textColor", hex(obj.TextColor3), "#ffffff")
			set(n, "textSize", obj.TextSize, 18)
			-- Font is the legacy enum; FontFace covers fonts it can't express.
			local okFont, fontName = pcall(function() return obj.Font.Name end)
			if not okFont or not fontName then fontName = "Unknown" end
			if fontName == "Unknown" then
				pcall(function()
					local face = obj.FontFace
					local family = string.match(face.Family, "families/([%w]+)%.json")
					fontName = FONT_BY_FACE[(family or "") .. ":" .. face.Weight.Value .. ":" .. face.Style.Name] or "Unknown"
				end)
			end
			if fontName ~= "Unknown" then set(n, "font", fontName, "GothamMedium") end
			set(n, "textScaled", obj.TextScaled, false)
			set(n, "textWrapped", obj.TextWrapped, false)
			set(n, "xAlign", alignX[obj.TextXAlignment], nil)
			set(n, "yAlign", alignY[obj.TextYAlignment], nil)
			set(n, "textT", r(obj.TextTransparency), 0)
			set(n, "rich", obj.RichText, false)
			if obj.TextStrokeTransparency < 1 then
				n.textStroke = { color = hex(obj.TextStrokeColor3), transparency = r(obj.TextStrokeTransparency) }
			end
			if obj:IsA("TextBox") then
				if obj.PlaceholderText ~= "" then n.placeholder = obj.PlaceholderText end
				n.placeholderColor = hex(obj.PlaceholderColor3)
			end
		end
		if isImage then
			n.image = obj.Image
			set(n, "imageColor", hex(obj.ImageColor3), "#ffffff")
			set(n, "imageT", r(obj.ImageTransparency), 0)
			set(n, "scaleType", obj.ScaleType.Name, "Stretch")
			if obj.ScaleType == Enum.ScaleType.Slice then
				local sc = obj.SliceCenter
				n.slice = { sc.Min.X, sc.Min.Y, sc.Max.X, sc.Max.Y }
			end
		end
		if obj:IsA("ScrollingFrame") then
			n.canvas = udim2(obj.CanvasSize)
			set(n, "autoCanvas", autoSize[obj.AutomaticCanvasSize], nil)
			set(n, "scrollBar", obj.ScrollBarThickness, 6)
			set(n, "scrollColor", hex(obj.ScrollBarImageColor3), "#ffffff")
		end
		for _, child in obj:GetChildren() do
			-- One unreadable decorator should not lose the whole UI.
			pcall(function()
				if child:IsA("UICorner") then
					n.corner = if child.CornerRadius.Scale == 0 then child.CornerRadius.Offset else { r(child.CornerRadius.Scale), child.CornerRadius.Offset }
				elseif child:IsA("UIStroke") and child.ApplyStrokeMode == Enum.ApplyStrokeMode.Border then
					n.stroke = { color = hex(child.Color), thickness = r(child.Thickness), transparency = r(child.Transparency) }
				elseif child:IsA("UIGradient") then
					local colors, transparency = {}, {}
					for _, kp in child.Color.Keypoints do table.insert(colors, hex(kp.Value)) end
					for _, kp in child.Transparency.Keypoints do table.insert(transparency, r(kp.Value)) end
					n.gradient = { colors = colors, rotation = r(child.Rotation) }
					if #transparency >= 2 and (transparency[1] ~= 0 or transparency[#transparency] ~= 0) then n.gradient.transparency = transparency end
				elseif child:IsA("UIPadding") then
					n.padding = { child.PaddingTop.Offset, child.PaddingRight.Offset, child.PaddingBottom.Offset, child.PaddingLeft.Offset }
				elseif child:IsA("UIListLayout") then
					n.layout = {
						type = "list",
						dir = if child.FillDirection == Enum.FillDirection.Horizontal then "horizontal" else "vertical",
						gap = child.Padding.Offset,
						hAlign = hAlign[child.HorizontalAlignment] or "left",
						vAlign = vAlign[child.VerticalAlignment] or "top",
						wraps = child.Wraps or nil,
					}
				elseif child:IsA("UIGridLayout") then
					n.layout = {
						type = "grid",
						cell = udim2(child.CellSize),
						cellGap = { child.CellPadding.X.Offset, child.CellPadding.Y.Offset },
						hAlign = hAlign[child.HorizontalAlignment] or "left",
						vAlign = vAlign[child.VerticalAlignment] or "top",
						maxCells = if child.FillDirectionMaxCells > 0 then child.FillDirectionMaxCells else nil,
					}
				elseif child:IsA("UIAspectRatioConstraint") then
					n.aspect = r(child.AspectRatio, 4)
				end
			end)
		end
		table.insert(nodes, n)
		for _, child in obj:GetChildren() do walk(child, n.name) end
	end

	for _, inst in selection do
		if inst:IsA("ScreenGui") then
			screen = screen or inst
			for _, child in inst:GetChildren() do walk(child, nil) end
		elseif guiClasses[inst.ClassName] then
			walk(inst, nil)
		end
	end
	local spec = { name = if screen then screen.Name else selection[1].Name, nodes = nodes }
	if screen then
		-- IgnoreGuiInset is the legacy form of ScreenInsets.
		local okInset, inset = pcall(function() return screen.IgnoreGuiInset end)
		if not okInset then
			okInset, inset = pcall(function() return screen.ScreenInsets ~= Enum.ScreenInsets.CoreUISafeInsets end)
		end
		spec.ignoreInset = okInset and inset == true
		pcall(function() spec.resetOnSpawn = screen.ResetOnSpawn end)
		pcall(function() spec.displayOrder = screen.DisplayOrder end)
	end
	result = { kind = "ui", spec = spec, skipped = skipped }
else
	-- Models ----------------------------------------------------------------
	local parts, skipped = {}, {}
	local rootModel = if #selection == 1 and selection[1]:IsA("Model") then selection[1] else nil
	local seen = {}
	local function collect(inst)
		if seen[inst] then return end
		seen[inst] = true
		if inst:IsA("BasePart") then
			local supported = inst.ClassName == "WedgePart" or (inst.ClassName == "Part" and inst.Shape ~= Enum.PartType.CornerWedge and inst.Shape ~= Enum.PartType.Wedge)
			if supported then table.insert(parts, inst) else table.insert(skipped, inst:GetFullName() .. " (" .. inst.ClassName .. ")") end
		end
		for _, child in inst:GetChildren() do collect(child) end
	end
	for _, inst in selection do collect(inst) end

	local minV, maxV = Vector3.new(math.huge, math.huge, math.huge), Vector3.new(-math.huge, -math.huge, -math.huge)
	for _, p in parts do
		local cf, s = p.CFrame, p.Size / 2
		local ext = Vector3.new(
			math.abs(cf.RightVector.X) * s.X + math.abs(cf.UpVector.X) * s.Y + math.abs(cf.LookVector.X) * s.Z,
			math.abs(cf.RightVector.Y) * s.X + math.abs(cf.UpVector.Y) * s.Y + math.abs(cf.LookVector.Y) * s.Z,
			math.abs(cf.RightVector.Z) * s.X + math.abs(cf.UpVector.Z) * s.Y + math.abs(cf.LookVector.Z) * s.Z
		)
		minV = minV:Min(cf.Position - ext)
		maxV = maxV:Max(cf.Position + ext)
	end
	local pivot = if #parts > 0 then Vector3.new((minV.X + maxV.X) / 2, minV.Y, (minV.Z + maxV.Z) / 2) else Vector3.zero

	local out, used = {}, {}
	for _, p in parts do
		local base, name, k = p.Name, p.Name, 2
		while used[name] do name = base .. "_" .. k; k += 1 end
		used[name] = true
		local rel = p.CFrame.Position - pivot
		local rx, ry, rz = p.CFrame:ToEulerAnglesXYZ()
		local e = { name = name, size = { r(p.Size.X), r(p.Size.Y), r(p.Size.Z) }, pos = { r(rel.X), r(rel.Y), r(rel.Z) } }
		if p.ClassName == "WedgePart" then e.shape = "wedge"
		elseif p.Shape == Enum.PartType.Ball then e.shape = "ball"
		elseif p.Shape == Enum.PartType.Cylinder then e.shape = "cylinder" end
		local rot = { r(math.deg(rx), 2), r(math.deg(ry), 2), r(math.deg(rz), 2) }
		if rot[1] ~= 0 or rot[2] ~= 0 or rot[3] ~= 0 then e.rot = rot end
		e.color = hex(p.Color)
		set(e, "material", p.Material.Name, "Plastic")
		set(e, "transparency", r(p.Transparency), 0)
		set(e, "reflectance", r(p.Reflectance), 0)
		set(e, "collide", p.CanCollide, true)
		-- Group path = Model ancestors below the selected root.
		local path, a = {}, p.Parent
		while a and a ~= rootModel and a ~= workspace and a ~= game and a:IsA("Model") do
			table.insert(path, 1, a.Name)
			a = a.Parent
		end
		if #path > 0 then e.group = table.concat(path, "/") end
		local light = p:FindFirstChildWhichIsA("Light")
		if light and (light:IsA("PointLight") or light:IsA("SpotLight") or light:IsA("SurfaceLight")) then
			e.light = {
				type = if light:IsA("SpotLight") then "spot" elseif light:IsA("SurfaceLight") then "surface" else "point",
				color = hex(light.Color), brightness = r(light.Brightness), range = r(light.Range), shadows = light.Shadows,
			}
			if not light:IsA("PointLight") then
				e.light.angle = r(light.Angle)
				e.light.face = light.Face.Name
			end
		end
		table.insert(out, e)
	end
	local name = if rootModel then rootModel.Name elseif #selection == 1 then selection[1].Name else "Selection"
	result = { kind = if #out > 0 then "model" else "empty", spec = { name = name, parts = out }, skipped = skipped }
end

${jsonReturnLuau("result", opts.key ?? PULL_KEY)}
`;
}

export function pullChunkLuau(start: number, key = PULL_KEY): string {
  return `local json = shared[${luaString(key)}]
if not json then return ${luaString('{"error":"pull buffer missing"}')} end
if ${start + PULL_CHUNK} >= #json then shared[${luaString(key)}] = nil end
return game:GetService("HttpService"):JSONEncode({ total = #json, chunk = string.sub(json, ${start + 1}, ${start + PULL_CHUNK}) })`;
}

/**
 * Luau tail that returns the JSON of a local value in chunks: the first chunk now, the rest
 * through pullChunkLuau. Non-ASCII is escaped so a chunk boundary never splits a UTF-8 sequence.
 */
export function jsonReturnLuau(value: string, key = PULL_KEY): string {
  return String.raw`
local function asciiJson(s)
	return (string.gsub(s, "[\128-\255]+", function(seq)
		local out = {}
		local ok = pcall(function()
			for _, cp in utf8.codes(seq) do
				if cp >= 0x10000 then
					cp -= 0x10000
					table.insert(out, string.format("\\u%04x\\u%04x", 0xD800 + bit32.rshift(cp, 10), 0xDC00 + bit32.band(cp, 0x3FF)))
				else
					table.insert(out, string.format("\\u%04x", cp))
				end
			end
		end)
		return if ok then table.concat(out) else "?"
	end))
end

local json = asciiJson(game:GetService("HttpService"):JSONEncode(${value}))
shared[${luaString(key)}] = json
return game:GetService("HttpService"):JSONEncode({ total = #json, chunk = string.sub(json, 1, ${PULL_CHUNK}) })
`;
}
