// Abilities in Studio, as instance trees (written as Luau or .rbxmx by the same code):
//   ReplicatedStorage.Abilities.<Name>   Folder: Animation (KeyframeSequence), Effects (one
//                                         template Model per effect), Play (ModuleScript)
//   StarterPack.<Name>                    Tool whose Cast script runs Play on the holder
// require(Abilities.<Name>.Play)(character) casts it from any script. The animation plays through
// the AnimationId attribute once you publish it, and through a temporary Studio id until then.

import { bakedKeyframes, jointTransform, poseOf, RIGS, type AnimationSpec, type Joint, type PoseValue, type Rig } from "./animation.ts";
import { ATTACH, SUMMON_DEFAULTS, type ResolvedAbility, type ResolvedProp, type ResolvedSummon } from "./ability.ts";
import { eulerXYZDeg, hexToRgb } from "./math.ts";
import { toNativeModel } from "./model.ts";
import { MATERIAL_ENUM, NORMAL_ID_ENUM, PART_TYPE_ENUM } from "./roblox-data.ts";
import { vfxTree } from "./vfx.ts";
import type { InstNode, PropValue } from "./instance-tree.ts";

const POSE_STYLE = { linear: ["Linear", 0], constant: ["Constant", 1], elastic: ["Elastic", 2], bounce: ["Bounce", 4], cubic: ["CubicV2", 5] } as const;
// Roblox poses use In/Out backwards from TweenService.
const POSE_DIR = { in: ["Out", 1], out: ["In", 0], inOut: ["InOut", 2] } as const;
const PRIORITY = { Idle: 0, Movement: 1, Action: 2, Core: 1000 } as const;

/** A KeyframeSequence: keyframes with nested poses (containers have Weight 0, like the Animation Editor's). */
export function animationTree(spec: AnimationSpec, name = "Animation"): InstNode {
  const rig = RIGS[spec.rig];
  const joints = new Map(rig.joints.map((j) => [j.joint, j]));
  const children = new Map<string, string[]>();
  for (const j of rig.joints) children.set(j.part0, [...(children.get(j.part0) ?? []), j.part1]);
  const priority = spec.priority ?? "Action";
  const seq: InstNode = {
    className: "KeyframeSequence",
    name,
    props: { Loop: spec.loop ?? true, Priority: { enum: "AnimationPriority", item: priority, token: PRIORITY[priority] } },
    children: [],
  };
  for (const k of bakedKeyframes(spec)) {
    const posed = new Map<string, { pos: number[]; rot: number[] }>();
    for (const [joint, value] of Object.entries(k.poses) as [Joint, PoseValue][]) {
      const j = joints.get(joint);
      if (!j || !value) continue;
      const p = poseOf(value);
      posed.set(j.part1, jointTransform(j, { rot: eulerXYZDeg(p.rot), pos: p.pos }));
    }
    const needed = (part: string): boolean => posed.has(part) || (children.get(part) ?? []).some(needed);
    const style = POSE_STYLE[k.ease ?? "linear"], dir = POSE_DIR[k.dir ?? "inOut"];
    const visit = (part: string): InstNode => {
      const t = posed.get(part);
      const props: Record<string, PropValue> = t
        ? {
            CFrame: { cf: { pos: t.pos as [number, number, number], rot: t.rot as never } },
            Weight: 1,
            EasingStyle: { enum: "PoseEasingStyle", item: style[0], token: style[1] },
            EasingDirection: { enum: "PoseEasingDirection", item: dir[0], token: dir[1] },
          }
        : { Weight: 0 };
      return { className: "Pose", name: part, props, children: (children.get(part) ?? []).filter(needed).map(visit) };
    };
    const kf: InstNode = { className: "Keyframe", name: k.name ?? "Keyframe", props: { Time: k.t }, children: [] };
    if (needed(rig.parts[0].name)) kf.children!.push(visit(rig.parts[0].name));
    seq.children!.push(kf);
  }
  return seq;
}

// ---------------------------------------------------------------------------
// Summon and prop templates

const GHOST: Record<string, PropValue> = { CanCollide: false, CanQuery: false, CanTouch: false, CastShadow: false };
const material = (name: keyof typeof MATERIAL_ENUM): PropValue => ({ enum: "Material", item: name, token: MATERIAL_ENUM[name] });

/**
 * A summon: the rig's parts in its colour and material, joined by Motor6Ds, with an
 * AnimationController to play its animation. The root is anchored and moved by the Play module.
 */
export function summonTree(m: ResolvedSummon): InstNode {
  const rig: Rig = RIGS[m.rig];
  const s = m.summon;
  const rgb = hexToRgb(s.color ?? SUMMON_DEFAULTS.color);
  const look = material(s.material ?? SUMMON_DEFAULTS.material);
  const transparency = s.transparency ?? SUMMON_DEFAULTS.transparency;
  const id = (part: string) => `summon:${m.templateName}:${part}`;
  const center = new Map(rig.parts.map((p) => [p.name, p.center]));
  const parts = new Map<string, InstNode>();
  for (const p of rig.parts) {
    const node: InstNode = {
      id: id(p.name),
      className: "Part",
      name: p.name,
      props: {
        Size: { v3: p.size }, CFrame: { cf: { pos: p.center } }, Color: { rgb }, Material: look,
        Transparency: p.hidden ? 1 : transparency, Anchored: !!p.hidden, ...(p.hidden ? {} : { Massless: true }), ...GHOST,
      },
      children: [],
    };
    if (p.name === "Head" && rig.type === "R6") {
      node.children!.push({ className: "SpecialMesh", name: "Mesh", props: { MeshType: { enum: "MeshType", item: "Head", token: 0 }, Scale: { v3: [1.25, 1.25, 1.25] } } });
    }
    parts.set(p.name, node);
  }
  for (const j of rig.joints) {
    const c0 = center.get(j.part0)!, c1 = center.get(j.part1)!;
    // R15 keeps each Motor6D in its Part1; R6 keeps them in the Torso (RootJoint in the root part).
    const holder = parts.get(rig.type === "R15" ? j.part1 : j.part0)!;
    holder.children!.push({
      className: "Motor6D",
      name: j.motor,
      props: {
        Part0: { ref: id(j.part0) }, Part1: { ref: id(j.part1) },
        C0: { cf: { pos: [j.pivot[0] - c0[0], j.pivot[1] - c0[1], j.pivot[2] - c0[2]], rot: j.q } },
        C1: { cf: { pos: [j.pivot[0] - c1[0], j.pivot[1] - c1[1], j.pivot[2] - c1[2]], rot: j.q } },
      },
    });
  }
  const children: InstNode[] = [...parts.values(), { className: "AnimationController", name: "AnimationController", children: [{ className: "Animator", name: "Animator" }] }];
  if (m.animation && !m.caster) children.push(animationTree({ ...m.animation, rig: m.rig, loop: m.animation.loop ?? true }));
  return {
    className: "Model",
    name: m.templateName,
    props: { PrimaryPart: { ref: id(rig.parts[0].name) } },
    attrs: { AnimationId: "" },
    children,
  };
}

/** A prop: its parts around an invisible Root at the model's origin (the grip), all anchored. */
export function propTree(p: ResolvedProp): InstNode {
  const native = toNativeModel(p.model);
  const rootId = `prop:${p.templateName}:Root`;
  const children: InstNode[] = [{
    id: rootId, className: "Part", name: "Root",
    props: { Size: { v3: [0.2, 0.2, 0.2] }, CFrame: { cf: { pos: [0, 0, 0] } }, Transparency: 1, Anchored: true, ...GHOST },
  }];
  for (const part of native.parts) {
    const props: Record<string, PropValue> = {
      Size: { v3: part.size }, CFrame: { cf: { pos: part.pos, rot: part.rot } }, Color: { rgb: part.color }, Material: material(part.material),
      Anchored: true, CanCollide: false, CanQuery: false, CanTouch: false, CastShadow: part.castShadow && part.material !== "Neon",
    };
    if (part.transparency) props.Transparency = part.transparency;
    if (part.reflectance) props.Reflectance = part.reflectance;
    if (part.className === "Part" && part.shape && part.shape !== "Block") props.Shape = { enum: "PartType", item: part.shape, token: PART_TYPE_ENUM[part.shape] };
    const node: InstNode = { className: part.className, name: part.name, props };
    if (part.light) {
      const l = part.light;
      const lp: Record<string, PropValue> = { Brightness: l.brightness, Color: { rgb: l.color }, Range: l.range, Shadows: l.shadows };
      if (l.className !== "PointLight") Object.assign(lp, { Angle: l.angle, Face: { enum: "NormalId", item: l.face, token: NORMAL_ID_ENUM[l.face] } });
      node.children = [{ className: l.className, name: l.className, props: lp }];
    }
    children.push(node);
  }
  return {
    className: "Model",
    name: p.templateName,
    props: { PrimaryPart: { ref: rootId } },
    attrs: { Height: Math.round(Math.max(0.1, native.bounds.max[1]) * 1000) / 1000 },
    children,
  };
}

/** A Luau literal for plain data (numbers, strings, booleans, arrays, records). */
function lua(v: unknown, indent = ""): string {
  if (v === null || v === undefined) return "nil";
  if (typeof v === "number") return String(Math.round(v * 1e4) / 1e4);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `{ ${v.map((x) => lua(x, indent)).join(", ")} }`;
  const inner = indent + "\t";
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  if (!entries.length) return "{}";
  const multi = entries.some(([, x]) => x && typeof x === "object" && !Array.isArray(x));
  const parts = entries.map(([k, x]) => `${/^[A-Za-z_]\w*$/.test(k) ? k : `[${JSON.stringify(k)}]`} = ${lua(x, inner)}`);
  return multi ? `{\n${parts.map((p) => inner + p).join(",\n")},\n${indent}}` : `{ ${parts.join(", ")} }`;
}

export function playSource(r: ResolvedAbility): string {
  const config = {
    name: r.spec.name,
    length: r.length,
    events: r.events.map((e) => ({
      at: e.event.at,
      effect: e.templateName,
      attach: e.event.attach ?? "root",
      offset: e.event.offset,
      follow: e.event.follow,
      duration: e.event.duration ?? 1,
      travel: e.event.travel ? { velocity: e.event.travel.velocity, gravity: e.event.travel.gravity ?? 0, stopOnHit: e.event.travel.stopOnHit ?? true } : undefined,
      impact: e.impactName,
    })),
    summons: r.summons.map((m) => ({
      at: m.summon.at,
      template: m.templateName,
      life: Math.round((m.until - m.summon.at) * 1000) / 1000,
      offset: m.summon.offset ?? SUMMON_DEFAULTS.offset,
      path: m.summon.path,
      turn: m.summon.turn,
      scale: m.summon.scale ?? SUMMON_DEFAULTS.scale,
      appear: m.summon.appear ?? "fade",
      fade: m.summon.fade ?? SUMMON_DEFAULTS.fade,
      hover: m.summon.hover ?? SUMMON_DEFAULTS.hover,
      anim: m.caster ? "caster" : m.animation ? "own" : undefined,
      aura: m.auraName,
    })),
    props: r.props.map((p) => ({
      at: p.prop.at,
      template: p.templateName,
      life: Math.round((p.until - p.prop.at) * 1000) / 1000,
      attach: p.prop.attach ?? "rightHand",
      offset: p.prop.offset,
      rot: p.prop.rot,
      follow: p.prop.follow ?? "part",
      scale: p.prop.scale ?? 1,
      appear: p.prop.appear ?? "fade",
      vanish: p.prop.vanish ?? "fade",
      fade: p.prop.fade ?? 0.2,
      spin: p.prop.spin,
      travel: p.prop.travel ? { velocity: p.prop.travel.velocity, gravity: p.prop.travel.gravity ?? 0, stopOnHit: p.prop.travel.stopOnHit ?? true } : undefined,
      impact: p.impactName,
    })),
  };
  const attach = (rig: "R15" | "R6") =>
    Object.entries(ATTACH[rig]).map(([k, a]) => `${k} = { ${JSON.stringify(a.part)}, Vector3.new(${a.offset.join(", ")}) }`).join(", ");
  return `-- Studio Forge ability "${r.spec.name.replace(/[\r\n"]/g, " ")}": plays its animation and effects on a character.
-- Cast it from any script: require(path.to.Play)(character). Effects go in workspace.AbilityEffects.
-- To use it in a live game, publish the Animation (right-click > Save to Roblox) and put the id in
-- this folder's AnimationId attribute; until then Studio plays it through a temporary id.
local ABILITY = ${lua(config)}

local folder = script.Parent
local RunService = game:GetService("RunService")
local Debris = game:GetService("Debris")
local ATTACH = {
	R15 = { ${attach("R15")} },
	R6 = { ${attach("R6")} },
}
local tracks = setmetatable({}, { __mode = "k" })

local function animationTrack(humanoid)
	if tracks[humanoid] then return tracks[humanoid] end
	local id = folder:GetAttribute("AnimationId")
	if (not id or id == "") and folder:FindFirstChild("Animation") then
		local ok, temp = pcall(function()
			return game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(folder.Animation)
		end)
		if ok then id = temp end
	end
	if not id or id == "" then return nil end
	if not string.find(tostring(id), "://") then id = "rbxassetid://" .. tostring(id) end
	local animator = humanoid:FindFirstChildOfClass("Animator")
	if not animator then
		animator = Instance.new("Animator")
		animator.Parent = humanoid
	end
	local animation = Instance.new("Animation")
	animation.AnimationId = id
	local ok, track = pcall(function() return animator:LoadAnimation(animation) end)
	if not ok then return nil end
	tracks[humanoid] = track
	return track
end

-- One-shot emitters fire their EmitCount (after EmitDelay).
local function burst(model)
	for _, e in model:GetDescendants() do
		if e:IsA("ParticleEmitter") and e:GetAttribute("EmitCount") then
			task.delay(e:GetAttribute("EmitDelay") or 0, function()
				if e.Parent then e:Emit(e:GetAttribute("EmitCount")) end
			end)
		end
	end
end

-- Stop emitting and remove the effect once its last particles are gone.
local function stop(model)
	local tail = 0.3
	for _, e in model:GetDescendants() do
		if e:IsA("ParticleEmitter") then
			e.Enabled = false
			tail = math.max(tail, e.Lifetime.Max)
		elseif e:IsA("Trail") then
			e.Enabled = false
			tail = math.max(tail, e.Lifetime)
		elseif e:IsA("Smoke") then
			e.Enabled = false
			tail = math.max(tail, 5)
		elseif e:IsA("Beam") or e:IsA("Light") or e:IsA("Fire") or e:IsA("Sparkles") then
			e.Enabled = false
		end
	end
	Debris:AddItem(model, tail + 0.2)
end

local function spawnEffect(name, cframe, parent)
	local template = folder.Effects:FindFirstChild(name)
	if not template then return nil end
	local model = template:Clone()
	model:PivotTo(cframe)
	model.Parent = parent
	burst(model)
	return model
end

local function vec(t)
	return if t then Vector3.new(t[1], t[2], t[3]) else Vector3.zero
end

-- Summons and props --------------------------------------------------------

-- Show a summon or prop at f (0 = invisible, 1 = as built), keeping each part's own transparency.
local function fadeTo(model, f)
	for _, d in model:GetDescendants() do
		if d:IsA("BasePart") and d.Name ~= "HumanoidRootPart" and d.Name ~= "Root" then
			local base = d:GetAttribute("BaseTransparency")
			if base == nil then
				base = d.Transparency
				d:SetAttribute("BaseTransparency", base)
			end
			d.Transparency = 1 - (1 - base) * f
		elseif d:IsA("Light") then
			d.Enabled = f > 0.05
		end
	end
end

local function sizeTo(model, k)
	pcall(function() model:ScaleTo(math.max(0.01, k)) end)
end

local registered = {}
local function animationId(sequence, published)
	if published and published ~= "" then
		return if string.find(tostring(published), "://") then published else "rbxassetid://" .. tostring(published)
	end
	if not sequence then return nil end
	if not registered[sequence] then
		local ok, id = pcall(function()
			return game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(sequence)
		end)
		if ok then registered[sequence] = id end
	end
	return registered[sequence]
end

local function playOn(animator, sequence, published)
	local id = animator and animationId(sequence, published)
	if not id then return nil end
	local animation = Instance.new("Animation")
	animation.AnimationId = id
	local ok, track = pcall(function() return animator:LoadAnimation(animation) end)
	if not ok or not track then return nil end
	track:Play(0.05)
	return track
end

-- 0 → 1 while appearing, 1 → 0 while vanishing.
local function fades(age, life, fade)
	if fade <= 0 then return 1, if age < life then 1 else 0 end
	return math.clamp(age / fade, 0, 1), math.clamp((life + fade - age) / fade, 0, 1)
end

-- Offset along a summon's path (smooth between points).
local function pathOffset(s, age)
	local last, lastT = vec(s.offset), 0
	for _, point in s.path or {} do
		local o = vec(point.offset)
		if age <= point.t then
			local span = point.t - lastT
			local k = if span > 0 then math.clamp((age - lastT) / span, 0, 1) else 1
			return last:Lerp(o, k * k * (3 - 2 * k))
		end
		last, lastT = o, point.t
	end
	return last
end

local function spawnSummon(s, root, container)
	local holder = folder:FindFirstChild("Summons")
	local template = holder and holder:FindFirstChild(s.template)
	if not template then return end
	local model = template:Clone()
	local own = model:FindFirstChild("Animation")
	if own then own.Parent = nil end
	model.PrimaryPart = model:FindFirstChild("HumanoidRootPart")
	local function place(age)
		local bob = (s.hover or 0) * math.sin(age * 2.5)
		return root.CFrame * CFrame.new(pathOffset(s, age) + Vector3.new(0, bob, 0)) * CFrame.Angles(0, math.rad(s.turn or 0), 0)
	end
	if s.appear ~= "grow" and s.scale ~= 1 then sizeTo(model, s.scale) end
	fadeTo(model, if s.appear == "fade" then 0 else 1)
	model:PivotTo(place(0))
	model.Parent = container
	local track = nil
	if s.anim then
		local controller = model:FindFirstChildOfClass("AnimationController")
		local animator = controller and controller:FindFirstChildOfClass("Animator")
		if s.anim == "caster" then
			-- In step with the caster: start where the caster's animation is now.
			track = playOn(animator, folder:FindFirstChild("Animation"), folder:GetAttribute("AnimationId"))
			if track then pcall(function() track.TimePosition = s.at end) end
		else
			track = playOn(animator, template:FindFirstChild("Animation"), template:GetAttribute("AnimationId"))
		end
	end
	local torso = model:FindFirstChild("UpperTorso") or model:FindFirstChild("Torso") or model.PrimaryPart
	local aura = if s.aura then spawnEffect(s.aura, torso.CFrame, container) else nil
	local born = os.clock()
	local conn = nil
	conn = RunService.Heartbeat:Connect(function()
		local age = os.clock() - born
		if age >= s.life + s.fade or not model.Parent or not root.Parent then
			conn:Disconnect()
			if track then track:Stop(0.1) end
			model.Parent = nil
			if aura then stop(aura) end
			return
		end
		local fin, fout = fades(age, s.life, s.fade)
		if s.appear == "grow" then
			sizeTo(model, s.scale * math.max(0.05, fin))
			fadeTo(model, fout)
		else
			fadeTo(model, (if s.appear == "fade" then fin else 1) * fout)
		end
		model:PivotTo(place(age))
		if aura then aura:PivotTo(torso.CFrame) end
	end)
end

local function spawnProp(p, character, root, humanoid, rig, container, params)
	local holder = folder:FindFirstChild("Props")
	local template = holder and holder:FindFirstChild(p.template)
	if not template then return end
	local model = template:Clone()
	model.PrimaryPart = model:FindFirstChild("Root")
	local height = (template:GetAttribute("Height") or 1) * p.scale
	local point = ATTACH[rig][p.attach]
	local part = if point then character:FindFirstChild(point[1]) or root else root
	local anchorOffset = if point then point[2] else Vector3.zero
	local offset, rot, spin = vec(p.offset), vec(p.rot), vec(p.spin)
	local function angles(a) return CFrame.Angles(math.rad(a.X), math.rad(a.Y), math.rad(a.Z)) end
	local fixed = nil
	local function base()
		if p.attach == "ground" or p.attach == "world" then
			if not fixed then
				local at = root.CFrame.Position
				if p.attach == "ground" then
					local hit = workspace:Raycast(at, Vector3.new(0, -60, 0), params)
					at = if hit then hit.Position else at - Vector3.new(0, humanoid.HipHeight + root.Size.Y / 2, 0)
				end
				fixed = CFrame.new(at) * root.CFrame.Rotation
			end
			return fixed * CFrame.new(offset)
		end
		local anchor = (part.CFrame * CFrame.new(anchorOffset)).Position
		local turn = if p.follow == "character" then root.CFrame.Rotation else part.CFrame.Rotation
		return CFrame.new(anchor) * turn * CFrame.new(offset)
	end
	local life = p.life
	local flight = nil
	if p.scale ~= 1 and p.appear ~= "grow" then sizeTo(model, p.scale) end
	fadeTo(model, if p.appear == "fade" then 0 else 1)
	model:PivotTo(base() * angles(rot))
	model.Parent = container
	if p.travel then
		local start = base() * angles(rot)
		flight = { origin = start.Position, turn = start.Rotation, last = start.Position, velocity = root.CFrame.Rotation:VectorToWorldSpace(vec(p.travel.velocity)) }
	end
	local born = os.clock()
	local lastSize = nil
	local conn = nil
	conn = RunService.Heartbeat:Connect(function()
		local age = os.clock() - born
		if age >= life + p.fade or not model.Parent then
			conn:Disconnect()
			model.Parent = nil
			return
		end
		local fin, fout = fades(age, life, p.fade)
		local show, size = 1, 1
		if p.appear == "fade" then show *= fin elseif p.appear == "grow" then size *= fin end
		if p.vanish == "fade" then show *= fout elseif p.vanish == "shrink" then size *= fout elseif p.vanish == "pop" and age >= life then show = 0 end
		fadeTo(model, show)
		if size ~= lastSize and (p.appear == "grow" or p.vanish == "shrink") then
			sizeTo(model, p.scale * math.max(0.01, size))
			lastSize = size
		end
		local cf
		if flight and not flight.landed then
			local t = age
			local at = flight.origin + flight.velocity * t - Vector3.new(0, 0.5 * p.travel.gravity * t * t, 0)
			local hit = p.travel.stopOnHit and workspace:Raycast(flight.last, at - flight.last, params)
			if hit then at = hit.Position end
			flight.last = at
			cf = CFrame.new(at) * flight.turn * angles(spin * age)
			if hit or t >= life then
				flight.landed = cf
				life = math.min(life, age)
				if p.impact then
					local impact = spawnEffect(p.impact, CFrame.new(at) * root.CFrame.Rotation, container)
					if impact then task.delay(1, stop, impact) end
				end
			end
		elseif flight then
			cf = flight.landed
		else
			cf = base() * angles(rot) * angles(spin * age)
		end
		local sink = 0
		if p.appear == "rise" then sink += (1 - fin) * height end
		if p.vanish == "sink" then sink += (1 - fout) * height end
		if sink > 0 then cf = CFrame.new(0, -sink, 0) * cf end
		model:PivotTo(cf)
	end)
end

return function(character)
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if not humanoid or not root then return nil end
	local rig = if humanoid.RigType == Enum.HumanoidRigType.R6 then "R6" else "R15"
	local track = animationTrack(humanoid)
	if track then track:Play(0.05) end
	local container = workspace:FindFirstChild("AbilityEffects")
	if not container then
		container = Instance.new("Folder")
		container.Name = "AbilityEffects"
		container.Parent = workspace
	end
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = { character, container }
	for _, ev in ABILITY.events do
		task.delay(ev.at, function()
			if not character.Parent then return end
			local point = ATTACH[rig][ev.attach]
			local part = if point then character:FindFirstChild(point[1]) or root else root
			local anchorOffset = if point then point[2] else Vector3.zero
			local offset = vec(ev.offset)
			local function placement()
				if ev.attach == "ground" or ev.attach == "world" then
					local p = root.CFrame.Position
					if ev.attach == "ground" then
						local hit = workspace:Raycast(p, Vector3.new(0, -60, 0), params)
						p = if hit then hit.Position else p - Vector3.new(0, humanoid.HipHeight + root.Size.Y / 2, 0)
					end
					return CFrame.new(p) * root.CFrame.Rotation * CFrame.new(offset)
				end
				local anchor = (part.CFrame * CFrame.new(anchorOffset)).Position
				local turn = if ev.follow == "part" then part.CFrame.Rotation else root.CFrame.Rotation
				return CFrame.new(anchor) * turn * CFrame.new(offset)
			end
			local model = spawnEffect(ev.effect, placement(), container)
			if not model then return end
			local born = os.clock()
			local conn = nil
			if ev.travel then
				-- Fly in the character's frame until the time is up or something is hit.
				local velocity = root.CFrame.Rotation:VectorToWorldSpace(vec(ev.travel.velocity))
				local origin = model:GetPivot().Position
				local last = origin
				local done = false
				local function finish(at)
					if done then return end
					done = true
					if conn then conn:Disconnect() end
					if ev.impact then
						local impact = spawnEffect(ev.impact, CFrame.new(at) * root.CFrame.Rotation, container)
						if impact then task.delay(1, stop, impact) end
					end
					stop(model)
				end
				conn = RunService.Heartbeat:Connect(function()
					local t = os.clock() - born
					local p = origin + velocity * t - Vector3.new(0, 0.5 * ev.travel.gravity * t * t, 0)
					local dir = velocity - Vector3.new(0, ev.travel.gravity * t, 0)
					if ev.travel.stopOnHit then
						local hit = workspace:Raycast(last, p - last, params)
						if hit then
							model:PivotTo(CFrame.new(hit.Position))
							finish(hit.Position)
							return
						end
					end
					last = p
					model:PivotTo(if dir.Magnitude > 1e-3 then CFrame.lookAt(p, p + dir) else CFrame.new(p))
					if t >= ev.duration then finish(p) end
				end)
			else
				if ev.attach ~= "ground" and ev.attach ~= "world" then
					-- Follow the body part while it plays.
					conn = RunService.Heartbeat:Connect(function()
						if model.Parent and part.Parent then model:PivotTo(placement()) end
					end)
				end
				task.delay(ev.duration, function()
					if conn then conn:Disconnect() end
					stop(model)
				end)
			end
		end)
	end
	for _, s in ABILITY.summons do
		task.delay(s.at, function()
			if character.Parent then spawnSummon(s, root, container) end
		end)
	end
	for _, p in ABILITY.props do
		task.delay(p.at, function()
			if character.Parent then spawnProp(p, character, root, humanoid, rig, container, params) end
		end)
	end
	return track
end
`;
}

export function castSource(r: ResolvedAbility): string {
  return `-- Casts "${r.spec.name.replace(/[\r\n"]/g, " ")}" when the tool is used (click with it equipped).
local tool = script.Parent
local play = tool:FindFirstChild("Play")
	or game:GetService("ReplicatedStorage"):WaitForChild("Abilities"):WaitForChild(${JSON.stringify(r.spec.name)}):WaitForChild("Play")
local cast = require(play)
local COOLDOWN = ${r.spec.cooldown ?? Math.max(0.5, Math.min(5, Math.round(r.length * 10) / 10))}
local ready = true
tool.Activated:Connect(function()
	local character = tool.Parent
	if not ready or not character or not character:FindFirstChildOfClass("Humanoid") then return end
	ready = false
	cast(character)
	task.wait(COOLDOWN)
	ready = true
end)
`;
}

/** Hash of the animation, so a re-import keeps a published AnimationId only while the animation is unchanged. */
export function animationHash(spec: AnimationSpec | null): string {
  if (!spec) return "";
  const s = JSON.stringify({ k: spec.keyframes, r: spec.rig, l: spec.loop, p: spec.priority, n: spec.length, o: spec.overlap });
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16);
}

function contents(r: ResolvedAbility): InstNode[] {
  const out: InstNode[] = [];
  if (r.animation) out.push(animationTree({ ...r.animation, rig: r.spec.rig, loop: r.animation.loop ?? false }));
  const effects: InstNode = { className: "Folder", name: "Effects", children: [] };
  for (const e of r.events) {
    effects.children!.push({ ...vfxTree(e.vfx), name: e.templateName });
    if (e.impact && e.impactName) effects.children!.push({ ...vfxTree(e.impact), name: e.impactName });
  }
  for (const m of r.summons) if (m.vfx && m.auraName) effects.children!.push({ ...vfxTree(m.vfx), name: m.auraName });
  for (const p of r.props) if (p.impact && p.impactName) effects.children!.push({ ...vfxTree(p.impact), name: p.impactName });
  out.push(effects);
  if (r.summons.length) out.push({ className: "Folder", name: "Summons", children: r.summons.map(summonTree) });
  if (r.props.length) out.push({ className: "Folder", name: "Props", children: r.props.map(propTree) });
  out.push({ className: "ModuleScript", name: "Play", source: playSource(r) });
  return out;
}

/** The folder for ReplicatedStorage.Abilities and the Tool for StarterPack. */
export function abilityTrees(r: ResolvedAbility): { folder: InstNode; tool: InstNode } {
  const attrs = { AnimationId: "", AnimationHash: animationHash(r.animation) };
  return {
    folder: { className: "Folder", name: r.spec.name, attrs, children: contents(r) },
    tool: toolNode(r, []),
  };
}

/** A Tool that carries everything itself (for the .rbxmx download: drop it into StarterPack). */
export function standaloneTool(r: ResolvedAbility): InstNode {
  const tool = toolNode(r, contents(r));
  tool.attrs = { AnimationId: "", AnimationHash: animationHash(r.animation) };
  return tool;
}

function toolNode(r: ResolvedAbility, extra: InstNode[]): InstNode {
  return {
    className: "Tool",
    name: r.spec.name,
    props: { RequiresHandle: false, CanBeDropped: false, ToolTip: (r.spec.description ?? r.spec.name).slice(0, 100) },
    children: [{ className: "Script", name: "Cast", source: castSource(r) }, ...extra],
  };
}
