import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { detectRobloxContent, HOST, PORT, ROOT, loadSettings, saveSettings } from "./config.ts";
import { assets, bus, conversations, games, shortId } from "./store.ts";
import { StudioBridge } from "./studio-bridge.ts";
import { ForgeMcp } from "./forge-mcp.ts";
import { ClaudeManager } from "./claude.ts";
import { HtmlBridge } from "./html-bridge.ts";
import { buildLuau, buildRbxmx, importAsset, pullSelection } from "./importer.ts";
import { parsePath, PlaceReader } from "./place.ts";
import { ModelSpecSchema, sanitizeModelSpec } from "../shared/model.ts";
import { sanitizeUiSpec, UiSpecSchema } from "../shared/ui.ts";
import { ScriptSpecSchema } from "../shared/script.ts";
import { AnimationSpecSchema, sanitizeAnimationSpec } from "../shared/animation.ts";
import { sanitizeVfxSpec, VfxSpecSchema } from "../shared/vfx.ts";
import { AbilitySpecSchema, sanitizeAbilitySpec } from "../shared/ability.ts";
import { parseAutoCompact } from "../shared/context.ts";
import type { Asset } from "../shared/assets.ts";
import type { BootState, ClientEvent, ServerEvent, Settings, StudioStatus } from "../shared/protocol.ts";

let settings: Settings = loadSettings();
const getSettings = () => settings;

const bridge = new StudioBridge(getSettings);
const place = new PlaceReader(bridge);
const htmlBridge = new HtmlBridge();
const forge = new ForgeMcp({ bridge, getSettings, convertHtml: (r) => htmlBridge.convert(r) });
const claude = new ClaudeManager({ getSettings, forge, port: PORT });
// Forge tools report live progress lines onto the running tool call in the chat.
forge.progressSink = (convId, toolName, text) => claude.toolProgress(convId, toolName, text);

// ---------------------------------------------------------------------------
// Security: this server can run code in Studio and drive Claude Code, so only
// accept requests addressed to localhost from the app's own pages.

const DEV_PORT = Number(process.env.FORGE_DEV_PORT ?? 5173);
const allowedHosts = new Set(
  [PORT, DEV_PORT].flatMap((p) => [`localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`]),
);
const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

function isAllowed(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const host = String(req.headers.host ?? "");
  if (!allowedHosts.has(host)) return false;
  const origin = req.headers.origin;
  return origin === undefined || allowedOrigins.has(String(origin));
}

const app = express();
app.disable("x-powered-by");

// Claude Code → Forge MCP (bearer-token protected, no browser origin).
app.all("/mcp/:convId", express.json({ limit: "20mb" }), (req, res) => {
  if (!allowedHosts.has(String(req.headers.host ?? ""))) return void res.status(403).end();
  forge.handle(req, res).catch((err) => {
    console.error("[forge-mcp]", err);
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  });
});

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (!isAllowed(req)) return void res.status(403).json({ error: "forbidden" });
  // Force a CORS preflight for any cross-site write (which we never approve).
  if (req.method !== "GET" && req.method !== "HEAD" && !req.is("application/json")) {
    return void res.status(415).json({ error: "expected application/json" });
  }
  next();
});
app.use("/api", express.json({ limit: "25mb" }));

const api = express.Router();
app.use("/api", api);

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
};

function bootState(): BootState {
  return {
    settings,
    conversations: conversations.list(),
    assets: assets.list(),
    studio: bridge.status,
    claude: claude.status,
    running: claude.running(),
    queues: claude.queues(),
    limits: claude.limits,
    contexts: claude.contexts(),
    permissions: forge.pendingPermissions,
    games: games.list(),
    currentGameId: games.currentId,
  };
}

api.get("/state", (_req, res) => res.json(bootState()));

// Conversations -------------------------------------------------------------
api.post("/conversations", (_req, res) => res.json(conversations.create()));
api.get("/conversations/:id", (req, res) => {
  const c = conversations.get(String(req.params.id));
  if (!c) return void res.status(404).json({ error: "not found" });
  res.json(c);
});
api.patch("/conversations/:id", (req, res) => {
  conversations.rename(String(req.params.id), String(req.body?.title ?? ""));
  res.json({ ok: true });
});
api.delete("/conversations/:id", (req, res) => {
  const id = String(req.params.id);
  claude.forget(id);
  conversations.delete(id);
  res.json({ ok: true });
});

// Assets --------------------------------------------------------------------
api.get("/assets/:id", (req, res) => {
  const a = assets.get(String(req.params.id));
  if (!a) return void res.status(404).json({ error: "not found" });
  res.json(a);
});
api.delete("/assets/:id", (req, res) => res.json({ ok: assets.delete(String(req.params.id)) }));

/** Create an asset from pasted JSON (lets users bring their own specs). */
api.post("/assets", (req, res) => {
  const { kind, spec, html, replaceId, gameId } = req.body ?? {};
  const now = Date.now();
  const prev = replaceId ? assets.get(String(replaceId)) : undefined;
  if (replaceId && (!prev || prev.kind !== kind)) return void res.status(404).json({ error: "asset to replace not found" });
  const base = {
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    version: (prev?.version ?? 0) + 1,
    origin: prev?.origin ?? ("user" as const),
    lastImport: prev?.lastImport,
    // New assets are filed under the game open in Studio unless the request names one (null = none).
    gameId: prev ? prev.gameId : gameId === null ? undefined : games.get(gameId)?.id ?? games.currentId,
  };
  if (!base.gameId) delete base.gameId;
  let asset: Asset;
  if (kind === "model") {
    const s = sanitizeModelSpec(ModelSpecSchema.parse(spec));
    asset = { ...base, id: prev?.id ?? shortId("m_"), kind, name: s.name, spec: s };
  } else if (kind === "ui") {
    const s = sanitizeUiSpec(UiSpecSchema.parse(spec)).spec;
    asset = { ...base, id: prev?.id ?? shortId("u_"), kind, name: s.name, spec: s };
    if (html && typeof html.source === "string") {
      asset.html = { source: String(html.source), width: Number(html.width) || 1280, height: Number(html.height) || 720, autoScale: html.autoScale !== false };
    }
  } else if (kind === "script") {
    // Scripts go straight into Studio now; only older script assets can still be edited.
    if (!prev) return void res.status(400).json({ error: "Scripts aren't kept in the library: they go straight into Studio." });
    const s = ScriptSpecSchema.parse(spec);
    asset = { ...base, id: prev.id, kind, name: s.name, spec: s };
  } else if (kind === "animation") {
    const s = sanitizeAnimationSpec(AnimationSpecSchema.parse(spec));
    asset = { ...base, id: prev?.id ?? shortId("a_"), kind, name: s.name, spec: s, ...(s.description ? { description: s.description } : {}) };
  } else if (kind === "vfx") {
    const s = sanitizeVfxSpec(VfxSpecSchema.parse(spec));
    asset = { ...base, id: prev?.id ?? shortId("v_"), kind, name: s.name, spec: s, ...(s.description ? { description: s.description } : {}) };
  } else if (kind === "ability") {
    const s = sanitizeAbilitySpec(AbilitySpecSchema.parse(spec));
    asset = { ...base, id: prev?.id ?? shortId("b_"), kind, name: s.name, spec: s, ...(s.description ? { description: s.description } : {}) };
  } else return void res.status(400).json({ error: "kind must be model, ui, animation, vfx or ability" });
  res.json(assets.put(asset, true));
});

api.get("/assets/:id/versions", (req, res) => res.json(assets.versions(String(req.params.id))));

/** Make an earlier version current again (as a new version, so nothing is lost). */
api.post("/assets/:id/restore", (req, res) => {
  const id = String(req.params.id);
  const current = assets.get(id);
  const old = assets.version(id, Number(req.body?.version));
  if (!current || !old) return void res.status(404).json({ error: "version not found" });
  if (old.version === current.version) return void res.json(current);
  const restored = { ...old, version: current.version + 1, updatedAt: Date.now(), createdAt: current.createdAt, lastImport: current.lastImport, gameId: current.gameId } as Asset;
  if (!restored.gameId) delete restored.gameId;
  res.json(assets.put(restored, true));
});

/** Move an asset to another game (gameId null = none) and/or rename it (a new version). */
api.patch("/assets/:id", (req, res) => {
  const id = String(req.params.id);
  let a = assets.get(id);
  if (!a) return void res.status(404).json({ error: "not found" });
  const { gameId, name } = req.body ?? {};
  if (gameId !== undefined) {
    if (gameId !== null && !games.get(String(gameId))) return void res.status(404).json({ error: "game not found" });
    a = assets.setGame(id, gameId === null ? undefined : String(gameId))!;
  }
  if (typeof name === "string" && name.trim() && name.trim() !== a.name) {
    const clean = name.trim().slice(0, 60);
    a = assets.put({ ...a, name: clean, spec: { ...a.spec, name: clean }, version: a.version + 1, updatedAt: Date.now() } as Asset, false);
  }
  res.json(assets.summary(a));
});

// Preview images rendered by the browser, cached so the library never has to load every spec.
api.get("/assets/:id/thumb", (req, res) => {
  const file = assets.thumbFile(String(req.params.id));
  if (!file) return void res.status(404).end();
  res.set("Cache-Control", "private, max-age=31536000, immutable").type("png").sendFile(file);
});
api.put("/assets/:id/thumb", (req, res) => {
  const m = String(req.body?.dataUrl ?? "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m || m[1].length > 2_000_000) return void res.status(400).json({ error: "expected a PNG data URL" });
  res.json({ ok: assets.putThumb(String(req.params.id), Number(req.body?.version), Buffer.from(m[1], "base64")) });
});

/**
 * Built-in Roblox textures from the local Studio install (rbxasset://textures/…), so effect
 * previews use the real particle textures. Only files under textures/ are served.
 */
let robloxContent: string | null | undefined;
api.get("/rbxasset/*path", (req, res) => {
  if (robloxContent === undefined) robloxContent = detectRobloxContent();
  const segs = ([] as string[]).concat((req.params as { path: string | string[] }).path);
  if (!robloxContent || segs[0] !== "textures" || segs.some((s) => !/^[\w.-]+$/.test(s) || s.startsWith("."))) return void res.status(404).end();
  const file = join(robloxContent, ...segs);
  if (!existsSync(file)) return void res.status(404).end();
  res.set("Cache-Control", "private, max-age=86400").type("application/octet-stream").sendFile(file);
});

/** Add the bundled starter animations (idle, wave, walk, jump, sword slash) to the library. */
api.post("/animations/starters", (_req, res) => {
  const list = JSON.parse(readFileSync(join(ROOT, "examples", "starter-animations.json"), "utf8")) as unknown[];
  const now = Date.now();
  const created = list.map((raw, i) => {
    const spec = sanitizeAnimationSpec(AnimationSpecSchema.parse(raw));
    const asset: Asset = {
      id: shortId("a_"), kind: "animation", name: spec.name, spec, createdAt: now + i, updatedAt: now + i, version: 1, origin: "user",
      ...(spec.description ? { description: spec.description } : {}), ...(games.currentId ? { gameId: games.currentId } : {}),
    };
    return assets.put(asset, false).id;
  });
  res.json({ ids: created });
});

/** Add the bundled starter effects (campfire, aura, explosion, portal…) to the library. */
api.post("/vfx/starters", (_req, res) => {
  const list = JSON.parse(readFileSync(join(ROOT, "examples", "starter-vfx.json"), "utf8")) as unknown[];
  const now = Date.now();
  const created = list.map((raw, i) => {
    const spec = sanitizeVfxSpec(VfxSpecSchema.parse(raw));
    const asset: Asset = {
      id: shortId("v_"), kind: "vfx", name: spec.name, spec, createdAt: now + i, updatedAt: now + i, version: 1, origin: "user",
      ...(spec.description ? { description: spec.description } : {}), ...(games.currentId ? { gameId: games.currentId } : {}),
    };
    return assets.put(asset, false).id;
  });
  res.json({ ids: created });
});

/** Add the bundled starter abilities (fireball, lightning strike, healing aura…) to the library. */
api.post("/abilities/starters", (_req, res) => {
  const list = JSON.parse(readFileSync(join(ROOT, "examples", "starter-abilities.json"), "utf8")) as unknown[];
  const now = Date.now();
  const created = list.map((raw, i) => {
    const spec = sanitizeAbilitySpec(AbilitySpecSchema.parse(raw));
    const asset: Asset = {
      id: shortId("b_"), kind: "ability", name: spec.name, spec, createdAt: now + i, updatedAt: now + i, version: 1, origin: "user",
      ...(spec.description ? { description: spec.description } : {}), ...(games.currentId ? { gameId: games.currentId } : {}),
    };
    return assets.put(asset, false).id;
  });
  res.json({ ids: created });
});

// Games ---------------------------------------------------------------------
api.get("/games", (_req, res) => res.json({ games: games.list(), currentGameId: games.currentId }));
api.post("/games", (req, res) => res.json(games.create(String(req.body?.name ?? ""))));
api.patch("/games/:id", (req, res) => {
  const g = games.rename(String(req.params.id), String(req.body?.name ?? ""));
  if (!g) return void res.status(404).json({ error: "not found" });
  res.json(g);
});
api.delete("/games/:id", (req, res) => res.json({ ok: games.delete(String(req.params.id)) }));

api.post("/assets/:id/import", wrap(async (req, res) => {
  res.json(await importAsset(bridge, settings, String(req.params.id), req.body ?? {}));
}));

api.get("/assets/:id/export", (req, res) => {
  const a = assets.get(String(req.params.id));
  if (!a) return void res.status(404).json({ error: "not found" });
  const format = String(req.query.format ?? "rbxmx");
  const safe = a.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || a.id;
  const opts = { ...settings.import, placement: "camera" as const };
  if (format === "json") {
    res.setHeader("Content-Disposition", `attachment; filename="${safe}.json"`);
    return void res.type("application/json").send(JSON.stringify({ kind: a.kind, spec: a.spec }, null, 2));
  }
  if (format === "luau") {
    res.setHeader("Content-Disposition", `attachment; filename="${safe}.luau"`);
    return void res.type("text/plain").send(buildLuau(a, opts).code);
  }
  res.setHeader("Content-Disposition", `attachment; filename="${safe}.rbxmx"`);
  res.type("application/xml").send(buildRbxmx(a, opts));
});

/** Resolve rbxassetid images for the UI preview via Roblox's public thumbnail API (cached). */
const thumbs = new Map<string, { type: string; body: Buffer } | null>();
api.get("/thumb/:assetId", wrap(async (req, res) => {
  const id = String(req.params.assetId);
  if (!/^\d{1,20}$/.test(id)) return void res.status(400).end();
  if (!thumbs.has(id)) {
    let entry: { type: string; body: Buffer } | null = null;
    try {
      const meta = await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${id}&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false`, { signal: AbortSignal.timeout(8000) });
      const url = ((await meta.json()) as { data?: { imageUrl?: string; state?: string }[] }).data?.[0]?.imageUrl;
      if (url) {
        const img = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (img.ok) entry = { type: img.headers.get("content-type") ?? "image/png", body: Buffer.from(await img.arrayBuffer()) };
      }
    } catch {
      // Offline or blocked: the preview shows a placeholder.
    }
    if (thumbs.size > 300) thumbs.delete(thumbs.keys().next().value!);
    thumbs.set(id, entry);
  }
  const hit = thumbs.get(id);
  if (!hit) return void res.status(404).end();
  res.setHeader("Cache-Control", "max-age=86400");
  res.type(hit.type).send(hit.body);
}));

// Studio --------------------------------------------------------------------
api.get("/studio", (_req, res) => res.json(bridge.status));
api.post("/studio/connect", wrap(async (_req, res) => {
  await bridge.connect();
  res.json(bridge.status);
}));
api.post("/studio/disconnect", wrap(async (_req, res) => {
  await bridge.disconnect();
  res.json(bridge.status);
}));
api.post("/studio/select", (req, res) => {
  bridge.selectStudio(String(req.body?.studioId ?? ""));
  res.json(bridge.status);
});
api.post("/studio/run", wrap(async (req, res) => {
  try {
    res.json({ ok: true, output: await bridge.runLuau(String(req.body?.code ?? "")) });
  } catch (err) {
    res.json({ ok: false, output: err instanceof Error ? err.message : String(err) });
  }
}));
api.post("/studio/pull", wrap(async (_req, res) => {
  const r = await pullSelection(bridge);
  res.json({ ok: r.ok, error: r.error, skipped: r.skipped, id: r.asset?.id });
}));
// Place browser (read-only views of the open place) ---------------------------
const placeRoute = (fn: (body: any) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req.body ?? {})
    .then((out) => res.json(out))
    .catch((err) => res.status(400).json({ error: err instanceof Error ? err.message : String(err) }));
};
const placeProgress = (text: string | null) => bus.emitEvent({ type: "place.progress", text });
api.post("/place/children", placeRoute((b) => place.children(parsePath(b.path ?? []))));
api.post("/place/scene", placeRoute((b) => place.scene(parsePath(b.path), placeProgress).finally(() => placeProgress(null))));
api.post("/place/ui", placeRoute((b) => place.ui(parsePath(b.path))));
api.post("/place/script", placeRoute((b) => place.script(parsePath(b.path))));
api.post("/place/select", placeRoute((b) => place.select((Array.isArray(b.paths) ? b.paths : [b.path]).map(parsePath))));

api.post("/studio/screenshot", wrap(async (_req, res) => {
  try {
    const r = await bridge.callTool("screen_capture", { capture_id: shortId("cap_") });
    const img = r.content.find((c) => c.type === "image" && c.data);
    if (!img) return void res.json({ ok: false, error: r.content.map((c) => c.text ?? "").join("\n") || "No image returned." });
    res.json({ ok: true, dataUrl: `data:${img.mimeType ?? "image/png"};base64,${img.data}` });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}));

// Claude Code ---------------------------------------------------------------
api.post("/claude/refresh", wrap(async (_req, res) => res.json(await claude.refreshStatus())));
api.post("/claude/update", wrap(async (_req, res) => res.json(await claude.updateCli())));
api.post("/claude/limits", wrap(async (_req, res) => res.json({ limits: await claude.checkLimits() })));
api.post("/claude/login", (req, res) => {
  claude.startLogin(req.body?.method === "console" ? "console" : "claudeai");
  res.json({ ok: true });
});
api.post("/claude/login/input", (req, res) => {
  claude.loginInput(String(req.body?.text ?? ""));
  res.json({ ok: true });
});
api.post("/claude/login/cancel", (_req, res) => {
  claude.cancelLogin();
  res.json({ ok: true });
});
api.post("/claude/logout", wrap(async (_req, res) => res.json(await claude.logout())));

// Settings ------------------------------------------------------------------
api.put("/settings", wrap(async (req, res) => {
  const next = req.body as Partial<Settings>;
  if (next.autoCompact !== undefined) {
    const ac = parseAutoCompact(next.autoCompact);
    if (ac === undefined) return void res.status(400).json({ error: "autoCompact must be \"auto\", \"off\" or a token count" });
    next.autoCompact = ac;
  }
  const studioChanged = JSON.stringify(next.studio ?? settings.studio) !== JSON.stringify(settings.studio);
  settings = {
    ...settings,
    ...next,
    studio: { ...settings.studio, ...next.studio },
    import: { ...settings.import, ...next.import },
  };
  saveSettings(settings);
  bus.emitEvent({ type: "settings", settings });
  if (studioChanged && settings.studio.autoConnect) void bridge.connect();
  if (next.claudePath !== undefined) void claude.refreshStatus();
  res.json(settings);
}));

// Static web app (production build) -----------------------------------------
const webDir = join(ROOT, "dist", "web");
if (existsSync(webDir)) {
  app.use(express.static(webDir, { index: false }));
  app.get(/^\/(?!api|mcp|ws).*/, (req, res) => {
    if (!isAllowed(req)) return void res.status(403).end();
    res.sendFile(join(webDir, "index.html"));
  });
} else {
  app.get("/", (_req, res) => res.type("text/plain").send("Studio Forge API is running. Build the web app with `npm run build`, or use `npm run dev` and open http://localhost:5173."));
}

// WebSocket -----------------------------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 30 * 1024 * 1024 });
const clients = new Set<WebSocket>();

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws" || !isAllowed(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  clients.add(ws);
  send(ws, { type: "boot", state: bootState() });
  ws.on("close", () => {
    clients.delete(ws);
    htmlBridge.forget(ws);
  });
  ws.on("message", (raw) => {
    let msg: ClientEvent;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    htmlBridge.touch(ws);
    try {
      if (msg.type === "hello") {
        if (msg.capabilities?.includes("convert.html")) htmlBridge.register(ws);
      } else if (msg.type === "convert.result") htmlBridge.settle(msg.id, msg);
      else if (msg.type === "chat.send") claude.send(msg.convId, msg.text, msg.images);
      else if (msg.type === "chat.stop") claude.stop(msg.convId);
      else if (msg.type === "chat.compact") claude.compact(msg.convId, msg.instructions);
      else if (msg.type === "chat.unqueue") claude.unqueue(msg.convId, msg.id);
      else if (msg.type === "permission.respond") forge.resolvePermission(msg.id, msg.allow, msg.always);
    } catch (err) {
      send(ws, { type: "toast", level: "error", message: err instanceof Error ? err.message : String(err) });
    }
  });
});

function send(ws: WebSocket, e: ServerEvent) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
}
// The game open in Studio: new assets are filed under it, and the library opens on it.
async function syncGame(status: StudioStatus) {
  if (status.state !== "connected" || !status.studioId) return games.setCurrent(undefined);
  let place: { name: string; placeId?: string } | undefined;
  if (status.flavor === "legacy") {
    // The legacy plugin has no place list; ask Studio.
    const info = await bridge
      .runLuauJson<{ name?: string; placeId?: number }>('return game:GetService("HttpService"):JSONEncode({ name = game.Name, placeId = game.PlaceId })')
      .catch(() => null);
    if (info?.name) place = { name: info.name, placeId: info.placeId ? String(info.placeId) : undefined };
  } else {
    const window = status.studios.find((x) => x.id === status.studioId)?.name ?? "";
    const m = window.match(/^(.*?)\s*\(placeId:\s*(\d+)\)\s*$/);
    const name = (m ? m[1] : window).trim();
    if (name) place = { name, placeId: m && m[2] !== "0" ? m[2] : undefined };
  }
  games.setCurrent(place ? games.forPlace(place.name, place.placeId).id : undefined);
}
let lastPlace = "";
bus.on("event", (e: ServerEvent) => {
  if (e.type !== "studio") return;
  const key = `${e.status.state}|${e.status.studioId}|${e.status.studios.find((x) => x.id === e.status.studioId)?.name ?? ""}`;
  if (key === lastPlace) return;
  lastPlace = key;
  void syncGame(e.status);
});

bus.on("event", (e: ServerEvent) => {
  const data = JSON.stringify(e);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
});

// Start -----------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log(`Studio Forge running at http://localhost:${PORT}`);
  void claude.refreshStatus();
  if (settings.studio.autoConnect) void bridge.connect();
});

const shutdown = () => {
  claude.shutdown();
  conversations.flush();
  void bridge.disconnect(false).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
