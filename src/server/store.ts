import { EventEmitter } from "node:events";
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.ts";
import { summarize, type Asset, type AssetSummary } from "../shared/assets.ts";
import type { Conversation, ConversationMeta, ServerEvent, UsageTotals } from "../shared/protocol.ts";

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

class AssetStore {
  private dir = join(DATA_DIR, "assets");
  private assets = new Map<string, Asset>();

  constructor() {
    for (const a of readJsonDir<Asset>(this.dir)) this.assets.set(a.id, a);
  }

  list(): AssetSummary[] {
    return [...this.assets.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summarize);
  }

  get(id: string): Asset | undefined {
    return this.assets.get(id);
  }

  /** Insert or replace (bumping the version) and broadcast. */
  put(asset: Asset, focus = true): Asset {
    this.assets.set(asset.id, asset);
    writeJsonAtomic(join(this.dir, `${asset.id}.json`), asset);
    bus.emitEvent({ type: "asset", asset: summarize(asset), focus });
    return asset;
  }

  delete(id: string): boolean {
    if (!this.assets.delete(id)) return false;
    rmSync(join(this.dir, `${id}.json`), { force: true });
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

export const assets = new AssetStore();
export const conversations = new ConversationStore();
