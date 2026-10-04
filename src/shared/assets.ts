import type { ModelSpec } from "./model.ts";
import type { UiSpec } from "./ui.ts";
import type { ScriptSpec } from "./script.ts";

export type AssetKind = "model" | "ui" | "script";

interface AssetBase {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  origin: "claude" | "studio" | "user";
  /** Last successful Studio import, if any. */
  lastImport?: { at: number; path: string; version: number };
}

export type Asset =
  | (AssetBase & { kind: "model"; spec: ModelSpec })
  | (AssetBase & { kind: "ui"; spec: UiSpec })
  | (AssetBase & { kind: "script"; spec: ScriptSpec });

export interface AssetSummary {
  id: string;
  kind: AssetKind;
  name: string;
  version: number;
  updatedAt: number;
  size: number;
  lastImport?: Asset["lastImport"];
}

export function summarize(a: Asset): AssetSummary {
  const size = a.kind === "model" ? a.spec.parts.length : a.kind === "ui" ? a.spec.nodes.length : a.spec.source.split("\n").length;
  return { id: a.id, kind: a.kind, name: a.name, version: a.version, updatedAt: a.updatedAt, size, lastImport: a.lastImport };
}

export function sizeLabel(kind: AssetKind, size: number): string {
  if (kind === "model") return `${size} part${size === 1 ? "" : "s"}`;
  if (kind === "ui") return `${size} element${size === 1 ? "" : "s"}`;
  return `${size} line${size === 1 ? "" : "s"}`;
}
