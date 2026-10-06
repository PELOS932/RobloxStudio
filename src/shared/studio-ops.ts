// Studio power tools: each builds ONE Luau chunk that does a whole job inside Studio (find
// instances, batch edits, script search, lighting, terrain) and returns a compact text result.
// One round trip per job instead of one per instance keeps Claude fast and its context small.

import { luaNum, luaString } from "./luau.ts";

/** Marks an explicit null (Luau tables can't hold nil). */
const NULL = "FORGE_NULL";

/** JSON value → Luau table literal. */
export function toLua(v: unknown): string {
  if (v === null || v === undefined) return NULL;
  if (typeof v === "number") return luaNum(v, 6);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") return luaString(v);
  if (Array.isArray(v)) return `{${v.map(toLua).join(",")}}`;
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  return `{${entries.map(([k, x]) => `[${luaString(k)}]=${toLua(x)}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// Shared Luau runtime: path resolution, value formatting and type coercion.

export const OPS_RUNTIME = String.raw`
local FORGE_NULL = newproxy and newproxy() or {}
local function fRound(n, d)
	local m = 10 ^ (d or 3)
	local r = math.round(n * m) / m
	return if r == 0 then 0 else r
end
local function fSelection()
	local ok, list = pcall(function() return game:GetService("Selection"):Get() end)
	if not ok or #list == 0 then error("nothing is selected in Studio", 0) end
	return list
end
-- "@selection" (or path "@selection") is the first selected instance.
local function fPath(path)
	if path == "@selection" then return fSelection()[1] end
	local segs = {}
	if type(path) == "table" then
		segs = path
	else
		path = string.gsub(tostring(path or ""), "^game%.?", "")
		for s in string.gmatch(path, "[^%.]+") do table.insert(segs, s) end
	end
	local node = game
	for i, seg in segs do
		local nextNode = node:FindFirstChild(seg)
		if not nextNode and i == 1 then
			local ok, svc = pcall(function() return game:GetService(seg) end)
			if ok and svc then nextNode = svc end
		end
		if not nextNode then error("not found: " .. table.concat(segs, ".", 1, i), 0) end
		node = nextNode
	end
	return node
end
local function fName(inst, root)
	local full = inst:GetFullName()
	if root and root ~= game then
		local prefix = root:GetFullName() .. "."
		if string.sub(full, 1, #prefix) == prefix then return string.sub(full, #prefix + 1) end
	end
	return full
end
local function fHex(c)
	return string.format("#%02x%02x%02x", math.round(c.R * 255), math.round(c.G * 255), math.round(c.B * 255))
end
local function fFmt(v)
	local t = typeof(v)
	if v == nil then return "nil"
	elseif t == "number" then return tostring(fRound(v))
	elseif t == "boolean" then return tostring(v)
	elseif t == "string" then
		if #v > 120 then v = string.sub(v, 1, 117) .. "..." end
		return string.format("%q", v)
	elseif t == "Vector3" then return fRound(v.X, 2) .. "," .. fRound(v.Y, 2) .. "," .. fRound(v.Z, 2)
	elseif t == "Vector2" then return fRound(v.X, 2) .. "," .. fRound(v.Y, 2)
	elseif t == "Color3" then return fHex(v)
	elseif t == "BrickColor" then return v.Name
	elseif t == "EnumItem" then return v.Name
	elseif t == "Instance" then return v:GetFullName()
	elseif t == "CFrame" then
		local p = v.Position
		local s = fRound(p.X, 2) .. "," .. fRound(p.Y, 2) .. "," .. fRound(p.Z, 2)
		local ok, rx, ry, rz = pcall(function() return v:ToEulerAnglesXYZ() end)
		if ok and (math.abs(rx) + math.abs(ry) + math.abs(rz)) > 1e-4 then
			s ..= " rot " .. fRound(math.deg(rx), 1) .. "," .. fRound(math.deg(ry), 1) .. "," .. fRound(math.deg(rz), 1)
		end
		return s
	elseif t == "UDim2" then return string.format("{%s,%d},{%s,%d}", fRound(v.X.Scale), v.X.Offset, fRound(v.Y.Scale), v.Y.Offset)
	elseif t == "UDim" then return string.format("{%s,%d}", fRound(v.Scale), v.Offset)
	elseif t == "NumberRange" then return fRound(v.Min) .. ".." .. fRound(v.Max)
	elseif t == "NumberSequence" then
		local out = {}
		for _, k in v.Keypoints do table.insert(out, fRound(k.Time, 2) .. ":" .. fRound(k.Value, 2)) end
		return "[" .. table.concat(out, " ") .. "]"
	elseif t == "ColorSequence" then
		local out = {}
		for _, k in v.Keypoints do table.insert(out, fRound(k.Time, 2) .. ":" .. fHex(k.Value)) end
		return "[" .. table.concat(out, " ") .. "]"
	elseif t == "Font" then
		local ok, s = pcall(function() return string.match(v.Family, "([^/]+)%.json$") .. " " .. v.Weight.Name end)
		return if ok then s else tostring(v)
	end
	return tostring(v)
end
local function fColor(v)
	if typeof(v) == "Color3" then return v end
	if type(v) == "string" then
		local h = string.gsub(v, "^#", "")
		if #h == 6 and tonumber(h, 16) then
			return Color3.fromRGB(tonumber(string.sub(h, 1, 2), 16), tonumber(string.sub(h, 3, 4), 16), tonumber(string.sub(h, 5, 6), 16))
		end
		return BrickColor.new(v).Color
	end
	if type(v) == "table" then
		if v[1] > 1 or v[2] > 1 or v[3] > 1 then return Color3.fromRGB(v[1], v[2], v[3]) end
		return Color3.new(v[1], v[2], v[3])
	end
	error("not a color: " .. tostring(v), 0)
end
local function fCFrame(v)
	if typeof(v) == "CFrame" then return v end
	if type(v) == "table" and v.pos then
		local cf = CFrame.new(v.pos[1], v.pos[2], v.pos[3])
		if v.rot then cf *= CFrame.Angles(math.rad(v.rot[1]), math.rad(v.rot[2]), math.rad(v.rot[3])) end
		return cf
	end
	if type(v) == "table" and #v >= 3 then
		local cf = CFrame.new(v[1], v[2], v[3])
		if #v >= 6 then cf *= CFrame.Angles(math.rad(v[4]), math.rad(v[5]), math.rad(v[6])) end
		return cf
	end
	error("not a CFrame: use {pos={x,y,z}, rot={rx,ry,rz}} or [x,y,z]", 0)
end
local function fNumSeq(v)
	if type(v) == "number" then return NumberSequence.new(v) end
	if #v == 2 and type(v[1]) == "number" then return NumberSequence.new(v[1], v[2]) end
	local kps = {}
	for _, k in v do table.insert(kps, NumberSequenceKeypoint.new(k[1], k[2], k[3] or 0)) end
	return NumberSequence.new(kps)
end
local function fColorSeq(v)
	if type(v) == "string" then return ColorSequence.new(fColor(v)) end
	if #v == 2 and type(v[1]) ~= "table" then return ColorSequence.new(fColor(v[1]), fColor(v[2])) end
	local kps = {}
	for _, k in v do table.insert(kps, ColorSequenceKeypoint.new(k[1], fColor(k[2]))) end
	return ColorSequence.new(kps)
end
-- Convert a JSON value to the type the property already has.
local function fValue(current, v)
	if v == FORGE_NULL then return nil end
	if type(v) == "string" and string.sub(v, 1, 1) == "@" then return fPath(if v == "@selection" then v else string.sub(v, 2)) end
	local t = typeof(current)
	if t == "number" or t == "boolean" or t == "string" then return v
	elseif t == "Vector3" then return Vector3.new(v[1], v[2], v[3])
	elseif t == "Vector2" then return Vector2.new(v[1], v[2])
	elseif t == "Color3" then return fColor(v)
	elseif t == "BrickColor" then
		if type(v) == "string" and string.sub(v, 1, 1) ~= "#" then return BrickColor.new(v) end
		return BrickColor.new(fColor(v))
	elseif t == "CFrame" then return fCFrame(v)
	elseif t == "UDim2" then return UDim2.new(v[1], v[2], v[3], v[4])
	elseif t == "UDim" then return UDim.new(v[1], v[2])
	elseif t == "NumberRange" then
		if type(v) == "number" then return NumberRange.new(v) end
		return NumberRange.new(v[1], v[2] or v[1])
	elseif t == "NumberSequence" then return fNumSeq(v)
	elseif t == "ColorSequence" then return fColorSeq(v)
	elseif t == "Rect" then return Rect.new(v[1], v[2], v[3], v[4])
	elseif t == "EnumItem" then
		if typeof(v) == "EnumItem" then return v end
		local name = string.match(tostring(v), "([^%.]+)$")
		local ok, item = pcall(function() return current.EnumType[name] end)
		if ok and item then return item end
		return name
	elseif t == "Font" then
		if type(v) == "string" then
			local ok, f = pcall(function() return Font.fromName(v) end)
			if ok and f then return f end
			return Font.new(v)
		end
		return Font.new(v.family, Enum.FontWeight[v.weight or "Regular"], Enum.FontStyle[v.style or "Normal"])
	end
	return v
end
-- When the current value can't be read, go by the JSON shape.
local function fGuess(v)
	if v == FORGE_NULL then return nil end
	if type(v) == "string" and string.match(v, "^#%x%x%x%x%x%x$") then return fColor(v) end
	if type(v) == "string" and string.sub(v, 1, 1) == "@" then return fPath(if v == "@selection" then v else string.sub(v, 2)) end
	if type(v) == "table" and #v == 3 and type(v[1]) == "number" then return Vector3.new(v[1], v[2], v[3]) end
	return v
end
local function fPivot(inst)
	local ok, cf = pcall(function() return inst:GetPivot() end)
	if ok and cf then return cf end
	if inst:IsA("BasePart") then return inst.CFrame end
	local part = inst:FindFirstChildWhichIsA("BasePart", true)
	return if part then part.CFrame else CFrame.new()
end
local function fPivotTo(inst, cf)
	if inst:IsA("BasePart") then
		inst.CFrame = cf
		return
	end
	local ok = pcall(function() inst:PivotTo(cf) end)
	if ok then return end
	-- Fallback: move every part by the same transform.
	local delta = cf * fPivot(inst):Inverse()
	for _, d in inst:GetDescendants() do
		if d:IsA("BasePart") then d.CFrame = delta * d.CFrame end
	end
end
-- Pseudo properties: Pivot (move), Tags, Attributes, Parent (path).
local function fSet(inst, props)
	local errs = nil
	local pivot = nil
	for k, v in props do
		local ok, err = pcall(function()
			if k == "Pivot" then
				pivot = fCFrame(v)
			elseif k == "Tags" then
				for _, tag in inst:GetTags() do inst:RemoveTag(tag) end
				for _, tag in v do inst:AddTag(tag) end
			elseif k == "Attributes" then
				for ak, av in v do
					if av == FORGE_NULL then inst:SetAttribute(ak, nil)
					elseif type(av) == "table" and #av == 3 then inst:SetAttribute(ak, Vector3.new(av[1], av[2], av[3]))
					elseif type(av) == "string" and string.match(av, "^#%x%x%x%x%x%x$") then inst:SetAttribute(ak, fColor(av))
					else inst:SetAttribute(ak, av) end
				end
			elseif k == "Parent" then
				inst.Parent = fPath(v)
			elseif (k == "Position" or k == "Orientation") and inst:IsA("BasePart") then
				-- Through CFrame, keeping the other half of it.
				local cf = inst.CFrame
				if k == "Position" then
					inst.CFrame = CFrame.new(v[1], v[2], v[3]) * (cf - cf.Position)
				else
					inst.CFrame = CFrame.new(cf.Position) * CFrame.fromOrientation(math.rad(v[1]), math.rad(v[2]), math.rad(v[3]))
				end
			else
				local okCur, cur = pcall(function() return inst[k] end)
				inst[k] = if okCur then fValue(cur, v) else fGuess(v)
			end
		end)
		if not ok then
			errs = errs or {}
			table.insert(errs, k .. ": " .. tostring(err))
		end
	end
	if pivot then fPivotTo(inst, pivot) end
	return errs
end
local function fMatcher(q)
	local plain = q.name and not string.find(q.name, "[%^%$%*%+%?%[%]%%]")
	local lname = q.name and string.lower(q.name)
	return function(inst)
		if q.class and not inst:IsA(q.class) then return false end
		if q.name then
			if plain then
				if not string.find(string.lower(inst.Name), lname, 1, true) then return false end
			elseif not string.find(inst.Name, q.name) then
				return false
			end
		end
		if q.tag and not inst:HasTag(q.tag) then return false end
		if q.attr and inst:GetAttribute(q.attr) == nil then return false end
		return true
	end
end
-- Calls fn on every match (up to limit); returns the number of matches. Path "@selection"
-- searches the selected instances themselves and everything inside them.
local function fFind(q, limit, fn)
	local match = fMatcher(q)
	local count = 0
	local seen = {}
	local function visit(inst, root)
		if seen[inst] or not match(inst) then return end
		seen[inst] = true
		count += 1
		if count <= limit then fn(inst, root) end
	end
	local function scan(root, nameRoot)
		if not q.depth then
			for _, inst in root:GetDescendants() do visit(inst, nameRoot) end
		else
			local function walk(node, depth)
				for _, child in node:GetChildren() do
					visit(child, nameRoot)
					if depth < q.depth then walk(child, depth + 1) end
				end
			end
			walk(root, 1)
		end
	end
	if q.path == "@selection" then
		for _, root in fSelection() do
			visit(root, game)
			scan(root, game)
		end
		return count, game
	end
	local root = fPath(q.path or "Workspace")
	scan(root, root)
	return count, root
end
-- Instances an op works on: path ("@selection" = everything selected), paths, or a query.
local function fTargets(o)
	if o.path == "@selection" then return fSelection() end
	if o.path then return { fPath(o.path) } end
	if o.paths then
		local list = {}
		for _, p in o.paths do
			if p == "@selection" then
				for _, inst in fSelection() do table.insert(list, inst) end
			else
				table.insert(list, fPath(p))
			end
		end
		return list
	end
	if o.query then
		local list = {}
		fFind(o.query, 5000, function(inst) table.insert(list, inst) end)
		return list
	end
	error("give path, paths or query", 0)
end
-- World-space box of a part or a model/folder (rotation-aware fallback where GetBoundingBox is missing).
local function fBounds(inst)
	if inst:IsA("BasePart") then return inst.CFrame, inst.Size end
	local ok, cf, size = pcall(function() return inst:GetBoundingBox() end)
	if ok and cf then return cf, size end
	local lo, hi = nil, nil
	for _, d in inst:GetDescendants() do
		if d:IsA("BasePart") then
			local c, h = d.CFrame, d.Size / 2
			for _, sx in { -1, 1 } do
				for _, sy in { -1, 1 } do
					for _, sz in { -1, 1 } do
						local p = c * Vector3.new(h.X * sx, h.Y * sy, h.Z * sz)
						lo = if lo then Vector3.new(math.min(lo.X, p.X), math.min(lo.Y, p.Y), math.min(lo.Z, p.Z)) else p
						hi = if hi then Vector3.new(math.max(hi.X, p.X), math.max(hi.Y, p.Y), math.max(hi.Z, p.Z)) else p
					end
				end
			end
		end
	end
	if not lo then return fPivot(inst), Vector3.new(0, 0, 0) end
	return CFrame.new((lo + hi) / 2), hi - lo
end
local fEditor = nil
pcall(function() fEditor = game:GetService("ScriptEditorService") end)
-- A script's source as the editor has it (unsaved edits included).
local function fSource(s)
	if fEditor then
		local ok, src = pcall(function() return fEditor:GetEditorSource(s) end)
		if ok and type(src) == "string" then return src end
	end
	return s.Source
end
local function fLineCount(src)
	local _, n = string.gsub(src, "\n", "")
	return n + 1
end
local function fCounts(list)
	local counts, order = {}, {}
	for _, inst in list do
		if not counts[inst.ClassName] then table.insert(order, inst.ClassName) end
		counts[inst.ClassName] = (counts[inst.ClassName] or 0) + 1
	end
	table.sort(order, function(a, b) return counts[a] > counts[b] end)
	local out = {}
	for i, c in order do
		if i > 4 then
			table.insert(out, "…")
			break
		end
		table.insert(out, c .. "×" .. counts[c])
	end
	return table.concat(out, ", ")
end
`;

function chunk(body: string, label?: string): string {
  const history = label
    ? `local fHistory, fRecording = nil, nil
pcall(function()
	fHistory = game:GetService("ChangeHistoryService")
	fRecording = fHistory:TryBeginRecording(${luaString(label)})
end)
local function fFinish(ok)
	if fRecording then
		pcall(function()
			fHistory:FinishRecording(fRecording, if ok then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel)
		end)
	end
end`
    : "local function fFinish() end";
  return `${OPS_RUNTIME}
${history}
local ok, result = pcall(function()
${body}
end)
fFinish(ok)
if not ok then return "error: " .. tostring(result) end
return result
`;
}

// ---------------------------------------------------------------------------
// studio_query

export interface QueryInput {
  path?: string;
  class?: string;
  name?: string;
  tag?: string;
  attr?: string;
  depth?: number;
  props?: string[];
  limit?: number;
  tree?: boolean;
}

export function queryLuau(q: QueryInput): string {
  const limit = Math.min(500, q.limit ?? (q.tree ? 300 : 60));
  if (q.tree) {
    const depth = Math.min(8, q.depth ?? 2);
    return chunk(`
	local root = fPath(${toLua(q.path ?? "Workspace")})
	local lines = { root:GetFullName() .. " [" .. root.ClassName .. "]" }
	local budget = ${limit}
	local function walk(node, depth, indent)
		local children = node:GetChildren()
		for i, child in children do
			if budget <= 0 then
				table.insert(lines, indent .. "… " .. (#children - i + 1) .. " more: " .. fCounts(table.move(children, i, #children, 1, {})))
				return
			end
			budget -= 1
			local n = #child:GetChildren()
			local line = indent .. child.Name .. " [" .. child.ClassName .. "]"
			if n > 0 and depth >= ${depth} then
				line ..= " (" .. #child:GetDescendants() .. " inside: " .. fCounts(child:GetChildren()) .. ")"
			end
			table.insert(lines, line)
			if n > 0 and depth < ${depth} then walk(child, depth + 1, indent .. "  ") end
		end
	end
	walk(root, 1, "  ")
	return table.concat(lines, "\\n")`);
  }
  return chunk(`
	local q = ${toLua({ path: q.path, class: q.class, name: q.name, tag: q.tag, attr: q.attr, depth: q.depth })}
	local props = ${toLua(q.props ?? [])}
	local lines = {}
	local total, root = fFind(q, ${limit}, function(inst, root)
		local line = fName(inst, root) .. " [" .. inst.ClassName .. "]"
		for _, p in props do
			local ok, v = pcall(function()
				if p == "Pivot" then return fPivot(inst) end
				if p == "Tags" then return table.concat(inst:GetTags(), ",") end
				if p == "Attributes" then
					local out = {}
					for k, a in inst:GetAttributes() do table.insert(out, k .. "=" .. fFmt(a)) end
					return table.concat(out, ";")
				end
				if p == "Children" then return #inst:GetChildren() end
				if p == "Position" and inst:IsA("BasePart") then return inst.CFrame.Position end
				if p == "Bounds" then
					local cf, size = fBounds(inst)
					return { raw = fFmt(size) .. " at " .. fFmt(cf.Position) }
				end
				if p == "Parts" then
					local n = if inst:IsA("BasePart") then 1 else 0
					for _, d in inst:GetDescendants() do
						if d:IsA("BasePart") then n += 1 end
					end
					return n
				end
				if p == "Lines" then return fLineCount(fSource(inst)) end
				return inst[p]
			end)
			if ok and v ~= "" then line ..= " " .. p .. "=" .. (if type(v) == "table" and v.raw then v.raw else fFmt(v)) end
		end
		table.insert(lines, line)
	end)
	local head = if root == game then "" else "in " .. root:GetFullName() .. ": "
	if total == 0 then return head .. "no matches" end
	local more = if total > ${limit} then "\\n… " .. (total - ${limit}) .. " more (narrow the query or raise limit)" else ""
	return head .. total .. " match" .. (if total == 1 then "" else "es") .. "\\n" .. table.concat(lines, "\\n") .. more`);
}

// ---------------------------------------------------------------------------
// studio_edit: batched changes in one undo step

export type EditOp =
  | { op: "set"; path?: string; query?: QueryInput; props: Record<string, unknown> }
  | { op: "create"; class: string; parent?: string; name?: string; props?: Record<string, unknown>; children?: CreateSpec[] }
  | { op: "delete"; path?: string; query?: QueryInput }
  | { op: "clone"; path: string; parent?: string; name?: string; count?: number; offset?: number[] }
  | { op: "move"; path?: string; query?: QueryInput; by?: number[]; rotate?: number[]; to?: unknown; parent?: string }
  | { op: "select"; paths?: string[]; path?: string; query?: QueryInput }
  | { op: "group"; path?: string; paths?: string[]; query?: QueryInput; name?: string; parent?: string; class?: "Model" | "Folder" }
  | { op: "ungroup"; path?: string; paths?: string[]; query?: QueryInput }
  | { op: "weld"; path?: string; paths?: string[]; query?: QueryInput; to?: string; unanchor?: boolean }
  | { op: "scale"; path?: string; paths?: string[]; query?: QueryInput; factor: number }
  | { op: "focus"; path?: string }
  | { op: "insert"; assetId: number | string; parent?: string; at?: number[] };

export interface CreateSpec {
  class: string;
  name?: string;
  props?: Record<string, unknown>;
  children?: CreateSpec[];
}

export function editLuau(ops: EditOp[]): string {
  return chunk(`
	local OPS = ${toLua(ops)}
	local report = {}
	-- What ends up selected: a select op's targets, else everything created or changed.
	local selected, explicit = {}, nil
	local changed, failed = 0, 0
	local targets = fTargets
	local function create(spec, parent)
		local inst = Instance.new(spec.class)
		if spec.name then inst.Name = spec.name end
		local props = spec.props or {}
		-- Parts built by Claude stay where they are put unless told otherwise.
		if inst:IsA("BasePart") and props.Anchored == nil then inst.Anchored = true end
		local pivot = props.Pivot
		props.Pivot = nil
		local errs = fSet(inst, props)
		for _, child in spec.children or {} do create(child, inst) end
		if pivot then fPivotTo(inst, fCFrame(pivot)) end
		inst.Parent = parent
		return inst, errs
	end
	for i, o in OPS do
		local ok, err = pcall(function()
			if o.op == "set" then
				local list = targets(o)
				local errs = nil
				for _, inst in list do
					errs = fSet(inst, o.props) or errs
					changed += 1
				end
				table.insert(report, i .. " set " .. #list .. (if errs then " (" .. table.concat(errs, "; ") .. ")" else ""))
			elseif o.op == "create" then
				local inst, errs = create(o, fPath(o.parent or "Workspace"))
				changed += 1
				table.insert(selected, inst)
				table.insert(report, i .. " created " .. inst:GetFullName() .. (if errs then " (" .. table.concat(errs, "; ") .. ")" else ""))
			elseif o.op == "delete" then
				local list = targets(o)
				for _, inst in list do inst.Parent = nil end
				changed += #list
				table.insert(report, i .. " deleted " .. #list)
			elseif o.op == "clone" then
				local source = fPath(o.path)
				local parent = if o.parent then fPath(o.parent) else source.Parent
				local count = math.clamp(o.count or 1, 1, 500)
				local base = fPivot(source)
				local names = {}
				for n = 1, count do
					local copy = source:Clone()
					if o.name then copy.Name = if count > 1 then o.name .. n else o.name end
					if o.offset then
						fPivotTo(copy, CFrame.new(o.offset[1] * n, o.offset[2] * n, o.offset[3] * n) * base)
					end
					copy.Parent = parent
					table.insert(selected, copy)
					if n <= 3 then table.insert(names, copy:GetFullName()) end
				end
				changed += count
				table.insert(report, i .. " cloned " .. count .. ": " .. table.concat(names, ", ") .. (if count > 3 then ", …" else ""))
			elseif o.op == "move" then
				local list = targets(o)
				for _, inst in list do
					if o.parent then inst.Parent = fPath(o.parent) end
					if o.to then fPivotTo(inst, fCFrame(o.to)) end
					if o.by or o.rotate then
						local cf = fPivot(inst)
						local by = o.by or { 0, 0, 0 }
						local r = o.rotate or { 0, 0, 0 }
						local rot = CFrame.Angles(math.rad(r[1]), math.rad(r[2]), math.rad(r[3]))
						fPivotTo(inst, CFrame.new(by[1], by[2], by[3]) * CFrame.new(cf.Position) * rot * (cf - cf.Position))
					end
				end
				changed += #list
				table.insert(report, i .. " moved " .. #list)
			elseif o.op == "select" then
				local list = targets(o)
				explicit = explicit or {}
				for _, inst in list do table.insert(explicit, inst) end
				table.insert(report, i .. " selected " .. #list)
			elseif o.op == "group" then
				local list = targets(o)
				if #list == 0 then error("nothing to group", 0) end
				local g = Instance.new(o.class or "Model")
				g.Name = o.name or "Group"
				g.Parent = if o.parent then fPath(o.parent) else list[1].Parent
				for _, inst in list do inst.Parent = g end
				changed += #list + 1
				table.insert(selected, g)
				table.insert(report, i .. " grouped " .. #list .. " into " .. g:GetFullName())
			elseif o.op == "ungroup" then
				local n = 0
				for _, g in targets(o) do
					for _, child in g:GetChildren() do
						child.Parent = g.Parent
						table.insert(selected, child)
						n += 1
					end
					g.Parent = nil
				end
				changed += n
				table.insert(report, i .. " ungrouped " .. n)
			elseif o.op == "weld" then
				-- Weld every part of each target to one root part, so it moves as one body.
				local made, roots = 0, {}
				for _, inst in targets(o) do
					local parts = {}
					if inst:IsA("BasePart") then table.insert(parts, inst) end
					for _, d in inst:GetDescendants() do
						if d:IsA("BasePart") then table.insert(parts, d) end
					end
					if #parts == 0 then continue end
					local root = if o.to then fPath(o.to) else nil
					if not root and inst:IsA("Model") then root = inst.PrimaryPart end
					if not root then
						root = parts[1]
						for _, p in parts do
							if p.Size.X * p.Size.Y * p.Size.Z > root.Size.X * root.Size.Y * root.Size.Z then root = p end
						end
					end
					for _, p in parts do
						if p ~= root then
							local existing = p:FindFirstChild("ForgeWeld")
							if not (existing and existing.Part0 == root) then
								local w = Instance.new("WeldConstraint")
								w.Name = "ForgeWeld"
								w.Part0 = root
								w.Part1 = p
								w.Parent = p
								made += 1
							end
						end
						if o.unanchor then p.Anchored = false end
					end
					if inst:IsA("Model") and not inst.PrimaryPart and root:IsDescendantOf(inst) then inst.PrimaryPart = root end
					table.insert(roots, root:GetFullName())
				end
				changed += made
				table.insert(report, i .. " welded " .. made .. " parts to " .. (if #roots > 0 then table.concat(roots, ", ", 1, math.min(3, #roots)) else "nothing") .. (if o.unanchor then " (unanchored)" else ""))
			elseif o.op == "scale" then
				local f = o.factor
				if type(f) ~= "number" or f <= 0 then error("factor must be a positive number", 0) end
				local list = targets(o)
				for _, inst in list do
					local done = inst:IsA("Model") and pcall(function() inst:ScaleTo(inst:GetScale() * f) end)
					if not done then
						-- Scale parts (and meshes, attachments) about the pivot.
						local pivot = fPivot(inst)
						local all = inst:GetDescendants()
						table.insert(all, inst)
						for _, d in all do
							if d:IsA("BasePart") then
								local rel = pivot:ToObjectSpace(d.CFrame)
								d.Size *= f
								d.CFrame = pivot * (rel - rel.Position + rel.Position * f)
							elseif d:IsA("SpecialMesh") then
								d.Scale *= f
							elseif d:IsA("Attachment") then
								d.CFrame = d.CFrame - d.CFrame.Position + d.CFrame.Position * f
							end
						end
					end
				end
				changed += #list
				table.insert(report, i .. " scaled " .. #list .. " by " .. f)
			elseif o.op == "focus" then
				local inst = fPath(o.path or "@selection")
				local cf, size = fBounds(inst)
				local cam = workspace.CurrentCamera
				local dist = math.max(size.Magnitude * 1.1, 8)
				local center = cf.Position
				cam.CFrame = CFrame.lookAt(center - cam.CFrame.LookVector * dist, center)
				pcall(function() cam.Focus = CFrame.new(center) end)
				table.insert(selected, inst)
				table.insert(report, i .. " camera on " .. inst:GetFullName())
			elseif o.op == "insert" then
				-- A model from the Creator Store / your inventory by asset id.
				local idText = string.match(tostring(o.assetId or ""), "%d+")
				if not idText then error("give assetId", 0) end
				local okGet, objects = pcall(function() return game:GetObjects("rbxassetid://" .. idText) end)
				if not okGet or #objects == 0 then
					local model = game:GetService("InsertService"):LoadAsset(tonumber(idText))
					objects = model:GetChildren()
				end
				local parent = fPath(o.parent or "Workspace")
				-- Placed on the ground at "at", or where the camera looks.
				local at = if o.at then Vector3.new(o.at[1], o.at[2], o.at[3]) else nil
				if not at then
					pcall(function()
						local cam = workspace.CurrentCamera.CFrame
						local hit = workspace:Raycast(cam.Position, cam.LookVector * 1000)
						at = if hit then hit.Position else cam.Position + cam.LookVector * 30
					end)
				end
				local scriptCount, names = 0, {}
				for _, obj in objects do
					obj.Parent = parent
					if at and (obj:IsA("PVInstance")) then
						local okB, cf, size = pcall(fBounds, obj)
						if okB then
							local bottom = cf.Position - Vector3.new(0, size.Y / 2, 0)
							fPivotTo(obj, fPivot(obj) + (at - bottom))
						end
					end
					for _, d in obj:GetDescendants() do
						if d:IsA("LuaSourceContainer") then scriptCount += 1 end
					end
					table.insert(selected, obj)
					table.insert(names, obj:GetFullName())
				end
				changed += #objects
				table.insert(report, i .. " inserted " .. table.concat(names, ", ") .. (if scriptCount > 0 then " (contains " .. scriptCount .. " scripts: check them before play-testing)" else ""))
			else
				error("unknown op " .. tostring(o.op), 0)
			end
		end)
		if not ok then
			failed += 1
			table.insert(report, i .. " FAILED " .. o.op .. ": " .. tostring(err))
		end
	end
	if explicit or #selected > 0 then
		pcall(function() game:GetService("Selection"):Set(explicit or selected) end)
	end
	return (if failed > 0 then failed .. " of " .. #OPS .. " ops failed" else "ok") .. " · " .. changed .. " instances changed (one undo step)\\n" .. table.concat(report, "\\n")`, "Forge: edit");
}

// ---------------------------------------------------------------------------
// studio_scripts: search sources across the place, or list scripts

export interface ScriptSearchInput {
  pattern?: string;
  regex?: boolean;
  path?: string;
  limit?: number;
  context?: number;
}

export function scriptSearchLuau(q: ScriptSearchInput): string {
  const limit = Math.min(300, q.limit ?? 60);
  return chunk(`
	local root = fPath(${toLua(q.path ?? "game")})
	local pattern = ${toLua(q.pattern ?? "")}
	local plain = ${!q.regex}
	local ctx = ${Math.min(3, q.context ?? 0)}
	local lines, scripts, hits = {}, 0, 0
	local list = root:GetDescendants()
	if root:IsA("LuaSourceContainer") then list = { root } end
	for _, s in list do
		if not s:IsA("LuaSourceContainer") then continue end
		local src = fSource(s)
		scripts += 1
		local name = s:GetFullName()
		if pattern == "" then
			if scripts <= ${limit} then
				table.insert(lines, name .. " [" .. s.ClassName .. "] " .. fLineCount(src) .. " lines" .. (if s:IsA("BaseScript") and pcall(function() return s.Enabled end) and not s.Enabled then " (disabled)" else ""))
			end
		else
			local all = string.split(src, "\\n")
			for i, line in all do
				local needle = if plain then string.lower(pattern) else pattern
				local hay = if plain then string.lower(line) else line
				if string.find(hay, needle, 1, plain) then
					hits += 1
					if hits <= ${limit} then
						for j = math.max(1, i - ctx), math.min(#all, i + ctx) do
							local text = string.gsub(all[j], "^%s+", "")
							if #text > 160 then text = string.sub(text, 1, 157) .. "..." end
							table.insert(lines, name .. ":" .. j .. (if j == i then ": " else "- ") .. text)
						end
					end
				end
			end
		end
	end
	if pattern == "" then
		return scripts .. " scripts" .. (if scripts > ${limit} then " (first ${limit})" else "") .. "\\n" .. table.concat(lines, "\\n")
	end
	if hits == 0 then return "no matches in " .. scripts .. " scripts" end
	return hits .. " matches in " .. scripts .. " scripts" .. (if hits > ${limit} then " (first ${limit})" else "") .. "\\n" .. table.concat(lines, "\\n")`);
}

// ---------------------------------------------------------------------------
// studio_scripts read: numbered lines of one or more scripts (or line ranges)

export interface ScriptRead {
  path: string;
  from?: number;
  to?: number;
}

/** "ServerScriptService.Main" or "ServerScriptService.Main:10-40" (also ":10" and ":10-"). */
export function parseScriptRead(entry: string): ScriptRead {
  const m = entry.trim().match(/^(.*?)(?::(\d+)(?:-(\d*))?)?$/)!;
  const from = m[2] ? Number(m[2]) : undefined;
  const to = m[3] ? Number(m[3]) : m[2] && m[3] === undefined ? from : undefined;
  return { path: m[1], ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}

export function scriptReadLuau(reads: ScriptRead[], maxLines = 1500): string {
  return chunk(`
	local READS = ${toLua(reads)}
	local out = {}
	local budget = ${maxLines}
	for _, r in READS do
		local ok, err = pcall(function()
			local s = fPath(r.path)
			if not s:IsA("LuaSourceContainer") then error(s:GetFullName() .. " is a " .. s.ClassName .. ", not a script", 0) end
			local all = string.split(fSource(s), "\\n")
			local from = math.clamp(r.from or 1, 1, #all)
			local want = math.min(#all, r.to or #all)
			local to = math.min(want, from + budget - 1)
			table.insert(out, "== " .. s:GetFullName() .. " [" .. s.ClassName .. "] lines " .. from .. "-" .. to .. " of " .. #all)
			for i = from, to do table.insert(out, i .. "\\t" .. all[i]) end
			budget -= to - from + 1
			if to < want then table.insert(out, "… stopped at line " .. to .. ": read " .. s:GetFullName() .. ":" .. (to + 1) .. "-" .. want .. " for more") end
		end)
		if not ok then table.insert(out, "== " .. tostring(r.path) .. ": " .. tostring(err)) end
	end
	return table.concat(out, "\\n")`);
}

// ---------------------------------------------------------------------------
// studio_script_patch: exact find/replace edits (or a full new source) for several scripts

export interface ScriptPatch {
  path: string;
  edits?: { old: string; new: string; all?: boolean }[];
  source?: string;
  class?: "Script" | "LocalScript" | "ModuleScript";
}

export function scriptPatchLuau(patches: ScriptPatch[]): string {
  return chunk(`
	local PATCHES = ${toLua(patches)}
	local report, failed = {}, 0
	local function lineAt(src, pos)
		local _, n = string.gsub(string.sub(src, 1, pos - 1), "\\n", "")
		return n + 1
	end
	local function write(s, src)
		local ok = fEditor ~= nil and pcall(function()
			fEditor:UpdateSourceAsync(s, function() return src end)
		end)
		if not ok then s.Source = src end
	end
	for i, p in PATCHES do
		local ok, err = pcall(function()
			local found, s = pcall(fPath, p.path)
			local created = false
			if not found then
				if not p.source then error(s, 0) end
				local parentPath, name = string.match(p.path, "^(.*)%.([^%.]+)$")
				if not parentPath then error("give the full path, e.g. ServerScriptService.Main", 0) end
				s = Instance.new(p.class or "Script")
				s.Name = name
				s.Parent = fPath(parentPath)
				created = true
			end
			if not s:IsA("LuaSourceContainer") then error(s:GetFullName() .. " is a " .. s.ClassName .. ", not a script", 0) end
			local src = fSource(s)
			local new = if p.source then p.source else src
			local at = {}
			for j, e in p.edits or {} do
				if e.old == "" then error("edit " .. j .. ": old is empty", 0) end
				local hits, pos = {}, 1
				while true do
					local a, b = string.find(new, e.old, pos, true)
					if not a then break end
					table.insert(hits, a)
					pos = b + 1
				end
				if #hits == 0 then
					local first = string.match(e.old, "^%s*([^\\n]-)%s*\\n") or string.match(e.old, "^%s*(.-)%s*$")
					local hint = ""
					if first and #first > 3 then
						local a = string.find(new, first, 1, true)
						if a then hint = " (its first line is at line " .. lineAt(new, a) .. ": check whitespace and the lines after it)" end
					end
					error("edit " .. j .. ": old text not found" .. hint, 0)
				end
				if #hits > 1 and not e.all then error("edit " .. j .. ": old text is found " .. #hits .. " times; include more surrounding text or set all", 0) end
				table.insert(at, lineAt(new, hits[1]))
				local parts, last = {}, 1
				for _, a in hits do
					table.insert(parts, string.sub(new, last, a - 1))
					table.insert(parts, e.new)
					last = a + #e.old
				end
				table.insert(parts, string.sub(new, last))
				new = table.concat(parts)
			end
			if new == src and not created then
				table.insert(report, i .. " " .. s:GetFullName() .. ": unchanged")
				return
			end
			write(s, new)
			local what = if created then "created" elseif p.source then "replaced" else #(p.edits or {}) .. " edit" .. (if #(p.edits or {}) == 1 then "" else "s") .. " at line " .. table.concat(at, ", ")
			table.insert(report, i .. " " .. s:GetFullName() .. ": " .. what .. " (" .. fLineCount(src) .. " → " .. fLineCount(new) .. " lines)")
		end)
		if not ok then
			failed += 1
			table.insert(report, i .. " FAILED " .. tostring(p.path) .. ": " .. tostring(err))
		end
	end
	return (if failed > 0 then failed .. " of " .. #PATCHES .. " scripts failed (the others were saved)" else "ok") .. "\\n" .. table.concat(report, "\\n")`, "Forge: script edit");
}

// ---------------------------------------------------------------------------
// studio_audit: what will break or slow the game, in one pass over the place

/** Deprecated or risky script patterns: [Lua pattern, what to say]. */
const SCRIPT_SMELLS: [string, string][] = [
  ["[^%.:%w_]wait%(", "wait() is deprecated: use task.wait()"],
  ["[^%.:%w_]spawn%(", "spawn() is deprecated: use task.spawn()"],
  ["[^%.:%w_]delay%(", "delay() is deprecated: use task.delay()"],
  [":connect%(", ":connect() is deprecated: use :Connect()"],
  [":remove%(%)", ":remove() is deprecated: use :Destroy()"],
  ["Instance%.new%(%s*[\"'][%w_]+[\"']%s*,", "Instance.new(class, parent) is slow: set Parent last"],
  ["Body[GVPAFT]%w*[\"']", "BodyMovers (BodyVelocity, BodyGyro…) are deprecated: use LinearVelocity / AlignOrientation / VectorForce"],
  ["%.Velocity%s*=", "part.Velocity is deprecated: use AssemblyLinearVelocity"],
];

export function auditLuau(path = "game"): string {
  return chunk(`
	local root = fPath(${toLua(path)})
	local ws = workspace
	local SMELLS = ${toLua(SCRIPT_SMELLS)}
	local fallHeight = -500
	pcall(function() fallHeight = ws.FallenPartsDestroyHeight end)
	local groups = {}
	local function add(key, inst, extra)
		local g = groups[key]
		if not g then
			g = { n = 0, list = {} }
			groups[key] = g
		end
		g.n += 1
		if #g.list < 4 then table.insert(g.list, inst:GetFullName() .. (extra or "")) end
	end
	local function inCharacter(inst)
		local m = inst:FindFirstAncestorWhichIsA("Model")
		while m do
			if m:FindFirstChildWhichIsA("Humanoid") then return true end
			m = m:FindFirstAncestorWhichIsA("Model")
		end
		return false
	end
	-- Parts held by a weld, joint or constraint anywhere (checked after the pass; GetJoints when it exists).
	local jointed, loose = {}, {}
	local function holds(j)
		for _, k in { "Part0", "Part1" } do
			local ok, part = pcall(function() return j[k] end)
			if ok and part then jointed[part] = true end
		end
		for _, k in { "Attachment0", "Attachment1" } do
			local ok, a = pcall(function() return j[k] end)
			if ok and a and a.Parent then jointed[a.Parent] = true end
		end
	end
	local sss = game:GetService("ServerScriptService")
	local sps = nil
	pcall(function() sps = game:GetService("StarterPlayer"):FindFirstChild("StarterPlayerScripts") end)
	local parts, scripts, shadowLights, spawns = 0, 0, 0, 0
	local heavy, spots = {}, {}
	for _, d in root:GetDescendants() do
		if d:IsA("BasePart") then
			if d:IsDescendantOf(ws) then
				parts += 1
				local top = d
				while top.Parent and top.Parent ~= ws do top = top.Parent end
				if top ~= d then heavy[top] = (heavy[top] or 0) + 1 end
				if d:IsA("SpawnLocation") then spawns += 1 end
				pcall(function()
					local cf = d.CFrame
					if not d.Anchored then table.insert(loose, d) end
					if cf.Position.Y < fallHeight then add("fallen", d) end
					-- The same part twice in one spot: wasted and flickering (z-fighting).
					local p, sz = cf.Position, d.Size
					local key = d.ClassName .. string.format("%.2f,%.2f,%.2f|%.2f,%.2f,%.2f", p.X, p.Y, p.Z, sz.X, sz.Y, sz.Z)
					if spots[key] then add("dupe", d) else spots[key] = true end
					if d.Transparency >= 1 and d.CanCollide and not d:IsA("SpawnLocation") and d.Name ~= "HumanoidRootPart" then add("ghost", d) end
				end)
			end
		elseif d:IsA("JointInstance") or d:IsA("WeldConstraint") or d:IsA("Constraint") then
			holds(d)
		elseif d:IsA("Light") then
			pcall(function()
				if d.Shadows and d.Enabled then shadowLights += 1 end
			end)
		elseif d:IsA("LuaSourceContainer") then
			scripts += 1
			local okSrc, src = pcall(fSource, d)
			if not okSrc then src = "" end
			local runContext = "Legacy"
			pcall(function() runContext = d.RunContext.Name end)
			if d:IsA("LocalScript") then
				if d:IsDescendantOf(sss) or (d:IsDescendantOf(ws) and not d:FindFirstAncestorWhichIsA("Tool") and not inCharacter(d)) then add("deadLocal", d) end
			elseif d:IsA("Script") and runContext == "Legacy" then
				if sps and d:IsDescendantOf(sps) then add("deadServer", d) end
				local a = string.find(src, "LocalPlayer", 1, true)
				if a then
					local _, n = string.gsub(string.sub(src, 1, a), "\\n", "")
					add("serverLocalPlayer", d, ":" .. (n + 1))
				end
			end
			if src ~= "" then
				local lines = string.split(src, "\\n")
				for _, smell in SMELLS do
					for ln, line in lines do
						local code = string.gsub(line, "%-%-.*$", "")
						if string.find(" " .. code, smell[1]) then
							add("smell:" .. smell[2], d, ":" .. ln)
							break
						end
					end
				end
			end
		end
	end
	for _, part in loose do
		if not jointed[part] then
			local ok, joints = pcall(function() return part:GetJoints() end)
			if not (ok and #joints > 0) and not inCharacter(part) then add("loose", part) end
		end
	end
	local out = {}
	local streaming = "?"
	pcall(function() streaming = if ws.StreamingEnabled then "on" else "off" end)
	table.insert(out, "Audit of " .. (if root == game then "the place" else root:GetFullName()) .. ": " .. parts .. " parts in Workspace, " .. scripts .. " scripts, " .. shadowLights .. " shadow-casting lights, StreamingEnabled " .. streaming .. ".")
	local function section(title, rows)
		if #rows == 0 then return end
		table.insert(out, title)
		for _, r in rows do table.insert(out, "- " .. r) end
	end
	local function row(key, text)
		local g = groups[key]
		if not g then return nil end
		return text .. " (" .. g.n .. "): " .. table.concat(g.list, ", ") .. (if g.n > #g.list then ", …" else "")
	end
	local problems, warnings = {}, {}
	local function push(list, r) if r then table.insert(list, r) end end
	push(problems, row("loose", "unanchored parts with no joints (they fall at play: anchor or weld them)"))
	push(problems, row("fallen", "parts below FallenPartsDestroyHeight (deleted at play)"))
	push(problems, row("deadLocal", "LocalScripts that never run there (use StarterPlayerScripts, StarterGui or StarterCharacterScripts)"))
	push(problems, row("deadServer", "server Scripts in StarterPlayerScripts that never run (use a LocalScript)"))
	push(problems, row("serverLocalPlayer", "server Scripts using LocalPlayer (it is nil on the server)"))
	if root == game and spawns == 0 then table.insert(warnings, "no SpawnLocation: players spawn at the origin") end
	push(warnings, row("ghost", "invisible parts that still collide"))
	push(warnings, row("dupe", "duplicate parts in the same spot as another (flicker, wasted parts)"))
	if shadowLights > 40 then table.insert(warnings, shadowLights .. " lights cast shadows: turn Shadows off on small or decorative lights") end
	if streaming == "off" and parts > 20000 then table.insert(warnings, "big map with StreamingEnabled off: turn it on for faster joins and less memory") end
	local smellKeys = {}
	for key in groups do
		if string.sub(key, 1, 6) == "smell:" then table.insert(smellKeys, key) end
	end
	table.sort(smellKeys)
	for _, key in smellKeys do push(warnings, row(key, string.sub(key, 7))) end
	local tops = {}
	for inst, n in heavy do table.insert(tops, { inst = inst, n = n }) end
	table.sort(tops, function(a, b) return a.n > b.n end)
	local heavyRows = {}
	for k = 1, math.min(3, #tops) do
		if tops[k].n >= 300 then table.insert(heavyRows, tops[k].inst:GetFullName() .. " " .. tops[k].n .. " parts") end
	end
	if #heavyRows > 0 then table.insert(warnings, "heaviest: " .. table.concat(heavyRows, "; ")) end
	section("Problems:", problems)
	section("Warnings:", warnings)
	if #problems == 0 and #warnings == 0 then table.insert(out, "No problems found.") end
	return table.concat(out, "\\n")`);
}

// ---------------------------------------------------------------------------
// studio_lighting: presets plus overrides, effects created or updated under Lighting

export const LIGHTING_PRESETS = {
  day: {
    lighting: { ClockTime: 14, Brightness: 3, Ambient: "#5a5a5a", OutdoorAmbient: "#808080", EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 1, GlobalShadows: true },
    atmosphere: { Density: 0.3, Offset: 0.25, Color: "#c7d1d9", Decay: "#6a7a8a", Glare: 0, Haze: 0 },
    bloom: { Intensity: 0.5, Size: 24, Threshold: 2 },
    colorCorrection: { Brightness: 0, Contrast: 0.05, Saturation: 0.1, TintColor: "#ffffff" },
    sunRays: false,
  },
  sunset: {
    lighting: { ClockTime: 17.7, Brightness: 2, Ambient: "#4a3a3a", OutdoorAmbient: "#8a6a5a", EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 1, GlobalShadows: true },
    atmosphere: { Density: 0.35, Offset: 0.1, Color: "#ffb07a", Decay: "#7a4a6a", Glare: 0.6, Haze: 1.5 },
    bloom: { Intensity: 0.8, Size: 30, Threshold: 1.5 },
    colorCorrection: { Brightness: 0, Contrast: 0.08, Saturation: 0.15, TintColor: "#ffe6d0" },
    sunRays: { Intensity: 0.15, Spread: 0.8 },
  },
  night: {
    lighting: { ClockTime: 0, Brightness: 1, Ambient: "#20232e", OutdoorAmbient: "#3a4060", EnvironmentDiffuseScale: 0.6, EnvironmentSpecularScale: 0.6, GlobalShadows: true },
    atmosphere: { Density: 0.4, Offset: 0, Color: "#2a3350", Decay: "#101525", Glare: 0, Haze: 1 },
    bloom: { Intensity: 1, Size: 28, Threshold: 1 },
    colorCorrection: { Brightness: -0.03, Contrast: 0.1, Saturation: -0.05, TintColor: "#d6e0ff" },
    sunRays: false,
  },
  overcast: {
    lighting: { ClockTime: 13, Brightness: 1.5, Ambient: "#5a5e62", OutdoorAmbient: "#9aa0a6", EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 0.4, GlobalShadows: true },
    atmosphere: { Density: 0.45, Offset: 0.2, Color: "#b8bec4", Decay: "#8a9096", Glare: 0, Haze: 2.5 },
    bloom: { Intensity: 0.3, Size: 20, Threshold: 2.5 },
    colorCorrection: { Brightness: 0, Contrast: 0, Saturation: -0.2, TintColor: "#ffffff" },
    sunRays: false,
  },
  foggy: {
    lighting: { ClockTime: 9, Brightness: 1.6, Ambient: "#5c6166", OutdoorAmbient: "#9aa1a8", EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 0.5, GlobalShadows: true },
    atmosphere: { Density: 0.65, Offset: 0.4, Color: "#c9cfd4", Decay: "#a3a9ae", Glare: 0, Haze: 3 },
    bloom: { Intensity: 0.3, Size: 24, Threshold: 2 },
    colorCorrection: { Brightness: 0.02, Contrast: -0.05, Saturation: -0.15, TintColor: "#f4f8ff" },
    sunRays: false,
  },
  neon: {
    lighting: { ClockTime: 22, Brightness: 0.5, Ambient: "#2a2040", OutdoorAmbient: "#4a3a6a", EnvironmentDiffuseScale: 0.7, EnvironmentSpecularScale: 1, GlobalShadows: true },
    atmosphere: { Density: 0.35, Offset: 0, Color: "#5a3a8a", Decay: "#1a0a2a", Glare: 0, Haze: 1.2 },
    bloom: { Intensity: 1.3, Size: 32, Threshold: 0.9 },
    colorCorrection: { Brightness: 0, Contrast: 0.15, Saturation: 0.25, TintColor: "#f0e0ff" },
    sunRays: false,
  },
  spooky: {
    lighting: { ClockTime: 20.5, Brightness: 0.8, Ambient: "#1e261e", OutdoorAmbient: "#3a4a3a", EnvironmentDiffuseScale: 0.6, EnvironmentSpecularScale: 0.5, GlobalShadows: true },
    atmosphere: { Density: 0.55, Offset: 0.1, Color: "#4a5a4a", Decay: "#1a221a", Glare: 0, Haze: 2.5 },
    bloom: { Intensity: 0.6, Size: 24, Threshold: 1.5 },
    colorCorrection: { Brightness: -0.02, Contrast: 0.1, Saturation: -0.4, TintColor: "#d8ffe0" },
    sunRays: false,
  },
} as const;
export type LightingPreset = keyof typeof LIGHTING_PRESETS;

export interface LightingInput {
  preset?: LightingPreset;
  lighting?: Record<string, unknown>;
  atmosphere?: Record<string, unknown> | false;
  bloom?: Record<string, unknown> | false;
  colorCorrection?: Record<string, unknown> | false;
  sunRays?: Record<string, unknown> | false;
  depthOfField?: Record<string, unknown> | false;
}

export function lightingLuau(input: LightingInput): string {
  const p = input.preset ? LIGHTING_PRESETS[input.preset] : undefined;
  const pick = (k: "atmosphere" | "bloom" | "colorCorrection" | "sunRays") => {
    const own = input[k];
    if (own === false) return false;
    const base = p?.[k];
    if (own === undefined) return base ?? null;
    return { ...(base || {}), ...own };
  };
  const effects = {
    Atmosphere: pick("atmosphere"),
    BloomEffect: pick("bloom"),
    ColorCorrectionEffect: pick("colorCorrection"),
    SunRaysEffect: pick("sunRays"),
    DepthOfFieldEffect: input.depthOfField === undefined ? null : input.depthOfField,
  };
  return chunk(`
	local lighting = game:GetService("Lighting")
	local done = {}
	local errs = fSet(lighting, ${toLua({ ...(p?.lighting ?? {}), ...(input.lighting ?? {}) })})
	if errs then table.insert(done, "Lighting: " .. table.concat(errs, "; ")) end
	for className, props in ${toLua(effects)} do
		if props == FORGE_NULL then continue end
		local existing = lighting:FindFirstChildOfClass(className)
		if props == false then
			if existing then
				existing.Parent = nil
				table.insert(done, "removed " .. className)
			end
			continue
		end
		local inst = existing or Instance.new(className)
		local e = fSet(inst, props)
		inst.Parent = lighting
		table.insert(done, (if existing then "updated " else "added ") .. className .. (if e then " (" .. table.concat(e, "; ") .. ")" else ""))
	end
	local okRead, now = pcall(function() return ": ClockTime " .. fRound(lighting.ClockTime, 2) .. ", Brightness " .. fRound(lighting.Brightness, 2) end)
	return "Lighting ${input.preset ? `preset ${input.preset}` : "updated"}" .. (if okRead then now else "") .. (if #done > 0 then "; " .. table.concat(done, ", ") else "")`, "Forge: lighting");
}

// ---------------------------------------------------------------------------
// studio_terrain: fills, clears, material swaps and generated hills

export type TerrainOp =
  | { op: "block" | "wedge"; material: string; pos: number[]; size: number[]; rot?: number[] }
  | { op: "ball"; material: string; pos: number[]; radius: number }
  | { op: "cylinder"; material: string; pos: number[]; radius: number; height: number; rot?: number[] }
  | { op: "clear"; min?: number[]; max?: number[] }
  | { op: "replace"; from: string; to: string; min: number[]; max: number[] }
  | { op: "hills"; center: number[]; size: number[]; height: number; material?: string; under?: string; seed?: number; scale?: number; water?: number };

export function terrainLuau(ops: TerrainOp[]): string {
  return chunk(`
	local terrain = workspace.Terrain
	local OPS = ${toLua(ops)}
	local report = {}
	local function mat(name) return Enum.Material[name] end
	local function cf(o)
		local c = CFrame.new(o.pos[1], o.pos[2], o.pos[3])
		if o.rot then c *= CFrame.Angles(math.rad(o.rot[1]), math.rad(o.rot[2]), math.rad(o.rot[3])) end
		return c
	end
	local function region(min, max)
		return Region3.new(Vector3.new(min[1], min[2], min[3]), Vector3.new(max[1], max[2], max[3])):ExpandToGrid(4)
	end
	local function hills(o)
		local res = 4
		local top, under = mat(o.material or "Grass"), mat(o.under or "Ground")
		local seed = o.seed or 7
		local scale = o.scale or math.max(32, math.min(o.size[1], o.size[2]) / 3)
		local baseY = math.floor(o.center[2] / res) * res
		local x0 = math.floor((o.center[1] - o.size[1] / 2) / res) * res
		local z0 = math.floor((o.center[3] - o.size[2] / 2) / res) * res
		local nx, nz = math.ceil(o.size[1] / res), math.ceil(o.size[2] / res)
		local bottom = baseY - 8
		local ny = math.ceil((o.height + 12) / res)
		local water = o.water
		local function height(wx, wz)
			local n = 0
			local amp, freq, norm = 1, 1 / scale, 0
			for _ = 1, 4 do
				n += (math.noise(wx * freq, wz * freq, seed) * 0.5 + 0.5) * amp
				norm += amp
				amp *= 0.5
				freq *= 2
			end
			n /= norm
			-- Fade to flat ground at the edges.
			local ex = math.min((wx - x0) / (nx * res), (x0 + nx * res - wx) / (nx * res)) * 2
			local ez = math.min((wz - z0) / (nz * res), (z0 + nz * res - wz) / (nz * res)) * 2
			local edge = math.clamp(math.min(ex, ez) * 4, 0, 1)
			edge = edge * edge * (3 - 2 * edge)
			return 4 + math.max(0, (n - 0.35) / 0.65) * o.height * edge
		end
		local CH = 32
		local voxels = 0
		for cx = 0, nx - 1, CH do
			for cz = 0, nz - 1, CH do
				local sx, sz = math.min(CH, nx - cx), math.min(CH, nz - cz)
				local mats, occs = table.create(sx), table.create(sx)
				for i = 1, sx do
					mats[i], occs[i] = table.create(ny), table.create(ny)
					for j = 1, ny do
						mats[i][j], occs[i][j] = table.create(sz), table.create(sz)
					end
					for k = 1, sz do
						local wx = x0 + (cx + i - 0.5) * res
						local wz = z0 + (cz + k - 0.5) * res
						local surface = baseY + height(wx, wz)
						for j = 1, ny do
							local y0 = bottom + (j - 1) * res
							local fill = math.clamp((surface - y0) / res, 0, 1)
							local m = Enum.Material.Air
							if fill > 0 then
								m = if surface - y0 <= res * 1.5 then top else under
								voxels += 1
							elseif water and y0 < water then
								m = Enum.Material.Water
								fill = math.clamp((water - y0) / res, 0, 1)
							end
							mats[i][j][k] = m
							occs[i][j][k] = fill
						end
					end
				end
				local min = Vector3.new(x0 + cx * res, bottom, z0 + cz * res)
				terrain:WriteVoxels(Region3.new(min, min + Vector3.new(sx * res, ny * res, sz * res)), res, mats, occs)
			end
		end
		return voxels
	end
	for i, o in OPS do
		local ok, err = pcall(function()
			if o.op == "block" then terrain:FillBlock(cf(o), Vector3.new(o.size[1], o.size[2], o.size[3]), mat(o.material))
			elseif o.op == "wedge" then terrain:FillWedge(cf(o), Vector3.new(o.size[1], o.size[2], o.size[3]), mat(o.material))
			elseif o.op == "ball" then terrain:FillBall(Vector3.new(o.pos[1], o.pos[2], o.pos[3]), o.radius, mat(o.material))
			elseif o.op == "cylinder" then terrain:FillCylinder(cf(o), o.height, o.radius, mat(o.material))
			elseif o.op == "clear" then
				if o.min and o.max then terrain:FillRegion(region(o.min, o.max), 4, Enum.Material.Air) else terrain:Clear() end
			elseif o.op == "replace" then terrain:ReplaceMaterial(region(o.min, o.max), 4, mat(o.from), mat(o.to))
			elseif o.op == "hills" then
				local n = hills(o)
				table.insert(report, i .. " hills: " .. n .. " voxels")
				return
			else error("unknown op " .. tostring(o.op), 0) end
			table.insert(report, i .. " " .. o.op .. " ok")
		end)
		if not ok then table.insert(report, i .. " FAILED " .. tostring(o.op) .. ": " .. tostring(err)) end
	end
	return table.concat(report, "\\n")`, "Forge: terrain");
}

// ---------------------------------------------------------------------------
// studio_undo

export function undoLuau(steps: number, redo = false): string {
  return `local history = game:GetService("ChangeHistoryService")
local done = 0
for _ = 1, ${Math.max(1, Math.min(20, Math.round(steps)))} do
	local ok = pcall(function() history:${redo ? "Redo" : "Undo"}() end)
	if not ok then break end
	done += 1
end
return "${redo ? "Redid" : "Undid"} " .. done .. " step" .. (if done == 1 then "" else "s")
`;
}

// ---------------------------------------------------------------------------
// Live context sent along with chat messages: what is selected and what the camera looks at.
// Kept tiny (it runs before every message) and never fails: each part is optional.

export function studioContextLuau(): string {
  return String.raw`local function r(n)
	local x = math.round(n * 10) / 10
	return if x == 0 then "0" else tostring(x)
end
local function v3(v) return r(v.X) .. "," .. r(v.Y) .. "," .. r(v.Z) end
local out = {}
pcall(function()
	local sel = game:GetService("Selection"):Get()
	if #sel == 0 then
		table.insert(out, "nothing selected")
		return
	end
	local items = {}
	for i, inst in sel do
		if i > 4 then
			table.insert(items, "+" .. (#sel - 4) .. " more")
			break
		end
		local s = inst:GetFullName() .. " [" .. inst.ClassName .. "]"
		pcall(function()
			if inst:IsA("BasePart") then
				s ..= " size " .. v3(inst.Size) .. " at " .. v3(inst.CFrame.Position)
			elseif inst:IsA("LuaSourceContainer") then
				local _, n = string.gsub(inst.Source, "\n", "")
				s ..= " " .. (n + 1) .. " lines"
			elseif #inst:GetChildren() > 0 then
				local n = 0
				for _, d in inst:GetDescendants() do
					if d:IsA("BasePart") then n += 1 end
				end
				s ..= if n > 0 then " " .. n .. " parts" else " " .. #inst:GetDescendants() .. " inside"
				if n > 0 and inst:IsA("Model") then
					local cf, size = inst:GetBoundingBox()
					s ..= " size " .. v3(size) .. " at " .. v3(cf.Position)
				end
			end
		end)
		table.insert(items, s)
	end
	table.insert(out, "selected " .. table.concat(items, "; "))
end)
pcall(function()
	local cf = workspace.CurrentCamera.CFrame
	local s = "camera at " .. v3(cf.Position)
	local hit = workspace:Raycast(cf.Position, cf.LookVector * 2000)
	if hit then s ..= " looking at " .. hit.Instance:GetFullName() .. " (" .. v3(hit.Position) .. ")" end
	table.insert(out, s)
end)
return "place " .. string.format("%q", game.Name) .. " · " .. table.concat(out, " · ")`;
}
