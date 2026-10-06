// Abilities in Studio, as instance trees (written as Luau or .rbxmx by the same code):
//   ReplicatedStorage.Abilities.<Name>   Folder: Animation (KeyframeSequence), Effects (one
//                                         template Model per effect), Play (ModuleScript)
//   StarterPack.<Name>                    Tool whose Cast script runs Play on the holder
// require(Abilities.<Name>.Play)(character) casts it from any script. The animation plays through
// the AnimationId attribute once you publish it, and through a temporary Studio id until then.

import { jointTransform, poseOf, RIGS, type AnimationSpec, type Joint, type PoseValue } from "./animation.ts";
import { ATTACH, type ResolvedAbility } from "./ability.ts";
import { eulerXYZDeg } from "./math.ts";
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
  for (const k of spec.keyframes) {
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
  const s = JSON.stringify({ k: spec.keyframes, r: spec.rig, l: spec.loop, p: spec.priority, n: spec.length });
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
  out.push(effects, { className: "ModuleScript", name: "Play", source: playSource(r) });
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
