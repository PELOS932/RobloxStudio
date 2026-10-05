import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlaceReader } from "../src/server/place.ts";
import { extractJson, type StudioBridge } from "../src/server/studio-bridge.ts";
import { decodeScene, fullName, type PlacePath } from "../src/shared/place.ts";

// Reads a place through the same Luau the app sends to Studio, executed by the mock Studio
// (Lune with Roblox's instance model; `shared` persists between calls like in Studio).

const LUNE = process.env.LUNE_BIN ?? "lune";
let luneAvailable = true;
try {
  execFileSync(LUNE, ["--version"], { stdio: "ignore" });
} catch {
  luneAvailable = false;
}

const dir = mkdtempSync(join(tmpdir(), "forge-place-"));
const placeFile = join(dir, "place.rbxlx");
const selectionFile = join(dir, "selection.txt");
let calls = 0;
function run(code: string): string {
  calls++;
  const file = join(dir, "code.luau");
  writeFileSync(file, code);
  return execFileSync(LUNE, ["run", join(import.meta.dirname, "..", "scripts", "mock-studio", "run.luau"), placeFile, file, selectionFile], { encoding: "utf8" });
}
const bridge = { runLuauJson: async (code: string) => extractJson(run(code)) } as unknown as StudioBridge;
const place = new PlaceReader(bridge);

const LEAVES = 1500;
const BIG_SOURCE = `-- Inventory ✓\n${"local x = 1 -- padding padding padding\n".repeat(2000)}return {}`;

const BUILD = String.raw`
local ws = workspace
local base = Instance.new("Part")
base.Name = "Baseplate"
base.Size = Vector3.new(512, 20, 512)
base.CFrame = CFrame.new(0, -10, 0)
base.Color = Color3.fromRGB(91, 93, 105)
base.Material = Enum.Material.Slate
base.Parent = ws

local map = Instance.new("Model")
map.Name = "Map"
map.Parent = ws
for i = 1, 2 do
	local tower = Instance.new("Model")
	tower.Name = "Tower"
	tower.Parent = map
	local p = Instance.new("Part")
	p.Name = "Wall"
	p.Size = Vector3.new(4, 12, 4)
	p.CFrame = CFrame.new(i * 20, 6, 0) * CFrame.Angles(0, math.rad(30 * i), 0)
	p.Color = Color3.fromRGB(200, 100, 50)
	p.Material = Enum.Material.Brick
	p.Parent = tower
end
local roof = Instance.new("WedgePart")
roof.Name = "Roof"
roof.Size = Vector3.new(6, 2, 6)
roof.CFrame = CFrame.new(20, 13, 0)
roof.Parent = map
local pipe = Instance.new("Part")
pipe.Name = "Pipe"
pipe.Shape = Enum.PartType.Cylinder
pipe.Size = Vector3.new(10, 2, 2)
pipe.CFrame = CFrame.new(0, 1, 30)
pipe.Transparency = 0.25
pipe.Parent = map
local statue = Instance.new("MeshPart")
statue.Name = "Statue"
statue.Size = Vector3.new(3, 8, 3)
statue.CFrame = CFrame.new(-20, 4, 0)
statue.Parent = map
local trees = Instance.new("Folder")
trees.Name = "Trees"
trees.Parent = map
for i = 1, ${LEAVES} do
	local leaf = Instance.new("Part")
	leaf.Name = "Leaf"
	leaf.Shape = Enum.PartType.Ball
	leaf.Size = Vector3.new(2, 2, 2)
	leaf.CFrame = CFrame.new(i % 30 * 3, 10 + i // 30, 50)
	leaf.Color = Color3.fromRGB(60, 140, 60)
	leaf.Material = Enum.Material.Grass
	leaf.Parent = trees
end

local gui = Instance.new("ScreenGui")
gui.Name = "HUD"
gui.IgnoreGuiInset = true -- Lune stores this as ScreenInsets
gui.Parent = game:GetService("StarterGui")
local frame = Instance.new("Frame")
frame.Name = "Panel"
frame.Size = UDim2.new(0, 300, 0, 120)
frame.Parent = gui
local label = Instance.new("TextLabel")
label.Name = "Coins"
label.Text = "Coins: 10"
label.FontFace = Font.new("rbxasset://fonts/families/GothamSSm.json", Enum.FontWeight.Bold)
label.Size = UDim2.new(1, 0, 0, 40)
label.Parent = frame

local main = Instance.new("Script")
main.Name = "Main"
main.Source = "print('hello from Main')"
main.Parent = game:GetService("ServerScriptService")
local inv = Instance.new("ModuleScript")
inv.Name = "Inventory"
inv.Source = ${JSON.stringify(BIG_SOURCE)}
inv.Parent = game:GetService("ReplicatedStorage")
return "ok"
`;

const WS: PlacePath = [["Workspace", 1]];

describe.skipIf(!luneAvailable)("place browser (mock Studio)", () => {
  if (luneAvailable) run(BUILD);

  it("lists the services, then children with part counts and duplicate names", async () => {
    const top = await place.children([]);
    const names = top.items.map((i) => i.name);
    expect(names.slice(0, 1)).toEqual(["Workspace"]);
    expect(names).toEqual(expect.arrayContaining(["StarterGui", "ServerScriptService", "ReplicatedStorage"]));
    expect(top.items.find((i) => i.name === "Workspace")!.parts).toBe(1 + 2 + 3 + LEAVES);

    const ws = await place.children(WS);
    expect(ws.items.find((i) => i.name === "Baseplate")).toMatchObject({ className: "Part", parts: 1, children: 0 });
    const map = await place.children([...WS, ["Map", 1]]);
    expect(map.items.filter((i) => i.name === "Tower").map((i) => i.nth)).toEqual([1, 2]);
    expect(map.items.find((i) => i.name === "Trees")).toMatchObject({ className: "Folder", children: LEAVES, parts: LEAVES });

    await expect(place.children([...WS, ["Nope", 1]])).rejects.toThrow(/game\.Workspace\.Nope no longer exists/);
  });

  it("snapshots the whole map in chunks and decodes it", async () => {
    const before = calls;
    const raw = await place.scene(WS);
    expect(calls - before).toBeGreaterThan(1); // > 60 KB, so it came in several chunks
    const scene = decodeScene(raw, WS);
    expect(scene.parts).toHaveLength(6 + LEAVES);
    expect(raw.stats).toMatchObject({ meshes: 1, truncated: 0 });

    const by = (name: string) => scene.parts.filter((p) => p.name === name);
    const base = by("Baseplate")[0];
    expect(base).toMatchObject({ kind: "block", size: [512, 20, 512], pos: [0, -10, 0], color: [91, 93, 105], material: "Slate", group: [] });
    expect(base.path).toEqual([["Workspace", 1], ["Baseplate", 1]]);

    const walls = by("Wall");
    expect(walls.map((w) => w.path)).toEqual([
      [["Workspace", 1], ["Map", 1], ["Tower", 1], ["Wall", 1]],
      [["Workspace", 1], ["Map", 1], ["Tower", 2], ["Wall", 1]],
    ]);
    // 30° about Y, in the viewer's row-major convention.
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    walls[0].rot.forEach((v, i) => expect(v).toBeCloseTo([c, 0, s, 0, 1, 0, -s, 0, c][i], 3));
    expect(walls[0].group).toEqual(["Map", "Tower"]);

    expect(by("Roof")[0]).toMatchObject({ kind: "wedge", className: "WedgePart" });
    expect(by("Pipe")[0]).toMatchObject({ kind: "cylinder", transparency: 0.25 });
    expect(by("Statue")[0]).toMatchObject({ kind: "mesh", className: "MeshPart", size: [3, 8, 3] });
    expect(by("Leaf")).toHaveLength(LEAVES);
    expect(by("Leaf")[LEAVES - 1].path.at(-1)).toEqual(["Leaf", LEAVES]);
    expect(scene.bounds.min[0]).toBeCloseTo(-256, 3);
    expect(scene.bounds.max[1]).toBeGreaterThan(30);
  });

  it("snapshots a single part", async () => {
    const path: PlacePath = [...WS, ["Map", 1], ["Pipe", 1]];
    const scene = decodeScene(await place.scene(path), path);
    expect(scene.parts).toHaveLength(1);
    expect(scene.parts[0].path).toEqual(path);
  });

  it("reads a ScreenGui as a UI", async () => {
    const { spec } = await place.ui([["StarterGui", 1], ["HUD", 1]]);
    expect(spec).toMatchObject({ name: "HUD", ignoreInset: true });
    expect(spec.nodes.map((n) => n.name)).toEqual(["Panel", "Coins"]);
    expect(spec.nodes[1]).toMatchObject({ parent: "Panel", text: "Coins: 10" });
    await expect(place.ui([...WS, ["Map", 1]])).rejects.toThrow(/isn't a ScreenGui/);
  });

  it("reads script sources, including long ones with non-ASCII text", async () => {
    expect(await place.script([["ServerScriptService", 1], ["Main", 1]])).toEqual({ name: "Main", className: "Script", source: "print('hello from Main')" });
    const inv = await place.script([["ReplicatedStorage", 1], ["Inventory", 1]]);
    expect(inv.source).toBe(BIG_SOURCE);
    await expect(place.script(WS)).rejects.toThrow(/not a script/);
  });

  it("selects instances in Studio", async () => {
    const path: PlacePath = [...WS, ["Map", 1], ["Tower", 2]];
    expect(await place.select([path])).toEqual({ selected: 1 });
    expect(readFileSync(selectionFile, "utf8")).toBe("Workspace.Map.Tower");
    expect(fullName([...WS, ["My Map", 1]])).toBe('game.Workspace["My Map"]');
  });
});
