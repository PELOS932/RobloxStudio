-- Imports an ability with the generated Luau and loads the exported .rbxmx Tool, then prints a
-- summary of both (keyframes and poses, effect templates, scripts) and whether the generated
-- Play and Cast scripts compile.
-- usage: lune run ability-harness.luau <import.luau> <tool.rbxmx>
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")

local game = roblox.Instance.new("DataModel")
local workspace = game:GetService("Workspace")
game:GetService("ReplicatedStorage")
game:GetService("StarterPack")
local env = setmetatable({ game = game, workspace = workspace }, { __index = getfenv(1) })
for name, value in roblox do
	if string.match(name, "^%u") then env[name] = value end
end
local result = luau.load(fs.readFile(process.args[1]), { debugName = "import", environment = env })()
assert(string.find(result, '"ok":true'), result)

-- Rounded via 4 decimals first, so a value written as -0.0145 and as -0.01449999 agree.
local function r(n) return math.round(math.round(n * 10000) / 10) / 1000 end
local function compiles(source)
	local ok, err = pcall(luau.compile, source)
	return if ok then "ok" else tostring(err)
end

local function sequence(seq)
	if not seq then return nil end
	local out = { loop = seq.Loop, priority = seq.Priority.Name, keyframes = {} }
	local frames = seq:GetChildren()
	table.sort(frames, function(a, b) return a.Time < b.Time end)
	for _, k in frames do
		local poses = {}
		for _, p in k:GetDescendants() do
			if p:IsA("Pose") then
				local entry = { w = p.Weight }
				if p.Weight > 0 then
					local c = { p.CFrame:GetComponents() }
					for i, x in c do c[i] = r(x) end
					entry.cf = c
					entry.style = p.EasingStyle.Name
					entry.dir = p.EasingDirection.Name
				end
				poses[p:GetFullName():sub(#k:GetFullName() + 2)] = entry
			end
		end
		table.insert(out.keyframes, { t = r(k.Time), name = k.Name, poses = poses })
	end
	return out
end

local function effects(folder)
	local out = {}
	for _, m in folder:GetChildren() do
		local counts = {}
		for _, d in m:GetDescendants() do counts[d.ClassName] = (counts[d.ClassName] or 0) + 1 end
		out[m.Name] = counts
	end
	return out
end

-- Summon and prop templates: class counts plus the look and placement of every part and joint.
local function templates(folder)
	if not folder then return nil end
	local out = {}
	for _, m in folder:GetChildren() do
		local counts, parts, joints = {}, {}, {}
		for _, d in m:GetDescendants() do
			counts[d.ClassName] = (counts[d.ClassName] or 0) + 1
			if d:IsA("BasePart") then
				local c = { d.CFrame:GetComponents() }
				for i, x in c do c[i] = r(x) end
				parts[d.Name] = { cf = c, size = { r(d.Size.X), r(d.Size.Y), r(d.Size.Z) }, material = d.Material.Name, color = { math.round(d.Color.R * 255), math.round(d.Color.G * 255), math.round(d.Color.B * 255) }, t = r(d.Transparency), anchored = d.Anchored, shape = if d:IsA("Part") then d.Shape.Name else nil }
			elseif d:IsA("Motor6D") then
				local c0, c1 = { d.C0:GetComponents() }, { d.C1:GetComponents() }
				for i, x in c0 do c0[i] = r(x) end
				for i, x in c1 do c1[i] = r(x) end
				joints[d.Name] = { p0 = d.Part0 and d.Part0.Name, p1 = d.Part1 and d.Part1.Name, holder = d.Parent.Name, c0 = c0, c1 = c1 }
			end
		end
		out[m.Name] = { counts = counts, parts = parts, joints = joints, primary = m.PrimaryPart and m.PrimaryPart.Name, animation = sequence(m:FindFirstChild("Animation")), height = m:GetAttribute("Height") }
	end
	return out
end

local function summary(holder)
	local play = holder:FindFirstChild("Play")
	return {
		animation = sequence(holder:FindFirstChild("Animation")),
		effects = effects(holder:FindFirstChild("Effects")),
		summons = templates(holder:FindFirstChild("Summons")),
		props = templates(holder:FindFirstChild("Props")),
		play = if play then compiles(play.Source) else "missing",
	}
end

local abilities = game:GetService("ReplicatedStorage"):FindFirstChild("Abilities")
local folder = abilities:GetChildren()[1]
local tool = game:GetService("StarterPack"):FindFirstChildOfClass("Tool")
local imported = summary(folder)
imported.folder = folder.Name
imported.attrs = { AnimationId = folder:GetAttribute("AnimationId"), hash = folder:GetAttribute("AnimationHash") ~= nil }
imported.tool = { name = tool.Name, requiresHandle = tool.RequiresHandle, cast = compiles(tool.Cast.Source), children = #tool:GetChildren() }

local exportedTool = roblox.deserializeModel(fs.readFile(process.args[2]))[1]
local exported = summary(exportedTool)
exported.tool = { name = exportedTool.Name, class = exportedTool.ClassName, cast = compiles(exportedTool.Cast.Source) }

print("IMPORTED " .. serde.encode("json", imported))
print("EXPORTED " .. serde.encode("json", exported))
