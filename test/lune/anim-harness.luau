-- Imports an animation with the generated Luau, then poses the dummy for one keyframe the way
-- Roblox does: Part1 = Part0 * C0 * Pose.CFrame * C1:Inverse(), walking the Motor6Ds from the root.
-- usage: lune run anim-harness.luau <import.luau> <keyframe index (1-based, by time)>
-- Prints "PARTS <json>" (name → x, y, z, r00..r22) and "SEQ <json>" (structure summary).
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")

local game = roblox.Instance.new("DataModel")
local workspace = game:GetService("Workspace")
game:GetService("ServerStorage")
local env = setmetatable({
	game = game, workspace = workspace, Instance = roblox.Instance, Vector3 = roblox.Vector3, CFrame = roblox.CFrame,
	Color3 = roblox.Color3, Enum = roblox.Enum,
}, { __index = getfenv(1) })
local result = luau.load(fs.readFile(process.args[1]), { debugName = "import", environment = env })()
assert(string.find(result, '"ok":true'), result)

local dummy = workspace:FindFirstChildOfClass("Model")
local saves = game:GetService("ServerStorage"):FindFirstChild("RBX_ANIMSAVES")
local slot = saves:FindFirstChild(dummy.Name)
local seq = slot:FindFirstChildOfClass("KeyframeSequence")
local keyframes = seq:GetChildren()
table.sort(keyframes, function(a, b) return a.Time < b.Time end)
local keyframe = keyframes[tonumber(process.args[2])]

local poses, weights = {}, {}
for _, p in keyframe:GetDescendants() do
	if p:IsA("Pose") then
		weights[p.Name] = p.Weight
		if p.Weight > 0 then poses[p.Name] = p.CFrame end
	end
end

local world = { HumanoidRootPart = dummy.HumanoidRootPart.CFrame }
local motors = {}
for _, d in dummy:GetDescendants() do
	if d:IsA("Motor6D") then table.insert(motors, d) end
end
local done = 0
while done < #motors do
	local progressed = false
	for _, m in motors do
		local p0, p1 = m.Part0.Name, m.Part1.Name
		if world[p0] and not world[p1] then
			world[p1] = world[p0] * m.C0 * (poses[p1] or roblox.CFrame.new()) * m.C1:Inverse()
			done += 1
			progressed = true
		end
	end
	assert(progressed, "motor chain is broken")
end

local out = {}
for name, cf in world do
	local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = cf:GetComponents()
	out[name] = { x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 }
end
print("PARTS " .. serde.encode("json", out))
print("SEQ " .. serde.encode("json", {
	name = seq.Name, loop = seq.Loop, priority = seq.Priority.Name, keyframes = #keyframes, time = keyframe.Time,
	weights = weights, humanoid = dummy:FindFirstChildOfClass("Humanoid").RigType.Name, motors = #motors,
	style = (function() for _, p in keyframe:GetDescendants() do if p:IsA("Pose") and p.Weight > 0 then return p.EasingStyle.Name end end end)(),
	dir = (function() for _, p in keyframe:GetDescendants() do if p:IsA("Pose") and p.Weight > 0 then return p.EasingDirection.Name end end end)(),
}))
