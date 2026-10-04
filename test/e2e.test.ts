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

  it("asks the user before running Luau in Studio, then runs it", async () => {
    const conv = (await api("/api/conversations", { method: "POST", body: "{}" })).body;
    ws.send(JSON.stringify({ type: "chat.send", convId: conv.id, text: "run some luau" }));
    const perm = await waitFor("permission", (e) => e.request.convId === conv.id);
    expect(perm.request.toolName).toBe("mcp__forge__studio_execute_luau");
    ws.send(JSON.stringify({ type: "permission.respond", id: perm.request.id, allow: true }));
    await waitFor("status", (e) => e.convId === conv.id && e.status === "idle");
    const full = (await api(`/api/conversations/${conv.id}`)).body;
    const tool = full.messages.at(-1).blocks.find((b: { type: string }) => b.type === "tool");
    expect(tool.result.text.trim()).toBe("2");
  });

  it("runs Luau from the Studio console endpoint", async () => {
    const r = (await api("/api/studio/run", { method: "POST", body: JSON.stringify({ code: "return #workspace:GetChildren()" }) })).body;
    expect(r).toMatchObject({ ok: true });
    expect(Number(r.output)).toBeGreaterThanOrEqual(1);
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
