// Read-only views of the open Studio place for the Place tab (Explorer, map, GUIs, scripts).
// Requests that share a result buffer in Studio are serialized so it is never overwritten
// mid-transfer; Explorer listings use their own buffer and queue, so browsing stays responsive
// while a large map is transferring.

import { StudioError, type StudioBridge } from "./studio-bridge.ts";
import { pullChunkLuau, PULL_CHUNK } from "../shared/studio-luau.ts";
import {
  childrenLuau, placeUiLuau, PLACE_KEY, PLACE_TREE_KEY, sceneLuau, scriptSourceLuau, selectLuau,
  type PlaceChildren, type PlacePath, type PlaceSceneRaw,
} from "../shared/place.ts";
import { sanitizeUiSpec, UiSpecSchema, type UiSpec } from "../shared/ui.ts";

/** Up to ~24 MB of JSON per request (a very large map). */
const MAX_CHUNKS = 400;

export function parsePath(raw: unknown): PlacePath {
  if (!Array.isArray(raw)) throw new StudioError("path must be an array of [name, n] steps");
  return raw.map((step) => {
    if (!Array.isArray(step) || typeof step[0] !== "string") throw new StudioError("bad path step");
    return [step[0], Math.max(1, Math.floor(Number(step[1]) || 1))] as [string, number];
  });
}

export class PlaceReader {
  private queues = new Map<string, Promise<unknown>>();

  constructor(private bridge: StudioBridge) {}

  private serial<T>(fn: () => Promise<T>, key = PLACE_KEY): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(fn, fn);
    this.queues.set(key, next.catch(() => {}));
    return next;
  }

  /** Run Luau that returns its JSON in chunks (jsonReturnLuau) and reassemble it. */
  private async chunked<T>(code: string, onProgress?: (done: number, total: number) => void, key = PLACE_KEY): Promise<T> {
    let head = await this.bridge.runLuauJson<{ total?: number; chunk?: string; error?: string }>(code);
    if (head.error) throw new StudioError(head.error);
    if (typeof head.chunk !== "string" || typeof head.total !== "number") return head as T;
    const total = head.total;
    let json = head.chunk;
    if (total > MAX_CHUNKS * PULL_CHUNK) throw new StudioError(`This is too large to show (${(total / 1e6).toFixed(1)} MB).`);
    while (json.length < total) {
      onProgress?.(json.length, total);
      head = await this.bridge.runLuauJson(pullChunkLuau(json.length, key));
      if (head.error || !head.chunk) throw new StudioError(head.error ?? "The transfer from Studio was interrupted.");
      json += head.chunk;
    }
    return JSON.parse(json) as T;
  }

  children(path: PlacePath): Promise<PlaceChildren> {
    return this.serial(async () => {
      const res = await this.chunked<PlaceChildren>(childrenLuau(path), undefined, PLACE_TREE_KEY);
      return { items: Array.isArray(res.items) ? res.items : [], more: res.more ?? 0, placeName: res.placeName };
    }, PLACE_TREE_KEY);
  }

  scene(path: PlacePath, onProgress?: (text: string) => void): Promise<PlaceSceneRaw> {
    return this.serial(async () => {
      onProgress?.("Reading parts and terrain in Studio…");
      const raw = await this.chunked<PlaceSceneRaw>(sceneLuau(path), (done, total) =>
        onProgress?.(`Transferring the map… ${Math.round((done / total) * 100)}% of ${(total / 1e6).toFixed(1)} MB`),
      );
      // Empty Luau tables arrive as {} rather than [].
      for (const k of ["names", "classes", "materials", "nodes", "parts"] as const) if (!Array.isArray(raw[k])) raw[k] = [];
      if (raw.terrain && !Array.isArray(raw.terrain.heights)) raw.terrain = null;
      return raw;
    });
  }

  ui(path: PlacePath): Promise<{ spec: UiSpec; skipped: string[] }> {
    return this.serial(async () => {
      const data = await this.chunked<{ kind: string; spec?: unknown; skipped?: unknown }>(placeUiLuau(path));
      if (data.kind !== "ui") throw new StudioError("This isn't a ScreenGui or GUI object.");
      const { spec } = sanitizeUiSpec(UiSpecSchema.parse(data.spec));
      return { spec, skipped: Array.isArray(data.skipped) ? data.skipped : [] };
    });
  }

  script(path: PlacePath): Promise<{ name: string; className: string; source: string }> {
    return this.serial(() => this.chunked(scriptSourceLuau(path)));
  }

  select(paths: PlacePath[]): Promise<{ selected: number }> {
    return this.serial(() => this.bridge.runLuauJson<{ selected: number }>(selectLuau(paths)));
  }
}
