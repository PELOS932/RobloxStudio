// Asset ⇄ Studio: deterministic conversion + execution through the Studio bridge.
// No model tokens are spent on conversion or import.

import { assets, shortId } from "./store.ts";
import { StudioError, type StudioBridge } from "./studio-bridge.ts";
import { modelToLuau, scriptToLuau, uiToLuau, type ImportOptions } from "../shared/to-luau.ts";
import { modelToRbxmx, scriptToRbxmx, uiToRbxmx } from "../shared/to-rbxmx.ts";
import { pullChunkLuau, pullSelectionLuau, PULL_CHUNK } from "../shared/studio-luau.ts";
import { ModelSpecSchema, sanitizeModelSpec } from "../shared/model.ts";
import { sanitizeUiSpec, UiSpecSchema } from "../shared/ui.ts";
import type { Asset } from "../shared/assets.ts";
import type { ImportResult, Settings } from "../shared/protocol.ts";

export function buildLuau(asset: Asset, opts: ImportOptions) {
  const o = { ...opts, assetId: asset.id, version: asset.version };
  if (asset.kind === "model") return modelToLuau(asset.spec, o);
  if (asset.kind === "ui") return uiToLuau(asset.spec, o);
  return scriptToLuau(asset.spec, o);
}

export function buildRbxmx(asset: Asset, opts: ImportOptions): string {
  const o = { ...opts, assetId: asset.id, version: asset.version };
  if (asset.kind === "model") return modelToRbxmx(asset.spec, o);
  if (asset.kind === "ui") return uiToRbxmx(asset.spec, o);
  return scriptToRbxmx(asset.spec, o);
}

export async function importAsset(
  bridge: StudioBridge,
  settings: Settings,
  id: string,
  overrides: Partial<ImportOptions> = {},
  onProgress?: (text: string) => void,
): Promise<ImportResult> {
  const asset = assets.get(id);
  if (!asset) return { ok: false, error: `No asset with id ${id}.` };
  const opts: ImportOptions = { ...settings.import, ...overrides };
  const { code, stats } = buildLuau(asset, opts);
  onProgress?.(`Running ${(code.length / 1024).toFixed(1)} KB of generated Luau in Studio…`);
  try {
    const res = await bridge.runLuauJson<ImportResult>(code);
    if (res.ok) {
      asset.lastImport = { at: Date.now(), path: res.path ?? "", version: asset.version };
      assets.put(asset, false);
      if (stats && stats.after !== stats.before) res.optimizedFrom = stats.before;
    }
    return res;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface PullResult {
  ok: boolean;
  asset?: Asset;
  skipped?: string[];
  error?: string;
}

/** Read the current Studio selection into a new asset. */
export async function pullSelection(bridge: StudioBridge, onProgress?: (text: string) => void): Promise<PullResult> {
  try {
    onProgress?.("Reading the Studio selection…");
    let head = await bridge.runLuauJson<{ total: number; chunk: string; error?: string }>(pullSelectionLuau());
    if (head.error) throw new StudioError(head.error);
    let json = head.chunk;
    while (json.length < head.total) {
      head = await bridge.runLuauJson(pullChunkLuau(json.length));
      if (head.error || !head.chunk) throw new StudioError(head.error ?? "Selection transfer was interrupted.");
      json += head.chunk;
      onProgress?.(`Transferring the selection… ${Math.min(100, Math.round((json.length / head.total) * 100))}%`);
      if (json.length > 40 * PULL_CHUNK) throw new StudioError("Selection is too large to pull.");
    }
    const data = JSON.parse(json) as { kind: string; spec: unknown; skipped?: string[] | Record<string, never> };
    const skipped = Array.isArray(data.skipped) ? data.skipped : [];
    if (data.kind === "empty") return { ok: false, error: "Nothing usable is selected in Studio (select Parts/Models or a ScreenGui/GUI objects)." };
    const now = Date.now();
    let asset: Asset;
    if (data.kind === "model") {
      const spec = sanitizeModelSpec(ModelSpecSchema.parse(data.spec));
      asset = { id: shortId("m_"), kind: "model", name: spec.name, spec, createdAt: now, updatedAt: now, version: 1, origin: "studio" };
    } else {
      const { spec } = sanitizeUiSpec(UiSpecSchema.parse(data.spec));
      asset = { id: shortId("u_"), kind: "ui", name: spec.name, spec, createdAt: now, updatedAt: now, version: 1, origin: "studio" };
    }
    assets.put(asset, true);
    return { ok: true, asset, skipped };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
