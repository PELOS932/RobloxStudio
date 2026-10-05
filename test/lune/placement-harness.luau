-- Runs generated import Luau with a fake Studio camera and raycasts against a flat floor.
-- usage: lune run placement-harness.luau <import.luau> <camX,camY,camZ> <lookX,lookY,lookZ> <floorY>
-- Prints "PIVOT x y z lookX lookY lookZ" for the imported model.
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")

local function vec(s)
	local x, y, z = string.match(s, "([^,]+),([^,]+),([^,]+)")
	return roblox.Vector3.new(tonumber(x), tonumber(y), tonumber(z))
end
local camPos, lookAt, floorY = vec(process.args[2]), vec(process.args[3]), tonumber(process.args[4])

local game = roblox.Instance.new("DataModel")
local realWorkspace = game:GetService("Workspace")
-- The import only reads the camera's Position and LookVector. (Lune's CFrame.lookAt faces away
-- from its target, unlike Roblox, so the direction is given directly.)
local camera = { CFrame = { Position = camPos, LookVector = (lookAt - camPos).Unit } }

-- Raycast against the plane y = floorY (normal up), like a baseplate.
local function raycast(_, origin, direction)
	if direction.Y >= 0 then return nil end
	local t = (floorY - origin.Y) / direction.Y
	if t < 0 or t > 1 then return nil end
	local hit = origin + direction * t
	return { Position = hit, Normal = roblox.Vector3.new(0, 1, 0), Distance = (hit - origin).Magnitude }
end

local workspace = setmetatable({}, {
	__index = function(_, key)
		if key == "CurrentCamera" then return camera end
		if key == "Raycast" then return raycast end
		local value = (realWorkspace :: any)[key]
		if type(value) == "function" then
			return function(_, ...) return value(realWorkspace, ...) end
		end
		return value
	end,
})

local env = setmetatable({
	game = game,
	workspace = workspace,
	Instance = roblox.Instance,
	Vector3 = roblox.Vector3,
	CFrame = roblox.CFrame,
	Color3 = roblox.Color3,
	RaycastParams = { new = function() return {} end },
	Enum = setmetatable({ RaycastFilterType = { Exclude = "Exclude" } }, { __index = roblox.Enum }),
}, { __index = getfenv(1) })
luau.load(fs.readFile(process.args[1]), { debugName = "import", environment = env })()

local model = realWorkspace:GetChildren()[1]
local pivot = model.WorldPivot
local look = pivot.LookVector
print(string.format("PIVOT %.3f %.3f %.3f %.3f %.3f %.3f", pivot.X, pivot.Y, pivot.Z, look.X, look.Y, look.Z))
