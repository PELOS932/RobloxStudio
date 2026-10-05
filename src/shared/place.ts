// Browsing the open Studio place: the Explorer tree, a 3D snapshot of the map (parts and
// terrain), ScreenGuis and script sources. Everything is read with execute_luau.
//
// Instances are addressed by path: one [name, n] step per level, where n picks the n-th
// child with that name (1 unless siblings share a name). The first step is a service.

import { luaString } from "./luau.ts";
import { mul, rotX, rotY, rotZ, type Mat3, type RGB, type Vec3 } from "./math.ts";
import { jsonReturnLuau, pullSelectionLuau } from "./studio-luau.ts";

export type PlacePath = [name: string, nth: number][];

export interface PlaceItem {
  name: string;
  className: string;
  nth: number;
  /** Direct children. */
  children: number;
  /** BaseParts anywhere below (capped), for "View in 3D". */
  parts: number;
}

export interface PlaceChildren {
  items: PlaceItem[];
  /** Children left out because the list was capped. */
  more: number;
  placeName?: string;
}

export const PART_KINDS = ["block", "ball", "cylinder", "wedge", "cornerWedge", "truss", "mesh", "union", "other"] as const;
export type PartKind = (typeof PART_KINDS)[number];

/** Map snapshot as sent by Studio (compact arrays; see sceneLuau). */
export interface PlaceSceneRaw {
  names: string[];
  classes: string[];
  materials: string[];
  /** [parentNode (0 = root), nameIndex, nth, classIndex] — 1-based indices, like Luau. */
  nodes: [number, number, number, number][];
  /** [node (-1 = the root itself), nameIndex, nth, kind, sx, sy, sz, x, y, z, rx, ry, rz, rgb, materialIndex, transparency, classIndex] */
  parts: number[][];
  terrain?: PlaceTerrain | null;
  stats: { meshes: number; unions: number; truncated: number };
}

export interface PlaceTerrain {
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
  /** Ground height per sample (row-major, x fastest); NO_HIT where there is no terrain. */
  heights: number[];
  /** Index into `materials` (1-based) per sample. */
  mats: number[];
  /** Water surface height per sample, NO_HIT where there is no water. */
  water: number[];
  materials: string[];
  /** RGB per terrain material, from Terrain:GetMaterialColor. */
  colors: number[];
  waterColor: number;
  waterTransparency: number;
}

export const NO_HIT = -99999;
export const MAX_SCENE_PARTS = 120_000;
export const PLACE_KEY = "__forgePlace";
/** Separate buffer for Explorer listings, so browsing works while a map is transferring. */
export const PLACE_TREE_KEY = "__forgePlaceTree";

/** Services listed at the top of the Explorer, in Studio's order. */
export const SERVICES = [
  "Workspace", "Players", "Lighting", "MaterialService", "ReplicatedFirst", "ReplicatedStorage", "ServerScriptService",
  "ServerStorage", "StarterGui", "StarterPack", "StarterPlayer", "Teams", "SoundService", "TextChatService",
];

export const pathKey = (p: PlacePath) => p.map(([n, k]) => `${n}#${k}`).join("/");

/** game.Workspace.Map — readable, but ambiguous when siblings share a name. */
export function fullName(p: PlacePath): string {
  return ["game", ...p.map(([n]) => (/^[A-Za-z_]\w*$/.test(n) ? n : `["${n.replace(/"/g, '\\"')}"]`))].join(".").replace(/\.\[/g, "[");
}

function pathLiteral(p: PlacePath): string {
  return `{ ${p.map(([n, k]) => `{ ${luaString(n)}, ${Math.max(1, Math.floor(k))} }`).join(", ")} }`;
}

/** Defines forgeFind(path) -> Instance? */
const FIND = String.raw`
local function forgeFind(path)
	local node = game
	for i, step in path do
		local name, nth = step[1], step[2]
		local found = nil
		if i == 1 then
			local ok, service = pcall(function() return game:FindService(name) end)
			if ok and service then found = service end
		end
		if not found then
			local k = 0
			for _, child in node:GetChildren() do
				if child.Name == name then
					k += 1
					if k == nth then found = child break end
				end
			end
		end
		if not found then return nil end
		node = found
	end
	return node
end
`;

const notFound = (p: PlacePath) => `return game:GetService("HttpService"):JSONEncode({ error = ${luaString(`${fullName(p)} no longer exists in Studio.`)} })`;

/** Children of an instance (the services when path is empty). */
export function childrenLuau(path: PlacePath, max = 2000): string {
  return String.raw`
${FIND}
local HttpService = game:GetService("HttpService")
local SERVICES = { ${SERVICES.map(luaString).join(", ")} }
local function countParts(inst)
	local n = 0
	for _, d in inst:GetDescendants() do
		if d:IsA("BasePart") and d.ClassName ~= "Terrain" then
			n += 1
			if n >= 200000 then break end
		end
	end
	return n
end
local function describe(child, nth)
	local parts = countParts(child)
	if child:IsA("BasePart") and child.ClassName ~= "Terrain" then parts += 1 end
	return { name = child.Name, className = child.ClassName, nth = nth, children = #child:GetChildren(), parts = parts }
end

local items, more = {}, 0
local path = ${pathLiteral(path)}
if #path == 0 then
	for _, name in SERVICES do
		local ok, service = pcall(function() return game:FindService(name) end)
		if ok and service then table.insert(items, describe(service, 1)) end
	end
else
	local node = forgeFind(path)
	if not node then ${notFound(path)} end
	local counts = {}
	for _, child in node:GetChildren() do
		local k = (counts[child.Name] or 0) + 1
		counts[child.Name] = k
		if #items < ${max} then table.insert(items, describe(child, k)) else more += 1 end
	end
end
local placeName = nil
pcall(function() placeName = game.Name end)
local result = { items = items, more = more, placeName = placeName }
${jsonReturnLuau("result", PLACE_TREE_KEY)}
`;
}

/** Every BasePart below `path` (or the part itself) plus a terrain heightmap for Workspace. */
export function sceneLuau(path: PlacePath, opts: { max?: number; terrain?: boolean } = {}): string {
  const max = opts.max ?? MAX_SCENE_PARTS;
  return String.raw`
${FIND}
local root = forgeFind(${pathLiteral(path)})
if not root then ${notFound(path)} end

local function r(n, d)
	local f = 10 ^ (d or 3)
	local v = math.round(n * f) / f
	if v == 0 then return 0 end
	return v
end
local function list(t)
	local index = {}
	return t, function(s)
		local i = index[s]
		if not i then
			table.insert(t, s)
			i = #t
			index[s] = i
		end
		return i
	end
end
local names, nameId = list({})
local classes, classId = list({})
local materials, materialId = list({})
local nodes, parts = {}, {}
local stats = { meshes = 0, unions = 0, truncated = 0 }
local SKIP = { Camera = true, Terrain = true }

local function rgb(c)
	return math.round(c.R * 255) * 65536 + math.round(c.G * 255) * 256 + math.round(c.B * 255)
end

local function addPart(p, node, name, nth)
	if #parts >= ${max} then
		stats.truncated += 1
		return
	end
	local cls = p.ClassName
	local kind = 0
	if cls == "WedgePart" then kind = 3
	elseif cls == "CornerWedgePart" then kind = 4
	elseif cls == "TrussPart" then kind = 5
	elseif cls == "MeshPart" then kind = 6; stats.meshes += 1
	elseif p:IsA("PartOperation") then kind = 7; stats.unions += 1
	elseif p:IsA("Part") then
		local shape = p.Shape.Name
		kind = if shape == "Ball" then 1 elseif shape == "Cylinder" then 2 elseif shape == "Wedge" then 3 elseif shape == "CornerWedge" then 4 else 0
	else
		kind = 8
	end
	local cf, size = p.CFrame, p.Size
	local pos = cf.Position
	local rx, ry, rz = cf:ToEulerAnglesXYZ()
	table.insert(parts, {
		node, nameId(name), nth, kind,
		r(size.X), r(size.Y), r(size.Z), r(pos.X), r(pos.Y), r(pos.Z), r(rx, 4), r(ry, 4), r(rz, 4),
		rgb(p.Color), materialId(p.Material.Name), r(p.Transparency, 2), classId(cls),
	})
end

local function walk(inst, getNode)
	local counts = {}
	for _, child in inst:GetChildren() do
		local name = child.Name
		local nth = (counts[name] or 0) + 1
		counts[name] = nth
		if child:IsA("BasePart") and not SKIP[child.ClassName] then
			addPart(child, getNode(), name, nth)
		end
		if not SKIP[child.ClassName] and #child:GetChildren() > 0 then
			local index = nil
			walk(child, function()
				if not index then
					table.insert(nodes, { getNode(), nameId(name), nth, classId(child.ClassName) })
					index = #nodes
				end
				return index
			end)
		end
	end
end

if root:IsA("BasePart") and not SKIP[root.ClassName] then
	addPart(root, -1, root.Name, 1)
end
walk(root, function() return 0 end)

local terrain = nil
${opts.terrain === false ? "" : TERRAIN}
local result = { names = names, classes = classes, materials = materials, nodes = nodes, parts = parts, terrain = terrain, stats = stats }
${jsonReturnLuau("result", PLACE_KEY)}
`;
}

// Heightmap of the terrain by raycasting straight down (works in Edit mode): a coarse pass
// finds where terrain is, a fine pass (up to 256 x 256 samples) records ground and water.
const TERRAIN = String.raw`
if root == workspace then
	pcall(function()
		local t = workspace:FindFirstChildOfClass("Terrain")
		if not t or t:CountCells() == 0 then return end
		local params = RaycastParams.new()
		params.FilterType = Enum.RaycastFilterType.Include
		params.FilterDescendantsInstances = { t }
		params.IgnoreWater = true
		local waterParams = RaycastParams.new()
		waterParams.FilterType = Enum.RaycastFilterType.Include
		waterParams.FilterDescendantsInstances = { t }
		waterParams.IgnoreWater = false
		local TOP, DOWN = Vector3.new(0, 4000, 0), Vector3.new(0, -8000, 0)

		local minX, minZ, maxX, maxZ = math.huge, math.huge, -math.huge, -math.huge
		local COARSE, SPAN = 64, 4096
		for x = -SPAN, SPAN, COARSE do
			for z = -SPAN, SPAN, COARSE do
				local hit = workspace:Raycast(Vector3.new(x, 0, z) + TOP, DOWN, waterParams)
				if hit then
					minX, minZ = math.min(minX, x), math.min(minZ, z)
					maxX, maxZ = math.max(maxX, x), math.max(maxZ, z)
				end
			end
		end
		if minX > maxX then return end
		minX, minZ, maxX, maxZ = minX - COARSE, minZ - COARSE, maxX + COARSE, maxZ + COARSE
		local step = math.max(4, math.ceil(math.max(maxX - minX, maxZ - minZ) / 256 / 4) * 4)
		local nx, nz = math.floor((maxX - minX) / step) + 1, math.floor((maxZ - minZ) / step) + 1
		local heights, mats, water = table.create(nx * nz), table.create(nx * nz), table.create(nx * nz)
		local matNames, matIndex, colors = {}, {}, {}
		for j = 0, nz - 1 do
			for i = 0, nx - 1 do
				local origin = Vector3.new(minX + i * step, 0, minZ + j * step) + TOP
				local hit = workspace:Raycast(origin, DOWN, params)
				if hit then
					local name = hit.Material.Name
					local m = matIndex[name]
					if not m then
						table.insert(matNames, name)
						m = #matNames
						matIndex[name] = m
						local ok, c = pcall(function() return t:GetMaterialColor(hit.Material) end)
						table.insert(colors, if ok and c then rgb(c) else 0x7f7f7f)
					end
					table.insert(heights, r(hit.Position.Y, 1))
					table.insert(mats, m)
				else
					table.insert(heights, ${NO_HIT})
					table.insert(mats, 0)
				end
				local w = workspace:Raycast(origin, DOWN, waterParams)
				table.insert(water, if w and w.Material == Enum.Material.Water then r(w.Position.Y, 1) else ${NO_HIT})
			end
		end
		terrain = {
			x0 = minX, z0 = minZ, step = step, nx = nx, nz = nz, heights = heights, mats = mats, water = water,
			materials = matNames, colors = colors, waterColor = rgb(t.WaterColor), waterTransparency = t.WaterTransparency,
		}
	end)
end
`;

/** A ScreenGui (or GUI object) as a UI spec, using the selection reader. */
export function placeUiLuau(path: PlacePath): string {
  return pullSelectionLuau({ prelude: `${FIND}\nlocal __target = forgeFind(${pathLiteral(path)})`, target: "if __target then { __target } else {}", key: PLACE_KEY });
}

export function scriptSourceLuau(path: PlacePath): string {
  return String.raw`
${FIND}
local s = forgeFind(${pathLiteral(path)})
if not s then ${notFound(path)} end
if not s:IsA("LuaSourceContainer") then
	return game:GetService("HttpService"):JSONEncode({ error = s.ClassName .. " is not a script." })
end
local result = { name = s.Name, className = s.ClassName, source = s.Source }
${jsonReturnLuau("result", PLACE_KEY)}
`;
}

/** Select the instances in Studio's Explorer (and frame nothing; the user's camera stays put). */
export function selectLuau(paths: PlacePath[]): string {
  return String.raw`
${FIND}
local list = {}
for _, p in { ${paths.map(pathLiteral).join(", ")} } do
	local inst = forgeFind(p)
	if inst then table.insert(list, inst) end
end
game:GetService("Selection"):Set(list)
return game:GetService("HttpService"):JSONEncode({ selected = #list })
`;
}

// ---------------------------------------------------------------------------
// Decoding a snapshot for the viewer.

export interface ScenePart {
  name: string;
  className: string;
  kind: PartKind;
  size: Vec3;
  pos: Vec3;
  /** Row-major rotation, same convention as NativePart.rot. */
  rot: Mat3;
  color: RGB;
  material: string;
  transparency: number;
  /** Path from the snapshot root's parent chain, e.g. ["Map", "House"] (the part itself not included). */
  group: string[];
  /** Full path of the part, for selecting it in Studio. */
  path: PlacePath;
}

export interface PlaceScene {
  parts: ScenePart[];
  terrain: PlaceTerrain | null;
  stats: PlaceSceneRaw["stats"];
  bounds: { min: Vec3; max: Vec3 };
}

/** Expand the compact snapshot of `rootPath` into parts with full paths and rotation matrices. */
export function decodeScene(raw: PlaceSceneRaw, rootPath: PlacePath): PlaceScene {
  const name = (i: number) => raw.names[i - 1] ?? "";
  const nodePaths: PlacePath[] = [rootPath];
  const nodeGroups: string[][] = [[]];
  raw.nodes.forEach(([parent, n, nth], i) => {
    nodePaths[i + 1] = [...nodePaths[parent], [name(n), nth]];
    nodeGroups[i + 1] = [...nodeGroups[parent], name(n)];
  });
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const parts = raw.parts.map((a): ScenePart => {
    const [node, n, nth, kind, sx, sy, sz, x, y, z, rx, ry, rz, rgb, m, t, c] = a;
    const rot = rx || ry || rz ? mul(mul(rotX(rx), rotY(ry)), rotZ(rz)) : ([1, 0, 0, 0, 1, 0, 0, 0, 1] as Mat3);
    const size: Vec3 = [sx, sy, sz];
    const pos: Vec3 = [x, y, z];
    // World-space half extents of the oriented box.
    for (let k = 0; k < 3; k++) {
      const e = Math.abs(rot[k * 3]) * sx / 2 + Math.abs(rot[k * 3 + 1]) * sy / 2 + Math.abs(rot[k * 3 + 2]) * sz / 2;
      min[k] = Math.min(min[k], pos[k] - e);
      max[k] = Math.max(max[k], pos[k] + e);
    }
    return {
      name: name(n),
      className: raw.classes[c - 1] ?? "Part",
      kind: PART_KINDS[kind] ?? "other",
      size,
      pos,
      rot,
      color: [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255],
      material: raw.materials[m - 1] ?? "Plastic",
      transparency: t,
      group: node > 0 ? nodeGroups[node] : [],
      path: node < 0 ? rootPath : [...nodePaths[node], [name(n), nth]],
    };
  });
  const t = raw.terrain;
  if (t) {
    for (let j = 0; j < t.nz; j++) {
      for (let i = 0; i < t.nx; i++) {
        const h = t.heights[j * t.nx + i];
        const w = t.water[j * t.nx + i];
        const top = Math.max(h, w);
        if (top === NO_HIT) continue;
        const px = t.x0 + i * t.step, pz = t.z0 + j * t.step;
        min[0] = Math.min(min[0], px); max[0] = Math.max(max[0], px);
        min[2] = Math.min(min[2], pz); max[2] = Math.max(max[2], pz);
        min[1] = Math.min(min[1], h === NO_HIT ? w : h); max[1] = Math.max(max[1], top);
      }
    }
  }
  if (!Number.isFinite(min[0])) return { parts, terrain: t ?? null, stats: raw.stats, bounds: { min: [0, 0, 0], max: [0, 0, 0] } };
  return { parts, terrain: t ?? null, stats: raw.stats, bounds: { min, max } };
}
