-- Executes one execute_luau request against a persistent place file (mock Studio).
-- usage: lune run run.luau <place.rbxlx> <code.luau> <selection.txt>
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")
local stdio = require("@lune/stdio")

local placeFile, codeFile, selectionFile = process.args[1], process.args[2], process.args[3]

local game
if fs.isFile(placeFile) then
	game = roblox.deserializePlace(fs.readFile(placeFile))
else
	game = roblox.Instance.new("DataModel")
end
for _, name in { "Workspace", "StarterGui", "ServerScriptService", "ReplicatedStorage", "ServerStorage" } do
	game:GetService(name)
end

local function findPath(path)
	local node = game
	for segment in string.gmatch(path, "[^%.]+") do
		node = node:FindFirstChild(segment)
		if not node then return nil end
	end
	return node
end

local selection = {
	Get = function()
		local out = {}
		if fs.isFile(selectionFile) then
			for line in string.gmatch(fs.readFile(selectionFile), "[^\n]+") do
				local inst = findPath((string.gsub(line, "^game%.?", "")))
				if inst then table.insert(out, inst) end
			end
		end
		return out
	end,
	Set = function(_, list)
		local lines = {}
		for _, inst in list do table.insert(lines, inst:GetFullName()) end
		fs.writeFile(selectionFile, table.concat(lines, "\n"))
	end,
}
local http = {
	JSONEncode = function(_, value) return serde.encode("json", value) end,
	JSONDecode = function(_, text) return serde.decode("json", text) end,
}

local fakeGame = setmetatable({}, {
	__index = function(_, key)
		if key == "GetService" then
			return function(_, name)
				if name == "Selection" then return selection end
				if name == "HttpService" then return http end
				return game:GetService(name)
			end
		end
		local value = (game :: any)[key]
		if type(value) == "function" then
			return function(_, ...) return value(game, ...) end
		end
		return value
	end,
	__eq = function() return true end,
})

local env = setmetatable({
	game = fakeGame,
	workspace = game:GetService("Workspace"),
	shared = {},
	Instance = roblox.Instance, Vector3 = roblox.Vector3, Vector2 = roblox.Vector2, CFrame = roblox.CFrame,
	Color3 = roblox.Color3, UDim = roblox.UDim, UDim2 = roblox.UDim2, Rect = roblox.Rect, Enum = roblox.Enum, Font = roblox.Font,
	ColorSequence = roblox.ColorSequence, ColorSequenceKeypoint = roblox.ColorSequenceKeypoint,
	NumberSequence = roblox.NumberSequence, NumberSequenceKeypoint = roblox.NumberSequenceKeypoint,
}, { __index = getfenv(1) })

local ok, result = pcall(function()
	return luau.load(fs.readFile(codeFile), { debugName = "CommandExecution", environment = env })()
end)
if not ok then
	stdio.ewrite(tostring(result))
	process.exit(1)
end
fs.writeFile(placeFile, roblox.serializePlace(game))
stdio.write(if result == nil then "nil" else tostring(result))
