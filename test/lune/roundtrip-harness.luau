-- Round trip on Lune's Roblox instance model: run the generated import Luau, read every part
-- back as Roblox sees it, then select the model and run the generated pull code on it.
-- usage: lune run roundtrip-harness.luau <import.luau> <pull.luau> <spec.json>
-- Prints "EXPECT <json>" (each spec part's frame from Roblox's own CFrame.Angles),
-- "PARTS <json>" (what Studio would have) and "PULL <json>" (the spec read back).
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")

local game = roblox.Instance.new("DataModel")
local workspace = game:GetService("Workspace")

local env = setmetatable({
	game = game,
	workspace = workspace,
	Instance = roblox.Instance,
	Vector3 = roblox.Vector3,
	CFrame = roblox.CFrame,
	Color3 = roblox.Color3,
	Enum = roblox.Enum,
}, { __index = getfenv(1) })
local result = luau.load(fs.readFile(process.args[1]), { debugName = "import", environment = env })()
local model = workspace:GetChildren()[1]
assert(model and model:IsA("Model"), "import did not create a model: " .. tostring(result))

local function v3(v)
	return { v.X, v.Y, v.Z }
end
local function rgb(c)
	return { math.round(c.R * 255), math.round(c.G * 255), math.round(c.B * 255) }
end

local parts = {}
for _, d in model:GetDescendants() do
	if d:IsA("BasePart") then
		local path, a = {}, d.Parent
		while a and a ~= model do
			table.insert(path, 1, a.Name)
			a = a.Parent
		end
		local e = {
			name = d.Name,
			class = d.ClassName,
			shape = if d.ClassName == "Part" then d.Shape.Name else nil,
			size = v3(d.Size),
			pos = v3(d.CFrame.Position),
			right = v3(d.CFrame.RightVector),
			up = v3(d.CFrame.UpVector),
			back = v3(-d.CFrame.LookVector),
			color = rgb(d.Color),
			material = d.Material.Name,
			transparency = d.Transparency,
			reflectance = d.Reflectance,
			anchored = d.Anchored,
			canCollide = d.CanCollide,
			canTouch = d.CanTouch,
			castShadow = d.CastShadow,
			group = table.concat(path, "/"),
		}
		local light = d:FindFirstChildWhichIsA("Light")
		if light then
			e.light = {
				class = light.ClassName,
				color = rgb(light.Color),
				brightness = light.Brightness,
				range = light.Range,
				shadows = light.Shadows,
				angle = if light:IsA("PointLight") then nil else light.Angle,
				face = if light:IsA("PointLight") then nil else light.Face.Name,
			}
		end
		table.insert(parts, e)
	end
end
print("PARTS " .. serde.encode("json", parts))

local expect = {}
for _, p in serde.decode("json", fs.readFile(process.args[3])).parts do
	local r = p.rot or { 0, 0, 0 }
	local cf = roblox.CFrame.new(p.pos[1], p.pos[2], p.pos[3]) * roblox.CFrame.Angles(math.rad(r[1]), math.rad(r[2]), math.rad(r[3]))
	expect[p.name] = { pos = v3(cf.Position), x = v3(cf.XVector), y = v3(cf.YVector), z = v3(cf.ZVector) }
end
print("EXPECT " .. serde.encode("json", expect))

-- Pull it back exactly like Studio Forge does from a Studio selection.
local shared = {}
local fakeGame = setmetatable({}, {
	__index = function(_, key)
		if key == "GetService" then
			return function(_, name)
				if name == "Selection" then
					return { Get = function() return { model } end }
				elseif name == "HttpService" then
					return { JSONEncode = function(_, v) return serde.encode("json", v) end }
				end
				return game:GetService(name)
			end
		end
		return (game :: any)[key]
	end,
})
local pullEnv = setmetatable({ game = fakeGame, workspace = workspace, shared = shared, Enum = roblox.Enum, Vector3 = roblox.Vector3, CFrame = roblox.CFrame }, { __index = getfenv(1) })
luau.load(fs.readFile(process.args[2]), { debugName = "pull", environment = pullEnv })()
print("PULL " .. shared.__forgePull)
