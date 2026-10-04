-- Test harness: executes generated Luau (or loads an .rbxmx) against Lune's
-- Roblox instance model and prints a canonical, order-independent dump.
-- usage: lune run harness.luau <luau|rbxmx> <file> <ParentService>
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")

local mode, file, parentName = process.args[1], process.args[2], process.args[3]
local source = fs.readFile(file)

local game = roblox.Instance.new("DataModel")
local workspace = game:GetService("Workspace")
for _, name in { "StarterGui", "ServerScriptService", "ReplicatedStorage", "ServerStorage" } do
	game:GetService(name)
end
local parent = game:GetService(parentName)

if mode == "luau" then
	local env = {
		game = game,
		workspace = workspace,
		Instance = roblox.Instance,
		Vector3 = roblox.Vector3,
		Vector2 = roblox.Vector2,
		CFrame = roblox.CFrame,
		Color3 = roblox.Color3,
		UDim = roblox.UDim,
		UDim2 = roblox.UDim2,
		Rect = roblox.Rect,
		Enum = roblox.Enum,
		ColorSequence = roblox.ColorSequence,
		ColorSequenceKeypoint = roblox.ColorSequenceKeypoint,
		NumberSequence = roblox.NumberSequence,
		NumberSequenceKeypoint = roblox.NumberSequenceKeypoint,
	}
	setmetatable(env, { __index = getfenv(1) })
	local chunk = luau.load(source, { debugName = "generated", environment = env })
	local result = chunk()
	print("RESULT " .. tostring(result))
else
	local instances = roblox.deserializeModel(source)
	for _, inst in instances do
		inst.Parent = parent
	end
	print("RESULT {}")
end

local lines = {}
local function canon(inst, path)
	local copy = inst:Clone()
	for _, child in copy:GetChildren() do
		child.Parent = nil
	end
	-- Round-trip once so legacy aliases (Image, Font, CornerRadius) settle into their modern names.
	local xml = roblox.serializeModel(roblox.deserializeModel(roblox.serializeModel({ copy }, true)), true)
	xml = string.gsub(xml, 'referent="[^"]*"', "")
	xml = string.gsub(xml, '<BinaryString name="AttributesSerialize">[^<]*</BinaryString>', "")
	local attrs = {}
	for key, value in inst:GetAttributes() do
		table.insert(attrs, key .. "=" .. tostring(value))
	end
	table.sort(attrs)
	if #attrs > 0 then
		xml ..= " attrs[" .. table.concat(attrs, ",") .. "]"
	end
	xml = string.gsub(xml, "%s+", " ")
	-- Lune keeps Luau-set pivots under the WorldPivot alias; Studio files use WorldPivotData.
	xml = string.gsub(xml, '<CoordinateFrame name="WorldPivot">(.-)</CoordinateFrame>', '<OptionalCoordinateFrame name="WorldPivotData"> <CFrame>%1</CFrame> </OptionalCoordinateFrame>')
	-- Lune quantizes floats slightly on property assignment; compare at 4 decimals.
	xml = string.gsub(xml, "%-?%d+%.%d+", function(n)
		local rounded = string.format("%.4f", tonumber(n) :: number)
		rounded = string.gsub(rounded, "%.?0+$", "")
		return if rounded == "-0" then "0" else rounded
	end)
	table.insert(lines, path .. " " .. xml)
	local kids = inst:GetChildren()
	table.sort(kids, function(a, b)
		return a.ClassName .. ":" .. a.Name < b.ClassName .. ":" .. b.Name
	end)
	for _, child in kids do
		canon(child, path .. "/" .. child.ClassName .. ":" .. child.Name)
	end
end
for _, child in parent:GetChildren() do
	canon(child, child.ClassName .. ":" .. child.Name)
end
print("DUMP")
print(table.concat(lines, "\n"))
