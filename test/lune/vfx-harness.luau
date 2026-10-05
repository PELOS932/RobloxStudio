-- Imports a visual effect with the generated Luau and loads the exported .rbxmx, then prints the
-- same structure summary for both so the test can check they build identical instances.
-- usage: lune run vfx-harness.luau <import.luau> <effect.rbxmx>
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")

local game = roblox.Instance.new("DataModel")
local workspace = game:GetService("Workspace")
local env = setmetatable({
	game = game, workspace = workspace, Instance = roblox.Instance, Vector3 = roblox.Vector3, Vector2 = roblox.Vector2,
	CFrame = roblox.CFrame, Color3 = roblox.Color3, Enum = roblox.Enum, UDim = roblox.UDim, UDim2 = roblox.UDim2,
	NumberSequence = roblox.NumberSequence, NumberSequenceKeypoint = roblox.NumberSequenceKeypoint,
	ColorSequence = roblox.ColorSequence, ColorSequenceKeypoint = roblox.ColorSequenceKeypoint, NumberRange = roblox.NumberRange,
}, { __index = getfenv(1) })
local result = luau.load(fs.readFile(process.args[1]), { debugName = "import", environment = env })()
assert(string.find(result, '"ok":true'), result)
local imported = workspace:FindFirstChildOfClass("Model")
local exported = roblox.deserializeModel(fs.readFile(process.args[2]))[1]

local PROPS = {
	ParticleEmitter = { "Texture", "Color", "Size", "Transparency", "Lifetime", "Rate", "Speed", "SpreadAngle", "EmissionDirection", "Acceleration", "Drag", "Rotation", "RotSpeed", "LightEmission", "LightInfluence", "Brightness", "Squash", "ZOffset", "Orientation", "LockedToPart", "Shape", "ShapeStyle", "ShapeInOut", "FlipbookLayout", "FlipbookMode", "FlipbookFramerate", "TimeScale", "Enabled" },
	Beam = { "Attachment0", "Attachment1", "Color", "Transparency", "Width0", "Width1", "CurveSize0", "CurveSize1", "Segments", "Texture", "TextureLength", "TextureSpeed", "TextureMode", "FaceCamera", "LightEmission", "Brightness", "Enabled" },
	Trail = { "Attachment0", "Attachment1", "Color", "Transparency", "Lifetime", "WidthScale", "MinLength", "FaceCamera", "LightEmission", "Brightness", "Texture", "Enabled" },
	Attachment = { "CFrame" },
	Part = { "Size", "CFrame", "Anchored", "CanCollide", "CanTouch", "Transparency" },
	PointLight = { "Color", "Brightness", "Range", "Shadows", "Enabled" },
	SpotLight = { "Color", "Brightness", "Range", "Angle", "Face", "Shadows", "Enabled" },
	Fire = { "Color", "SecondaryColor", "Heat", "Size", "Enabled" },
	Smoke = { "Color", "Opacity", "RiseVelocity", "Size", "Enabled" },
	Sparkles = { "SparkleColor", "Enabled" },
	ModuleScript = { "Source" },
	Model = { "PrimaryPart" },
}

local function r(n) return math.round(n * 1000) / 1000 end
local function value(v)
	local t = typeof(v)
	if t == "number" then return r(v)
	elseif t == "Vector3" then return { r(v.X), r(v.Y), r(v.Z) }
	elseif t == "Vector2" then return { r(v.X), r(v.Y) }
	elseif t == "Color3" then return { r(v.R), r(v.G), r(v.B) }
	elseif t == "EnumItem" then return v.Name
	elseif t == "Instance" then return "@" .. v.Name
	elseif t == "NumberRange" then return { r(v.Min), r(v.Max) }
	elseif t == "CFrame" then
		local c = { v:GetComponents() }
		for i, x in c do c[i] = r(x) end
		return c
	elseif t == "NumberSequence" then
		local out = {}
		for _, k in v.Keypoints do table.insert(out, { r(k.Time), r(k.Value), r(k.Envelope) }) end
		return out
	elseif t == "ColorSequence" then
		local out = {}
		for _, k in v.Keypoints do table.insert(out, { r(k.Time), r(k.Value.R), r(k.Value.G), r(k.Value.B) }) end
		return out
	elseif t == "Content" then
		return tostring(v.Uri or v)
	end
	return v
end

local function describe(root)
	local out = {}
	local list = root:GetDescendants()
	table.insert(list, 1, root)
	for _, inst in list do
		local path = if inst == root then "." else string.sub(inst:GetFullName(), #root:GetFullName() + 2)
		local entry = { class = inst.ClassName, props = {}, attrs = {} }
		for _, p in PROPS[inst.ClassName] or {} do
			local ok, v = pcall(function() return inst[p] end)
			if not ok and p == "Texture" then
				-- Lune loads .rbxmx textures into the newer TextureContent property.
				ok, v = pcall(function() return string.match(tostring(inst.TextureContent), "Uri=([^%)]*)") end)
			end
			entry.props[p] = if ok then value(v) else "?"
		end
		for k, v in inst:GetAttributes() do
			if string.sub(k, 1, 5) ~= "Forge" then entry.attrs[k] = value(v) end
		end
		out[path] = entry
	end
	return out
end

print("IMPORTED " .. serde.encode("json", describe(imported)))
print("EXPORTED " .. serde.encode("json", describe(exported)))
