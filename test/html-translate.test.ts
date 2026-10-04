// HTML → Roblox translation, end to end: Claude (fake CLI) calls create_ui_html, the server
// hands the HTML to the open browser tab (real Chromium), the browser translates it, and the
// resulting UI must convert to identical instance trees via Luau and .rbxmx (checked in Lune).
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Browser } from "playwright-core";
import type { ServerEvent } from "../src/shared/protocol.ts";
import type { UiNode, UiSpec } from "../src/shared/ui.ts";
import { uiToLuau } from "../src/shared/to-luau.ts";
import { uiToRbxmx } from "../src/shared/to-rbxmx.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 4950 + Math.floor(Math.random() * 40);
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROMIUM_PATH ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));
let lune = true;
try {
  execFileSync(process.env.LUNE_BIN ?? "lune", ["--version"], { stdio: "ignore" });
} catch {
  lune = false;
}

describe.skipIf(!CHROME)("HTML → Roblox UI translation (browser)", () => {
  let server: ChildProcess;
  let browser: Browser;
  let ws: WebSocket;
  const events: ServerEvent[] = [];

  const waitFor = <T extends ServerEvent["type"]>(type: T, pred: (e: Extract<ServerEvent, { type: T }>) => boolean, timeout = 60_000) =>
    new Promise<Extract<ServerEvent, { type: T }>>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeout);
      const check = () => {
        const hit = events.find((e) => e.type === type && pred(e as Extract<ServerEvent, { type: T }>));
        if (hit) {
          clearTimeout(t);
          res(hit as Extract<ServerEvent, { type: T }>);
        } else setTimeout(check, 50);
      };
      check();
    });
  const api = (path: string, body?: unknown) =>
    fetch(BASE + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

  beforeAll(async () => {
    execFileSync(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "error"], { cwd: ROOT });
    const data = mkdtempSync(join(tmpdir(), "forge-html-"));
    writeFileSync(join(data, "settings.json"), JSON.stringify({ claudePath: join(ROOT, "test/fake-claude.mjs"), studio: { command: "", args: [], autoConnect: false } }));
    server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src/server/index.ts")], {
      cwd: ROOT,
      env: { ...process.env, FORGE_PORT: String(PORT), FORGE_DATA_DIR: data },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((res) => server.stdout!.on("data", (d) => String(d).includes("running at") && res()));
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ executablePath: CHROME });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(BASE);
    await page.waitForFunction(() => !!(window as unknown as { __forge?: unknown }).__forge);
    ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { origin: BASE } });
    ws.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await new Promise((r) => ws.on("open", r));
  }, 90_000);

  afterAll(async () => {
    ws?.close();
    await browser?.close();
    server?.kill();
  });

  let spec: UiSpec;
  let assetId = "";
  let convId = "";
  const node = (name: string) => spec.nodes.find((n) => n.name === name) as UiNode;

  it("translates HTML from a Claude tool call into a UI asset", async () => {
    const conv = await api("/api/conversations", {});
    convId = conv.id;
    // The page's socket (it announced it can translate HTML) does the translation.
    ws.send(JSON.stringify({ type: "chat.send", convId, text: "make an html hud" }));
    const ev = await waitFor("asset", (e) => e.asset.kind === "ui" && e.asset.name === "Hud");
    assetId = ev.asset.id;
    expect(ev.asset.fromHtml).toBe(true);
    const asset = await api(`/api/assets/${assetId}`);
    spec = asset.spec;
    expect(asset.html.width).toBe(1280);
    expect(spec.autoScale).toEqual({ width: 1280, height: 720 });
  }, 90_000);

  it("keeps ids as instance names and anchors elements to their screen edge", () => {
    expect(node("Currency")).toMatchObject({ pos: [1, -16, 0, 16], anchor: [1, 0] });
    expect(node("Coins").parent).toBe("Currency");
    expect(node("Stats")).toMatchObject({ anchor: [0, 1] });
    expect(node("Stats").pos?.[2]).toBe(1);
    expect(node("Hotbar")).toMatchObject({ anchor: [0.5, 1] });
    expect(node("LevelUpToast")).toMatchObject({ type: "TextLabel", anchor: [0.5, 0], text: "⭐ Level 12 reached!" });
    expect(node("QuestTracker").pos?.[0]).toBe(1);
  });

  it("translates styling: gradients, corners, strokes, rich text, bullets", () => {
    const toast = node("LevelUpToast");
    expect(toast.gradient?.colors).toEqual(["#f59e0b", "#ef4444"]);
    expect(toast.gradient?.rotation).toBe(0);
    expect(spec.nodes.some((n) => n.name.startsWith("LevelUpToastShadow"))).toBe(true);
    const selected = spec.nodes.find((n) => n.parent === "Hotbar" && n.stroke?.color === "#facc15");
    expect(selected?.corner).toBe(10);
    const cave = spec.nodes.find((n) => n.text?.includes("Crystal Cave"));
    expect(cave?.rich).toBe(true);
    expect(cave?.text).toContain('<b><font color="#38bdf8">Crystal Cave</font></b>');
    expect(spec.nodes.find((n) => n.text?.includes("Collect 50 coins"))?.text).toContain("<s>");
    expect(spec.nodes.filter((n) => n.text === "•")).toHaveLength(3);
    expect(spec.nodes.find((n) => n.text === "Daily Quests")?.font).toBe("LuckiestGuy");
  });

  it("applies edit_ui_html edits to the stored HTML and re-translates", async () => {
    events.length = 0;
    ws.send(JSON.stringify({ type: "chat.send", convId, text: "edit html please" }));
    await waitFor("asset", (e) => e.asset.id === assetId && e.asset.version === 2);
    const asset = await api(`/api/assets/${assetId}`);
    expect(asset.html.source).toContain("Level 13 reached!");
    expect(asset.spec.nodes.find((n: UiNode) => n.name === "LevelUpToast").text).toBe("⭐ Level 13 reached!");
  }, 90_000);

  it.skipIf(!lune)("produces Luau and .rbxmx that build identical instances", () => {
    const harness = join(ROOT, "test/lune/harness.luau");
    const dir = mkdtempSync(join(tmpdir(), "forge-html-lune-"));
    const run = (mode: string, content: string) => {
      const file = join(dir, `x.${mode}`);
      writeFileSync(file, content);
      const out = execFileSync(process.env.LUNE_BIN ?? "lune", ["run", harness, mode, file, "StarterGui"], { encoding: "utf8" });
      return out.slice(out.indexOf("DUMP\n") + 5);
    };
    const opts = { assetId: "u_test01", version: 1, select: false };
    const a = run("luau", uiToLuau(spec, opts).code);
    const b = run("rbxmx", uiToRbxmx(spec, opts));
    expect(a).toBe(b);
    expect(a).toContain("Frame:AutoScaleRoot/Frame:Hotbar");
  });
});
