-- Builds a small scene, selects part of it and runs the generated pull code.
-- usage: lune run pull-harness.luau <file> <model|ui>
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")

local Instance, Vector3, CFrame, Color3, Enum = roblox.Instance, roblox.Vector3, roblox.CFrame, roblox.Color3, roblox.Enum
local UDim2, UDim = roblox.UDim2, roblox.UDim
local game = Instance.new("DataModel")
local workspace = game:GetService("Workspace")

local house = Instance.new("Model")
house.Name = "House"
local floor = Instance.new("Part")
floor.Name = "Floor"
floor.Size = Vector3.new(10, 1, 10)
floor.CFrame = CFrame.new(100, 0.5, 50)
floor.Color = Color3.fromRGB(120, 90, 60)
floor.Material = Enum.Material.WoodPlanks
floor.Parent = house
local roof = Instance.new("Model")
roof.Name = "Roof"
roof.Parent = house
local wedge = Instance.new("WedgePart")
wedge.Name = "RoofLeft"
wedge.Size = Vector3.new(10, 3, 5)
wedge.CFrame = CFrame.new(100, 6, 47.5) * CFrame.Angles(0, math.rad(180), 0)
wedge.Parent = roof
local lamp = Instance.new("Part")
lamp.Name = "Lamp"
lamp.Shape = Enum.PartType.Ball
lamp.Size = Vector3.new(1, 1, 1)
lamp.CFrame = CFrame.new(100, 3, 50)
lamp.Material = Enum.Material.Neon
lamp.CanCollide = false
lamp.Parent = house
local light = Instance.new("PointLight")
light.Range = 20
light.Parent = lamp
house.Parent = workspace

local gui = Instance.new("ScreenGui")
gui.Name = "HUD"
gui.IgnoreGuiInset = true
local frame = Instance.new("Frame")
frame.Name = "Panel"
frame.Size = UDim2.new(0, 300, 0, 120)
frame.Position = UDim2.new(0.5, 0, 1, -20)
frame.AnchorPoint = roblox.Vector2.new(0.5, 1)
frame.BackgroundColor3 = Color3.fromRGB(20, 20, 30)
frame.Parent = gui
local corner = Instance.new("UICorner")
corner.CornerRadius = UDim.new(0, 10)
corner.Parent = frame
local label = Instance.new("TextLabel")
label.Name = "Coins"
label.Text = "Coins: 10 ✓"
label.Font = Enum.Font.GothamBold
label.BackgroundTransparency = 1
label.TextSize = 24
label.Size = UDim2.new(1, 0, 0, 40)
label.Parent = frame
gui.Parent = game:GetService("StarterGui")

local selected = if process.args[2] == "ui" then { gui } else { house }
local shared = {}
local fakeGame = setmetatable({}, {
	__index = function(_, key)
		if key == "GetService" then
			return function(_, name)
				if name == "Selection" then
					return { Get = function() return selected end }
				elseif name == "HttpService" then
					return { JSONEncode = function(_, v) return serde.encode("json", v) end }
				end
				return game:GetService(name)
			end
		end
		return (game :: any)[key]
	end,
})
local env = setmetatable({
	game = fakeGame, workspace = workspace, shared = shared, Enum = Enum, Vector3 = Vector3, CFrame = CFrame,
}, { __index = getfenv(1) })
local out = luau.load(fs.readFile(process.args[1]), { environment = env })()
local header = serde.decode("json", out)
print(shared.__forgePull and header.total == #shared.__forgePull and header.chunk == shared.__forgePull and shared.__forgePull or "MISMATCH")
