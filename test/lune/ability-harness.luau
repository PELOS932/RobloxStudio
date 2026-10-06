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

local function r(n) return math.round(n * 1000) / 1000 end
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

local function summary(holder)
	local play = holder:FindFirstChild("Play")
	return {
		animation = sequence(holder:FindFirstChild("Animation")),
		effects = effects(holder:FindFirstChild("Effects")),
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
