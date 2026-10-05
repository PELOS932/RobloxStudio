import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.ts";
import { summarize, type Asset, type AssetSummary } from "../shared/assets.ts";
import type { AssetVersion, Conversation, ConversationMeta, Game, ServerEvent, UsageTotals } from "../shared/protocol.ts";

/** Fan-out of server events to every connected browser tab. */
export const bus = new (class extends EventEmitter {
  emitEvent(e: ServerEvent) {
    this.emit("event", e);
  }
})();

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Short ids (prefix + 6 chars) keep tool calls and results cheap in tokens. */
export function shortId(prefix: string): string {
  let id = "";
  for (const b of randomBytes(6)) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return prefix + id;
}

function writeJsonAtomic(file: string, data: unknown) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

function readJsonDir<T>(dir: string): T[] {
  const out: T[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch {
      // Skip corrupt files rather than failing startup.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

function pick(a: Asset) {
  return { version: a.version, updatedAt: a.updatedAt, size: summarize(a).size, name: a.name };
}

/** Earlier versions kept per asset, so a bad edit can be rolled back. */
const MAX_HISTORY = 25;

class AssetStore {
  private dir = join(DATA_DIR, "assets");
  private historyDir = join(DATA_DIR, "assets", "history");
  private thumbDir = join(DATA_DIR, "thumbs");
  private assets = new Map<string, Asset>();
  /** Asset id → version of its stored preview image. */
  private thumbs = new Map<string, number>();

  constructor() {
    for (const a of readJsonDir<Asset>(this.dir)) this.assets.set(a.id, a);
    mkdirSync(this.thumbDir, { recursive: true });
    for (const f of readdirSync(this.thumbDir)) {
      const m = f.match(/^(.+)-(\d+)\.png$/);
      if (m) this.thumbs.set(m[1], Math.max(this.thumbs.get(m[1]) ?? 0, Number(m[2])));
    }
  }

  summary(a: Asset): AssetSummary {
    const thumb = this.thumbs.get(a.id);
    return thumb === a.version ? { ...summarize(a), thumb } : summarize(a);
  }

  list(): AssetSummary[] {
    return [...this.assets.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((a) => this.summary(a));
  }

  /** Library metadata that doesn't make a new version (the game it is filed under). */
  setGame(id: string, gameId: string | undefined): Asset | undefined {
    const a = this.assets.get(id);
    if (!a) return undefined;
    if (gameId) a.gameId = gameId;
    else delete a.gameId;
    writeJsonAtomic(join(this.dir, `${a.id}.json`), a);
    bus.emitEvent({ type: "asset", asset: this.summary(a), focus: false });
    return a;
  }

  /** Store the preview image the browser rendered for this version (PNG bytes). */
  putThumb(id: string, version: number, png: Buffer): boolean {
    const a = this.assets.get(id);
    if (!a || a.version !== version) return false;
    const prev = this.thumbs.get(id);
    if (prev !== undefined) rmSync(join(this.thumbDir, `${id}-${prev}.png`), { force: true });
    writeFileSync(join(this.thumbDir, `${id}-${version}.png`), png);
    this.thumbs.set(id, version);
    bus.emitEvent({ type: "asset", asset: this.summary(a), focus: false });
    return true;
  }

  thumbFile(id: string): string | undefined {
    const v = this.thumbs.get(id);
    const file = v === undefined ? undefined : join(this.thumbDir, `${id}-${v}.png`);
    return file && existsSync(file) ? file : undefined;
  }

  get(id: string): Asset | undefined {
    return this.assets.get(id);
  }

  /** Insert or replace (bumping the version) and broadcast. The replaced version goes to history. */
  put(asset: Asset, focus = true): Asset {
    const prev = this.assets.get(asset.id);
    if (prev && prev.version !== asset.version) this.archive(prev);
    this.assets.set(asset.id, asset);
    writeJsonAtomic(join(this.dir, `${asset.id}.json`), asset);
    bus.emitEvent({ type: "asset", asset: this.summary(asset), focus });
    return asset;
  }

  private archive(prev: Asset) {
    const dir = join(this.historyDir, prev.id);
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(join(dir, `${prev.version}.json`), prev);
    const old = this.storedVersions(prev.id).slice(0, -MAX_HISTORY);
    for (const v of old) rmSync(join(dir, `${v}.json`), { force: true });
  }

  private storedVersions(id: string): number[] {
    try {
      return readdirSync(join(this.historyDir, id))
        .map((f) => Number(f.replace(/\.json$/, "")))
        .filter((n) => Number.isInteger(n))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  /** Every stored version, newest first, the current one included. */
  versions(id: string): AssetVersion[] {
    const current = this.assets.get(id);
    if (!current) return [];
    const out: AssetVersion[] = [];
    for (const v of this.storedVersions(id)) {
      const a = this.version(id, v);
      if (a && v !== current.version) out.push({ ...pick(a), current: false });
    }
    out.push({ ...pick(current), current: true });
    return out.reverse();
  }

  version(id: string, version: number): Asset | undefined {
    const current = this.assets.get(id);
    if (current?.version === version) return current;
    try {
      return JSON.parse(readFileSync(join(this.historyDir, id, `${version}.json`), "utf8"));
    } catch {
      return undefined;
    }
  }

  delete(id: string): boolean {
    if (!this.assets.delete(id)) return false;
    rmSync(join(this.dir, `${id}.json`), { force: true });
    rmSync(join(this.historyDir, id), { recursive: true, force: true });
    const thumb = this.thumbs.get(id);
    if (thumb !== undefined) rmSync(join(this.thumbDir, `${id}-${thumb}.png`), { force: true });
    this.thumbs.delete(id);
    bus.emitEvent({ type: "asset.deleted", id });
    return true;
  }
}

// ---------------------------------------------------------------------------

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 };
}

class ConversationStore {
  private dir = join(DATA_DIR, "conversations");
  private convs = new Map<string, Conversation>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor() {
    for (const c of readJsonDir<Conversation>(this.dir)) this.convs.set(c.id, c);
  }

  list(): ConversationMeta[] {
    return [...this.convs.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(meta);
  }

  get(id: string): Conversation | undefined {
    return this.convs.get(id);
  }

  create(title = "New chat"): Conversation {
    const now = Date.now();
    const c: Conversation = { id: shortId("c_"), title, createdAt: now, updatedAt: now, usage: emptyUsage(), messages: [] };
    this.convs.set(c.id, c);
    this.save(c, true);
    return c;
  }

  /** Persist (debounced while streaming) and broadcast metadata. */
  save(c: Conversation, immediate = false) {
    c.updatedAt = Date.now();
    const write = () => {
      this.timers.delete(c.id);
      if (this.convs.has(c.id)) writeJsonAtomic(join(this.dir, `${c.id}.json`), c);
    };
    clearTimeout(this.timers.get(c.id));
    if (immediate) write();
    else this.timers.set(c.id, setTimeout(write, 500));
    bus.emitEvent({ type: "conversation", meta: meta(c) });
  }

  rename(id: string, title: string) {
    const c = this.convs.get(id);
    if (!c) return;
    c.title = title.slice(0, 120);
    this.save(c, true);
  }

  delete(id: string) {
    clearTimeout(this.timers.get(id));
    this.convs.delete(id);
    rmSync(join(this.dir, `${id}.json`), { force: true });
    bus.emitEvent({ type: "conversation.deleted", id });
  }

  flush() {
    for (const [id, t] of this.timers) {
      clearTimeout(t);
      const c = this.convs.get(id);
      if (c) writeJsonAtomic(join(this.dir, `${id}.json`), c);
    }
    this.timers.clear();
  }
}

function meta(c: Conversation): ConversationMeta {
  const { messages: _messages, ...rest } = c;
  return rest;
}

/** Games (Studio places) the library is organized by. */
class GameStore {
  private file = join(DATA_DIR, "games.json");
  private games: Game[] = [];
  /** The game open in Studio right now. */
  currentId: string | undefined;

  constructor() {
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(saved)) this.games = saved;
    } catch {
      // No games yet.
    }
  }

  list(): Game[] {
    return [...this.games].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  }

  get(id: string | undefined): Game | undefined {
    return id ? this.games.find((g) => g.id === id) : undefined;
  }

  private changed() {
    writeJsonAtomic(this.file, this.games);
    this.emit();
  }

  emit() {
    bus.emitEvent({ type: "games", games: this.list(), currentGameId: this.currentId });
  }

  create(name: string, placeId?: string): Game {
    const now = Date.now();
    const g: Game = { id: shortId("g_"), name: name.trim().slice(0, 80) || "Untitled game", ...(placeId ? { placeId } : {}), createdAt: now, updatedAt: now };
    this.games.push(g);
    this.changed();
    return g;
  }

  rename(id: string, name: string): Game | undefined {
    const g = this.get(id);
    if (!g || !name.trim()) return g;
    g.name = name.trim().slice(0, 80);
    g.updatedAt = Date.now();
    this.changed();
    return g;
  }

  /** Delete a game; its assets stay in the library, unfiled. */
  delete(id: string): boolean {
    const before = this.games.length;
    this.games = this.games.filter((g) => g.id !== id);
    if (this.games.length === before) return false;
    for (const a of assets.list()) if (a.gameId === id) assets.setGame(a.id, undefined);
    if (this.currentId === id) this.currentId = undefined;
    this.changed();
    return true;
  }

  /** The game for a Studio place: by PlaceId once published, otherwise by name. Created on first use. */
  forPlace(name: string, placeId?: string): Game {
    const byId = placeId ? this.games.find((g) => g.placeId === placeId) : undefined;
    if (byId) return byId;
    const byName = this.games.find((g) => !g.placeId && g.name.toLowerCase() === name.toLowerCase());
    if (byName) {
      if (placeId) {
        byName.placeId = placeId;
        byName.updatedAt = Date.now();
        this.changed();
      }
      return byName;
    }
    return this.create(name, placeId);
  }

  setCurrent(id: string | undefined) {
    if (this.currentId === id) return;
    this.currentId = id;
    this.emit();
  }
}

export const assets = new AssetStore();
export const games = new GameStore();
export const conversations = new ConversationStore();
