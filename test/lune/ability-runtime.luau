-- Runs an imported ability's Play module on a dummy character with a simulated clock (task.delay,
-- Heartbeat, Debris and raycasts against a ground plane at y = 0) and reports what happened:
-- which effects appeared when and where, how far projectiles flew, what burst, when things were
-- cleaned up, and any script errors.
-- usage: lune run ability-runtime.luau <import.luau> <rig.json> <seconds>
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local Vector3, CFrame, Instance, Enum = roblox.Vector3, roblox.CFrame, roblox.Instance, roblox.Enum

local game = Instance.new("DataModel")
local workspace = game:GetService("Workspace")
game:GetService("ReplicatedStorage")
game:GetService("StarterPack")
local importEnv = setmetatable({ game = game, workspace = workspace }, { __index = getfenv(1) })
for name, value in roblox do
	if string.match(name, "^%u") then importEnv[name] = value end
end
local imported = luau.load(fs.readFile(process.args[1]), { debugName = "import", environment = importEnv })()
assert(string.find(imported, '"ok":true'), imported)
local folder = game:GetService("ReplicatedStorage").Abilities:GetChildren()[1]

-- The dummy, standing at the origin facing -Z.
local rig = serde.decode("json", fs.readFile(process.args[2]))
local character = Instance.new("Model")
character.Name = "Dummy"
for _, p in rig.parts do
	local part = Instance.new("Part")
	part.Name = p.name
	part.Size = Vector3.new(p.size[1], p.size[2], p.size[3])
	part.CFrame = CFrame.new(p.center[1], p.center[2], p.center[3])
	part.Anchored = true
	part.Parent = character
end
local humanoid = Instance.new("Humanoid")
humanoid.RigType = Enum.HumanoidRigType[rig.type]
humanoid.HipHeight = rig.hipHeight
humanoid.Parent = character
character.Parent = workspace

-- Simulated time.
local now = 0
local tasks = {}
local heartbeat = {}
local errors = {}
local emits = {}
local registered = 0
local function schedule(t, fn, ...)
	table.insert(tasks, { at = now + (t or 0), fn = fn, args = table.pack(...) })
end
local function pivotOf(model)
	if model:IsA("BasePart") then return model.CFrame end
	-- (Lune's Clone doesn't remap PrimaryPart to the copy, so look the root up by name.)
	local root = model:FindFirstChild("Root") or model:FindFirstChild("HumanoidRootPart") or model.PrimaryPart
	return if root then root.CFrame else CFrame.new()
end
local fakeGame = {
	GetService = function(_, name)
		if name == "RunService" then
			return { Heartbeat = { Connect = function(_, fn)
				local c = { fn = fn, connected = true }
				table.insert(heartbeat, c)
				return { Disconnect = function() c.connected = false end }
			end } }
		elseif name == "Debris" then
			return { AddItem = function(_, inst, t) schedule(t, function() inst.Parent = nil end) end }
		elseif name == "HttpService" then
			return { JSONDecode = function(_, text) return serde.decode("json", text) end }
		elseif name == "KeyframeSequenceProvider" then
			return { RegisterKeyframeSequence = function() registered += 1; return "rbxassetid://1" end }
		end
		return game:GetService(name)
	end,
}
local env = setmetatable({
	game = fakeGame,
	workspace = workspace,
	script = { Parent = folder },
	os = { clock = function() return now end },
	task = { delay = schedule, wait = function() end },
	RaycastParams = { new = function() return {} end },
	__pivotTo = function(model, cf)
		local delta = cf * pivotOf(model):Inverse()
		for _, d in model:GetDescendants() do
			if d:IsA("BasePart") then d.CFrame = delta * d.CFrame end
		end
	end,
	__getPivot = pivotOf,
	__emit = function(e, n) emits[e.Name] = (emits[e.Name] or 0) + n end,
	-- A ground plane at y = 0.
	__raycast = function(origin, dir)
		if origin.Y >= 0 and origin.Y + dir.Y < 0 then
			local t = origin.Y / -dir.Y
			return { Position = origin + dir * t, Normal = Vector3.new(0, 1, 0) }
		end
		return nil
	end,
}, { __index = getfenv(1) })
for name, value in roblox do
	if string.match(name, "^%u") then env[name] = value end
end
env.game, env.workspace = fakeGame, workspace

local source = folder.Play.Source
source = string.gsub(source, "(%w+):PivotTo%(", "__pivotTo(%1, ")
source = string.gsub(source, "(%w+):GetPivot%(%)", "__getPivot(%1)")
source = string.gsub(source, "workspace:Raycast%(", "__raycast(")
source = string.gsub(source, "(%w+):Emit%(", "__emit(%1, ")
local cast = luau.load(source, { debugName = "Play", environment = env })()
local ok, err = pcall(cast, character)
if not ok then table.insert(errors, "cast: " .. tostring(err)) end

local seen = {}
local order = {}
local function r(n) return math.round(n * 100) / 100 end
local seconds = tonumber(process.args[3])
local dt = 1 / 60
while now < seconds do
	now += dt
	local due = {}
	for i = #tasks, 1, -1 do
		if tasks[i].at <= now + 1e-9 then table.insert(due, table.remove(tasks, i)) end
	end
	table.sort(due, function(a, b) return a.at < b.at end)
	for _, t in due do
		local okTask, e = pcall(t.fn, table.unpack(t.args, 1, t.args.n))
		if not okTask then table.insert(errors, string.format("%.2f task: %s", now, tostring(e))) end
	end
	for _, c in heartbeat do
		if c.connected then
			local okBeat, e = pcall(c.fn, dt)
			if not okBeat then table.insert(errors, string.format("%.2f heartbeat: %s", now, tostring(e))) end
		end
	end
	local container = workspace:FindFirstChild("AbilityEffects")
	local present = {}
	for _, m in if container then container:GetChildren() else {} do
		present[m] = true
		local p = pivotOf(m).Position
		if not seen[m] then
			seen[m] = { name = m.Name, spawn = r(now), start = { r(p.X), r(p.Y), r(p.Z) }, samples = {}, shown = 0 }
			table.insert(order, m)
		end
		local s = seen[m]
		s.last = { r(p.X), r(p.Y), r(p.Z) }
		-- How visible it is (summons and props fade): 1 - the lowest transparency of its parts.
		local lowest = 1
		for _, d in m:GetDescendants() do
			if d:IsA("BasePart") and d.Name ~= "Root" and d.Name ~= "HumanoidRootPart" then lowest = math.min(lowest, d.Transparency) end
		end
		s.visible = r(1 - lowest)
		-- Mesh effects: how big each got and how visible.
		for _, d in m:GetDescendants() do
			if d:IsA("BasePart") and d:GetAttribute("ForgeMesh") then
				s.meshes = s.meshes or {}
				local mesh = s.meshes[d.Name] or { maxSize = 0, minT = 1 }
				mesh.maxSize = math.max(mesh.maxSize, r(math.max(d.Size.X, d.Size.Y, d.Size.Z)))
				mesh.minT = math.min(mesh.minT, r(d.Transparency))
				mesh.lastT = r(d.Transparency)
				s.meshes[d.Name] = mesh
			end
		end
		s.shown = math.max(s.shown, s.visible)
		-- Where it is every quarter second.
		local slot = tostring(math.floor((now + 1e-6) / 0.25))
		if not s.samples[slot] then s.samples[slot] = { r(now), r(p.X), r(p.Y), r(p.Z), s.visible } end
	end
	for _, m in order do
		if not present[m] and not seen[m].removed then seen[m].removed = r(now) end
	end
end

local effects = {}
for _, m in order do table.insert(effects, seen[m]) end
print("RUN " .. serde.encode("json", { effects = effects, emits = emits, errors = errors, registered = registered }))
