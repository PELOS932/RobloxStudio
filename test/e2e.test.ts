// End-to-end: real server + fake Claude Code CLI + mock Roblox Studio MCP (Lune-backed).
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerEvent } from "../src/shared/protocol.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 4400 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;

let luneAvailable = true;
try {
  execFileSync(process.env.LUNE_BIN ?? "lune", ["--version"], { stdio: "ignore" });
} catch {
  luneAvailable = false;
}

describe.skipIf(!luneAvailable)("end to end", () => {
  let server: ChildProcess;
  let ws: WebSocket;
  const events: ServerEvent[] = [];
  const waiters: { pred: (e: ServerEvent) => boolean; resolve: (e: ServerEvent) => void }[] = [];

  function waitFor<T extends ServerEvent["type"]>(type: T, pred: (e: Extract<ServerEvent, { type: T }>) => boolean = () => true, timeout = 30_000) {
    const match = (e: ServerEvent) => e.type === type && pred(e as Extract<ServerEvent, { type: T }>);
    const existing = events.find(match);
    if (existing) return Promise.resolve(existing as Extract<ServerEvent, { type: T }>);
    return new Promise<Extract<ServerEvent, { type: T }>>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeout);
      waiters.push({ pred: match, resolve: (e) => (clearTimeout(t), res(e as Extract<ServerEvent, { type: T }>)) });
    });
  }

  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(BASE + path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  };

  beforeAll(async () => {
    const data = mkdtempSync(join(tmpdir(), "forge-e2e-"));
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "settings.json"), JSON.stringify({
      claudePath: join(ROOT, "test", "fake-claude.mjs"),
      studio: { command: process.execPath, args: ["--import", "tsx", join(ROOT, "scripts", "mock-studio-mcp.ts")], autoConnect: true },
      import: { placement: "origin", optimize: true, performance: true, replace: true },
    }));
    server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src/server/index.ts")], {
      cwd: ROOT,
      env: { ...process.env, FORGE_PORT: String(PORT), FORGE_DATA_DIR: data, MOCK_STUDIO_DIR: mkdtempSync(join(tmpdir(), "mock-place-")) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stderr!.on("data", (d) => process.stderr.write(`[server] ${d}`));
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("server did not start")), 20_000);
      server.stdout!.on("data", (d) => String(d).includes("running at") && (clearTimeout(t), res()));
    });
    ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { origin: BASE } });
    ws.on("message", (raw) => {
      const e = JSON.parse(String(raw)) as ServerEvent;
      events.push(e);
      for (const w of [...waiters]) if (w.pred(e)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(e);
      }
    });
    await waitFor("boot");
  }, 40_000);

  afterAll(() => {
    ws?.close();
    server?.kill();
  });

  it("connects to the (mock) Studio MCP server", async () => {
    const e = await waitFor("studio", (e) => e.status.state === "connected" && !!e.status.studioId);
    expect(e.status.flavor).toBe("builtin");
  });

  it("reports the Claude CLI as installed and signed in", async () => {
    const e = await waitFor("claude", (e) => e.status.cli === "ok");
    expect(e.status).toMatchObject({ loggedIn: true, version: "9.9.9" });
  });

  let modelId = "";
  it("chats, creates a model through the Forge MCP and auto-imports it into Studio", async () => {
    const conv = (await api("/api/conversations", { method: "POST", body: "{}" })).body;
    ws.send(JSON.stringify({ type: "chat.send", convId: conv.id, text: "Make me a lantern" }));
    const asset = await waitFor("asset", (e) => e.asset.kind === "model");
    modelId = asset.asset.id;
    // While Studio runs the import, the call shows what is happening (updates are batched, so
    // short-lived steps may be skipped; the import itself always lasts long enough to be seen).
    await waitFor("message", (e) => e.convId === conv.id && e.message.blocks.some((b) => b.type === "tool" && /KB of generated Luau in Studio/.test(b.progress ?? "")));
    expect(asset.asset).toMatchObject({ name: "Lantern", size: 3 });
    await waitFor("status", (e) => e.convId === conv.id && e.status === "idle");

    const full = (await api(`/api/conversations/${conv.id}`)).body;
    const assistant = full.messages.at(-1);
    const tool = assistant.blocks.find((b: { type: string }) => b.type === "tool");
    expect(tool).toMatchObject({ name: "mcp__forge__create_model", status: "done" });
    expect(tool.result.text).toMatch(/Created model "Lantern"/);
    expect(tool.result.text).toMatch(/Imported in Studio at Workspace\.Lantern/);
    expect(assistant.blocks.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join(" ")).toContain("Done");
    expect(assistant.usage).toMatchObject({ cacheReadTokens: 18000, costUsd: 0.0123 });
    expect(full.claudeSessionId).toBeTruthy();
    expect(full.title).toBe("Make me a lantern");

    const stored = (await api(`/api/assets/${modelId}`)).body;
    expect(stored.lastImport.path).toBe("Workspace.Lantern");
  });

  it("re-imports in place instead of duplicating", async () => {
    const r = (await api(`/api/assets/${modelId}/import`, { method: "POST", body: "{}" })).body;
    expect(r).toMatchObject({ ok: true, replaced: true, path: "Workspace.Lantern" });
  });

  it("pulls the Studio selection back into an asset", async () => {
    const r = (await api("/api/studio/pull", { method: "POST", body: "{}" })).body;
    expect(r.ok).toBe(true);
    const pulled = (await api(`/api/assets/${r.id}`)).body;
    expect(pulled.kind).toBe("model");
    expect(pulled.spec.parts.map((p: { name: string }) => p.name).sort()).toEqual(["Base", "Bulb", "Pole"]);
    expect(pulled.origin).toBe("studio");
  });

  it("exports .rbxmx, .luau and .json", async () => {
    const rbxmx = await fetch(`${BASE}/api/assets/${modelId}/export?format=rbxmx`);
    expect(rbxmx.headers.get("content-disposition")).toContain("Lantern.rbxmx");
    expect(await rbxmx.text()).toContain('<Item class="Model"');
    expect(await (await fetch(`${BASE}/api/assets/${modelId}/export?format=luau`)).text()).toContain("Studio Forge");
    expect(JSON.parse(await (await fetch(`${BASE}/api/assets/${modelId}/export?format=json`)).text()).kind).toBe("model");
  });

  it("files assets under the game open in Studio and lets them move between games", async () => {
    const post = (path: string, body: unknown, method = "POST") => api(path, { method, body: JSON.stringify(body) });
    const state = (await api("/api/state")).body;
    const mock = state.games.find((g: { name: string }) => g.name === "MockPlace");
    expect(mock).toBeTruthy();
    expect(state.currentGameId).toBe(mock.id);
    // The lantern Claude built earlier was filed under the open game.
    expect(state.assets.find((a: { id: string }) => a.id === modelId).gameId).toBe(mock.id);

    const other = (await post("/api/games", { name: "Obby World" })).body;
    await waitFor("games", (e) => e.games.some((g) => g.id === other.id));
    const moved = (await post(`/api/assets/${modelId}`, { gameId: other.id }, "PATCH")).body;
    expect(moved).toMatchObject({ id: modelId, gameId: other.id });
    expect((await post(`/api/assets/${modelId}`, { gameId: "g_nope" }, "PATCH")).status).toBe(404);

    // A model saved by the user goes to the open game unless told otherwise.
    const saved = (await post("/api/assets", { kind: "model", spec: { name: "Crate", parts: [{ size: [2, 2, 2], pos: [0, 1, 0] }] } })).body;
    expect(saved.gameId).toBe(mock.id);
    const loose = (await post("/api/assets", { kind: "model", gameId: null, spec: { name: "Loose", parts: [{ size: [1, 1, 1], pos: [0, 0.5, 0] }] } })).body;
    expect(loose.gameId).toBeUndefined();

    // Deleting a game keeps its assets, unfiled.
    await post(`/api/games/${other.id}`, {}, "DELETE");
    await waitFor("asset", (e) => e.asset.id === modelId && !e.asset.gameId);

    // Previews rendered by the browser are cached per version.
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    expect((await post(`/api/assets/${saved.id}/thumb`, { version: saved.version + 1, dataUrl: png }, "PUT")).body).toEqual({ ok: false });
    expect((await post(`/api/assets/${saved.id}/thumb`, { version: saved.version, dataUrl: png }, "PUT")).body).toEqual({ ok: true });
    const thumb = await fetch(`${BASE}/api/assets/${saved.id}/thumb`);
    expect(thumb.headers.get("content-type")).toMatch(/png/);
    expect((await api("/api/state")).body.assets.find((a: { id: string }) => a.id === saved.id).thumb).toBe(saved.version);
  });

  it("makes an animation, edits it and saves it in Studio for the Animation Editor", async () => {
    const conv = (await api("/api/conversations", { method: "POST", body: "{}" })).body;
    ws.send(JSON.stringify({ type: "chat.send", convId: conv.id, text: "Make me a dance" }));
    await waitFor("status", (e) => e.convId === conv.id && e.status === "idle" && events.some((x) => x.type === "asset" && x.asset.kind === "animation" && x.asset.version === 2));
    const anim = (await api("/api/state")).body.assets.find((a: { kind: string }) => a.kind === "animation");
    expect(anim).toMatchObject({ name: "Dance", version: 2, detail: "R15 · 0.5s · loop" });
    const full = (await api(`/api/assets/${anim.id}`)).body;
    expect(full.spec.keyframes.map((k: { t: number }) => k.t)).toEqual([0, 0.25, 0.5]); // twice as fast
    expect(full.spec.keyframes[1].poses).toMatchObject({ neck: [0, 20, 0], rightKnee: [-40, 0, 0] });
    const last = (await api(`/api/conversations/${conv.id}`)).body.messages.at(-1);
    const results = last.blocks.filter((b: { type: string }) => b.type === "tool").map((b: { result?: { text: string } }) => b.result?.text ?? "");
    expect(results[0]).toMatch(/Created animation "Dance".*R15, 1s/);
    expect(results.join("\n")).toMatch(/Imported in Studio at ServerStorage\.RBX_ANIMSAVES\.Forge R15 Dummy\.Dance/);
    // The dummy rig and its KeyframeSequence are really in the (mock) place.
    const check = (await api("/api/studio/run", { method: "POST", body: JSON.stringify({ code: 'local s = game:GetService("ServerStorage").RBX_ANIMSAVES["Forge R15 Dummy"].Dance return #s:GetChildren() .. " " .. workspace["Forge R15 Dummy"].Humanoid.RigType.Name' }) })).body;
    expect(check).toMatchObject({ ok: true, output: "3 R15" });

    const starters = (await api("/api/animations/starters", { method: "POST" })).body;
    expect(starters.ids).toHaveLength(5);
    const rbxmx = await (await fetch(`${BASE}/api/assets/${starters.ids[0]}/export?format=rbxmx`)).text();
    expect(rbxmx).toContain('<Item class="KeyframeSequence"');
  });

  it("makes an effect, writes scripts straight into Studio and edits the place in single calls", async () => {
    await waitFor("studio", (e) => e.status.state === "connected" && !!e.status.studioId);
    const conv = (await api("/api/conversations", { method: "POST", body: "{}" })).body;
    ws.send(JSON.stringify({ type: "chat.send", convId: conv.id, text: "Make a portal effect" }));
    await waitFor("status", (e) => e.convId === conv.id && e.status === "idle" && events.some((x) => x.type === "message" && x.convId === conv.id && x.message.blocks.some((b) => b.type === "text" && b.text === "Done.")), 60_000);
    const last = (await api(`/api/conversations/${conv.id}`)).body.messages.at(-1);
    const results = last.blocks.filter((b: { type: string }) => b.type === "tool").map((b: { result?: { text: string } }) => b.result?.text ?? "");
    expect(results[0]).toMatch(/Created vfx "Mini Portal" \(id v_\w{6}, v1, 2 emitters: 1 emitter · 1 light\)/);
    expect(results[0]).toMatch(/Imported in Studio at Workspace\.Mini Portal/);
    expect(results[1]).toMatch(/Edited vfx "Mini Portal".*v2, 3 emitters/);
    expect(results[2]).toBe("Created Script ServerScriptService.PortalTouch (1 lines)\nCreated ModuleScript ReplicatedStorage.PortalConfig (1 lines)");
    expect(results[3]).toMatch(/^ok · 1 instances changed \(one undo step\)\n1 created Workspace\.PortalPad$/);
    expect(results[4]).toBe("in Workspace: 1 match\nPortalPad [Part] Size=8,1,8 Material=Neon");
    expect(results[5]).toMatch(/^Lighting preset night/);
    expect(results[6]).toMatch(/^Output: .*\n[\s\S]*\(stopped\)$/);
    // Scripts are not library assets; the effect is, with its emitters really in the place.
    const assets = (await api("/api/state")).body.assets as { kind: string; name: string; detail?: string }[];
    expect(assets.some((a) => a.kind === "script")).toBe(false);
    expect(assets.find((a) => a.kind === "vfx")).toMatchObject({ name: "Mini Portal", detail: "1 emitter · 1 light · 1 sparkles" });
    const check = (await api("/api/studio/run", { method: "POST", body: JSON.stringify({ code: 'local m = workspace["Mini Portal"] return m.Root.Swirl.Swirl.Rate .. " " .. tostring(m.Root.Glints:FindFirstChildOfClass("Sparkles") ~= nil) .. " " .. #m:GetChildren()' }) })).body;
    expect(check).toMatchObject({ ok: true, output: "12 true 1" });

    const starters = (await api("/api/vfx/starters", { method: "POST" })).body;
    expect(starters.ids).toHaveLength(8);
    const rbxmx = await (await fetch(`${BASE}/api/assets/${starters.ids[2]}/export?format=rbxmx`)).text();
    expect(rbxmx).toContain('<Item class="ParticleEmitter"');
    expect(rbxmx).toContain('<Item class="ModuleScript"');
  });

  it("makes an ability from a library effect and an inline projectile, and puts a castable Tool in Studio", async () => {
    await waitFor("studio", (e) => e.status.state === "connected" && !!e.status.studioId);
    const conv = (await api("/api/conversations", { method: "POST", body: "{}" })).body;
    ws.send(JSON.stringify({ type: "chat.send", convId: conv.id, text: "Make a fire power" }));
    await waitFor("status", (e) => e.convId === conv.id && e.status === "idle" && events.some((x) => x.type === "message" && x.convId === conv.id && x.message.blocks.some((b) => b.type === "text" && b.text === "Done.")), 60_000);
    const last = (await api(`/api/conversations/${conv.id}`)).body.messages.at(-1);
    const results = last.blocks.filter((b: { type: string }) => b.type === "tool").map((b: { result?: { text: string } }) => b.result?.text ?? "");
    expect(results[1]).toMatch(/^Created ability "Fire Punch" \(id b_\w{6}, v1, 2 effects, R15, [\d.]+s\)/);
    expect(results[1]).toMatch(/Imported in Studio at ReplicatedStorage\.Abilities\.Fire Punch/);
    expect(results[2]).toMatch(/^Edited ability "Fire Punch".*v2/);
    const ability = (await api("/api/state")).body.assets.find((a: { kind: string }) => a.kind === "ability");
    expect(ability).toMatchObject({ name: "Fire Punch", version: 2, detail: "R15 · 2 effects" });
    const full = (await api(`/api/assets/${ability.id}`)).body;
    expect(full.spec.events[1]).toMatchObject({ name: "Blast", duration: 0.6 });
    expect(full.spec.cooldown).toBe(2);
    // In the (mock) place: the folder with its animation, both effect templates and the impact, plus the Tool.
    const check = (await api("/api/studio/run", { method: "POST", body: JSON.stringify({ code: 'local f = game:GetService("ReplicatedStorage").Abilities["Fire Punch"] local names = {} for _, e in f.Effects:GetChildren() do table.insert(names, e.Name) end table.sort(names) return #f.Animation:GetChildren() .. " " .. table.concat(names, ",") .. " " .. game:GetService("StarterPack")["Fire Punch"].ClassName' }) })).body;
    expect(check).toMatchObject({ ok: true, output: "3 Blast,Blast Impact,Fist Tool" });

    const starters = (await api("/api/abilities/starters", { method: "POST" })).body;
    expect(starters.ids).toHaveLength(6);
    const rbxmx = await (await fetch(`${BASE}/api/assets/${starters.ids[0]}/export?format=rbxmx`)).text();
    expect(rbxmx).toMatch(/^<roblox version="4">\n<Item class="Tool"/);
    expect(rbxmx).toContain('<Item class="KeyframeSequence"');
    // Only Studio's texture folder is served, and only when Studio is installed.
    expect((await fetch(`${BASE}/api/rbxasset/textures/particles/fire_main.dds`)).status).toBe(404);
    expect((await fetch(`${BASE}/api/rbxasset/..%2Fsecret`)).status).toBe(404);
  });

  it("browses the open place: Explorer, map, scripts and selection", async () => {
    const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });
    const top = (await post("/api/place/children", { path: [] })).body;
    expect(top.items.map((i: { name: string }) => i.name)).toContain("Workspace");
    const ws = (await post("/api/place/children", { path: [["Workspace", 1]] })).body;
    expect(ws.items.find((i: { name: string }) => i.name === "Lantern")).toMatchObject({ className: "Model", parts: 3 });

    const lantern = [["Workspace", 1], ["Lantern", 1]];
    const scene = (await post("/api/place/scene", { path: lantern })).body;
    expect(scene.parts).toHaveLength(3);
    expect(scene.materials).toEqual(expect.arrayContaining(["Slate", "Metal", "Neon"]));
    await waitFor("place.progress", (e) => e.text === null);

    expect((await post("/api/place/select", { paths: [lantern] })).body).toEqual({ selected: 1 });
    const bad = await post("/api/place/script", { path: lantern });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/not a script/);
  });

  it("asks the user before running Luau in Studio, then runs it", async () => {
    const conv = (await api("/api/conversations", { method: "POST", body: "{}" })).body;
    ws.send(JSON.stringify({ type: "chat.send", convId: conv.id, text: "run some luau" }));
    const perm = await waitFor("permission", (e) => e.request.convId === conv.id);
    expect(perm.request.toolName).toBe("mcp__forge__studio_execute_luau");
    // The waiting call shows a live progress line in the chat (like Claude Code).
    await waitFor("message", (e) => e.convId === conv.id && e.message.blocks.some((b) => b.type === "tool" && b.status === "running" && b.progress === "Waiting for your approval…"));
    ws.send(JSON.stringify({ type: "permission.respond", id: perm.request.id, allow: true }));
    await waitFor("status", (e) => e.convId === conv.id && e.status === "idle");
    const full = (await api(`/api/conversations/${conv.id}`)).body;
    const tool = full.messages.at(-1).blocks.find((b: { type: string }) => b.type === "tool");
    expect(tool.result.text.trim()).toBe("2");
    expect(tool.startedAt).toBeTypeOf("number");
    expect(tool.endedAt).toBeGreaterThanOrEqual(tool.startedAt);
    expect(tool.progress).toBeUndefined();
  });

  it("queues follow-ups while a reply runs, and lets one be removed", async () => {
    const conv = (await api("/api/conversations", { method: "POST", body: "{}" })).body;
    ws.send(JSON.stringify({ type: "chat.send", convId: conv.id, text: "run some luau" }));
    // The turn is now blocked on the permission prompt, so these two wait in the queue.
    const perm = await waitFor("permission", (e) => e.request.convId === conv.id);
    ws.send(JSON.stringify({ type: "chat.send", convId: conv.id, text: "first follow-up" }));
    ws.send(JSON.stringify({ type: "chat.send", convId: conv.id, text: "second follow-up" }));
    const queued = await waitFor("queue", (e) => e.convId === conv.id && e.items.length === 2);
    expect(queued.items.map((q) => q.text)).toEqual(["first follow-up", "second follow-up"]);
    expect((await api("/api/state")).body.queues[conv.id]).toHaveLength(2);

    ws.send(JSON.stringify({ type: "chat.unqueue", convId: conv.id, id: queued.items[0].id }));
    await waitFor("queue", (e) => e.convId === conv.id && e.items.length === 1 && e.items[0].text === "second follow-up");
    ws.send(JSON.stringify({ type: "permission.respond", id: perm.request.id, allow: true }));
    await waitFor("queue", (e) => e.convId === conv.id && e.items.length === 0);
    await waitFor("message", (e) => e.convId === conv.id && e.message.blocks.some((b) => b.type === "text" && b.text === "Echo: second follow-up"));
    await waitFor("status", (e) => e.convId === conv.id && e.status === "idle" && !events.some((x) => x.type === "queue" && x.convId === conv.id && x.items.length > 0 && events.indexOf(x) > events.indexOf(e)));

    const full = (await api(`/api/conversations/${conv.id}`)).body;
    const userTexts = full.messages.filter((m: { role: string }) => m.role === "user").map((m: { blocks: { text: string }[] }) => m.blocks[0].text);
    expect(userTexts).toEqual(["run some luau", "second follow-up"]);
  });

  it("compacts at the size picked in Settings, and on request", async () => {
    expect((await api("/api/settings", { method: "PUT", body: JSON.stringify({ autoCompact: "lots" }) })).status).toBe(400);
    expect((await api("/api/settings", { method: "PUT", body: JSON.stringify({ autoCompact: 150_000 }) })).body.autoCompact).toBe(150_000);
    const conv = (await api("/api/conversations", { method: "POST", body: "{}" })).body;
    ws.send(JSON.stringify({ type: "chat.send", convId: conv.id, text: "hello there" }));
    // Claude Code was started with a window and percent that land on the chosen size.
    const ctx = await waitFor("context", (e) => e.convId === conv.id && e.state.threshold > 0);
    expect(ctx.state.enabled).toBe(true);
    expect(Math.abs(ctx.state.threshold - 150_000)).toBeLessThan(500);
    await waitFor("status", (e) => e.convId === conv.id && e.status === "idle");
    expect((await api("/api/state")).body.contexts[conv.id].threshold).toBe(ctx.state.threshold);

    ws.send(JSON.stringify({ type: "chat.compact", convId: conv.id }));
    await waitFor("context", (e) => e.convId === conv.id && !!e.state.compacting);
    const done = await waitFor("message", (e) => e.convId === conv.id && e.message.blocks.some((b) => b.type === "compact" && b.status === "done"));
    expect(done.message.blocks).toEqual([expect.objectContaining({ type: "compact", trigger: "manual", preTokens: 9204, postTokens: 1830 })]);
    await waitFor("status", (e) => e.convId === conv.id && e.status === "idle" && events.indexOf(e) > events.indexOf(done));
    const full = (await api(`/api/conversations/${conv.id}`)).body;
    // No "/compact" bubble: just the divider, with the smaller context as the latest size.
    expect(full.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(full.messages[2].usage.contextTokens).toBe(1830);

    // "/compact" typed in the composer does the same; "off" restarts Claude Code without auto-compact.
    expect((await api("/api/settings", { method: "PUT", body: JSON.stringify({ autoCompact: "off" }) })).body.autoCompact).toBe("off");
    ws.send(JSON.stringify({ type: "chat.send", convId: conv.id, text: "/compact keep the castle details" }));
    await waitFor("context", (e) => e.convId === conv.id && e.state.enabled === false);
    await waitFor("message", (e) => e.convId === conv.id && e.message.id !== done.message.id && e.message.blocks.some((b) => b.type === "compact" && b.status === "done"));
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ autoCompact: 200_000 }) });
  });

  it("keeps earlier asset versions and restores one as a new version", async () => {
    // Scripts aren't library assets anymore.
    expect((await api("/api/assets", { method: "POST", body: JSON.stringify({ kind: "script", spec: { name: "Greeter", kind: "Script", source: "print('v1')" } }) })).status).toBe(400);
    const block = (name: string) => ({ name, size: [2, 2, 2], pos: [0, 1, 0], color: "#888888" });
    const v1 = (await api("/api/assets", { method: "POST", body: JSON.stringify({ kind: "model", spec: { name: "Crate", parts: [block("A")] } }) })).body;
    await api("/api/assets", { method: "POST", body: JSON.stringify({ kind: "model", replaceId: v1.id, spec: { name: "Crate", parts: [block("A"), { ...block("B"), pos: [0, 3, 0] }] } }) });
    const versions = (await api(`/api/assets/${v1.id}/versions`)).body;
    expect(versions.map((v: { version: number; current: boolean; size: number }) => [v.version, v.current, v.size])).toEqual([[2, true, 2], [1, false, 1]]);

    const restored = (await api(`/api/assets/${v1.id}/restore`, { method: "POST", body: JSON.stringify({ version: 1 }) })).body;
    expect(restored).toMatchObject({ version: 3, spec: { parts: [expect.objectContaining({ name: "A" })] } });
    expect(restored.spec.parts).toHaveLength(1);
    expect((await api(`/api/assets/${v1.id}/versions`)).body.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    expect((await api(`/api/assets/${v1.id}/restore`, { method: "POST", body: JSON.stringify({ version: 9 }) })).status).toBe(404);
  });

  it("reports Claude plan usage live, and checks it on demand", async () => {
    // Every turn carries Claude Code's rate_limit_event; the server normalizes it (seconds → ms).
    const live = await waitFor("limits");
    expect(live.limits).toMatchObject({ status: "allowed", limitType: "five_hour", overage: { status: "rejected", inUse: false } });
    expect(live.limits.windows.five_hour.utilization).toBeGreaterThan(0);
    expect(live.limits.windows.seven_day).toMatchObject({ utilization: 0.04 });
    expect(live.limits.windows.seven_day.resetsAt).toBeGreaterThan(Date.now() + 3 * 86_400_000);
    expect((await api("/api/state")).body.limits.windows.seven_day.utilization).toBe(0.04);

    // "Check now" runs one tiny request and stops it as soon as usage arrives.
    const started = Date.now();
    const r = (await api("/api/claude/limits", { method: "POST" })).body;
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.limits.windows).toMatchObject({ five_hour: { utilization: 0.31 }, seven_day: { utilization: 0.12 } });
    await waitFor("limits", (e) => e.limits.windows.five_hour.utilization === 0.31);
  });

  it("runs Luau from the Studio console endpoint", async () => {
    const r = (await api("/api/studio/run", { method: "POST", body: JSON.stringify({ code: "return #workspace:GetChildren()" }) })).body;
    expect(r).toMatchObject({ ok: true });
    expect(Number(r.output)).toBeGreaterThanOrEqual(1);
  });

  it("updates an outdated Claude Code and moves the chat onto the new version", async () => {
    const conv = (await api("/api/conversations", { method: "POST", body: "{}" })).body;
    ws.send(JSON.stringify({ type: "chat.send", convId: conv.id, text: "is claude too old?" }));
    const failed = await waitFor("message", (e) => e.convId === conv.id && /does not support this model/.test(e.message.error ?? ""));
    expect(failed.message.error).toMatch(/Run 'claude update'/);
    await waitFor("status", (e) => e.convId === conv.id && e.status === "idle");

    const r = (await api("/api/claude/update", { method: "POST" })).body;
    expect(r).toMatchObject({ ok: true, before: "9.9.9", version: "9.9.10" });
    await waitFor("claude", (e) => e.status.version === "9.9.10");

    // The idle chat process was restarted, so the retry runs on the new version.
    ws.send(JSON.stringify({ type: "chat.send", convId: conv.id, text: "is claude too old now?" }));
    await waitFor("message", (e) => e.convId === conv.id && e.message.blocks.some((b) => b.type === "text" && b.text === "Running on Claude Code 9.9.10."));
  });

  it("rejects cross-site and unauthenticated requests", async () => {
    expect((await api("/api/state", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    const plain = await fetch(`${BASE}/api/studio/run`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(plain.status).toBe(415);
    const mcp = await fetch(`${BASE}/mcp/x`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(mcp.status).toBe(401);
    const bad = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { origin: "https://evil.example" } });
    await expect(new Promise((res, rej) => (bad.on("open", res), bad.on("error", rej)))).rejects.toThrow();
  });
});
