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
local function fPath(path)
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
	if type(v) == "string" and string.sub(v, 1, 1) == "@" then return fPath(string.sub(v, 2)) end
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
	if type(v) == "string" and string.sub(v, 1, 1) == "@" then return fPath(string.sub(v, 2)) end
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
-- Calls fn on every match (up to limit); returns the number of matches.
local function fFind(q, limit, fn)
	local root = fPath(q.path or "Workspace")
	local match = fMatcher(q)
	local count = 0
	if not q.depth then
		for _, inst in root:GetDescendants() do
			if match(inst) then
				count += 1
				if count <= limit then fn(inst, root) end
			end
		end
	else
		local function walk(node, depth)
			for _, child in node:GetChildren() do
				if match(child) then
					count += 1
					if count <= limit then fn(child, root) end
				end
				if depth < q.depth then walk(child, depth + 1) end
			end
		end
		walk(root, 1)
	end
	return count, root
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
				return inst[p]
			end)
			if ok and v ~= "" then line ..= " " .. p .. "=" .. fFmt(v) end
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
  | { op: "select"; paths: string[] };

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
	local selected = {}
	local changed, failed = 0, 0
	local function targets(o)
		if o.path then return { fPath(o.path) } end
		if o.query then
			local list = {}
			fFind(o.query, 5000, function(inst) table.insert(list, inst) end)
			return list
		end
		error("give path or query", 0)
	end
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
				for _, p in o.paths do table.insert(selected, fPath(p)) end
				table.insert(report, i .. " selected " .. #o.paths)
			else
				error("unknown op " .. tostring(o.op), 0)
			end
		end)
		if not ok then
			failed += 1
			table.insert(report, i .. " FAILED " .. o.op .. ": " .. tostring(err))
		end
	end
	if #selected > 0 then
		pcall(function() game:GetService("Selection"):Set(selected) end)
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
	local editor = nil
	pcall(function() editor = game:GetService("ScriptEditorService") end)
	local lines, scripts, hits = {}, 0, 0
	local list = root:GetDescendants()
	if root:IsA("LuaSourceContainer") then list = { root } end
	for _, s in list do
		if not s:IsA("LuaSourceContainer") then continue end
		local okSrc, src = pcall(function()
			if editor then return editor:GetEditorSource(s) end
			return s.Source
		end)
		if not okSrc then src = s.Source end
		scripts += 1
		local name = s:GetFullName()
		if pattern == "" then
			if scripts <= ${limit} then
				local n = select(2, string.gsub(src, "\\n", "\\n")) + 1
				table.insert(lines, name .. " [" .. s.ClassName .. "] " .. n .. " lines" .. (if s:IsA("BaseScript") and pcall(function() return s.Enabled end) and not s.Enabled then " (disabled)" else ""))
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
