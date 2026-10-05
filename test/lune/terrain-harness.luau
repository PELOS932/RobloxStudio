-- Runs generated terrain Luau against a recording stand-in for workspace.Terrain (Lune has no
-- voxel engine) and prints what was called.
-- usage: lune run terrain-harness.luau <terrain.luau>
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")

local calls = {}
local function record(name)
	return function(_, ...)
		local args = { ... }
		local entry = { name = name }
		if name == "WriteVoxels" then
			local region, res, mats, occs = args[1], args[2], args[3], args[4]
			local nx, ny, nz = #mats, #mats[1], #mats[1][1]
			local filled, water, maxY = 0, 0, 0
			for i = 1, nx do
				for j = 1, ny do
					for k = 1, nz do
						if mats[i][j][k] ~= roblox.Enum.Material.Air and occs[i][j][k] > 0 then
							filled += 1
							if mats[i][j][k] == roblox.Enum.Material.Water then water += 1 end
							maxY = math.max(maxY, j)
						end
					end
				end
			end
			entry.dims = { nx, ny, nz }
			entry.res = res
			entry.size = { region.Size.X, region.Size.Y, region.Size.Z }
			entry.filled = filled
			entry.water = water
			entry.maxY = maxY
		else
			entry.args = #args
			if typeof(args[#args]) == "EnumItem" then entry.material = args[#args].Name end
		end
		table.insert(calls, entry)
	end
end
local terrain = {}
for _, m in { "FillBlock", "FillBall", "FillCylinder", "FillWedge", "FillRegion", "Clear", "ReplaceMaterial", "WriteVoxels" } do
	terrain[m] = record(m)
end

local Region3 = {}
function Region3.new(min, max)
	local r = { CFrame = roblox.CFrame.new((min + max) / 2), Size = max - min, min = min, max = max }
	function r.ExpandToGrid(self, res)
		local function snap(v, f) return roblox.Vector3.new(f(v.X / res) * res, f(v.Y / res) * res, f(v.Z / res) * res) end
		return Region3.new(snap(self.min, math.floor), snap(self.max, math.ceil))
	end
	return r
end

local env = setmetatable({
	game = { GetService = function() error("no services") end },
	workspace = { Terrain = terrain },
	Vector3 = roblox.Vector3, CFrame = roblox.CFrame, Enum = roblox.Enum, Region3 = Region3, Color3 = roblox.Color3,
}, { __index = getfenv(1) })
local result = luau.load(fs.readFile(process.args[1]), { debugName = "terrain", environment = env })()
print("RESULT " .. serde.encode("json", { text = result }))
print("CALLS " .. serde.encode("json", calls))
