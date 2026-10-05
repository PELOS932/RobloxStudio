// State for the Place tab: the Explorer tree of the open Studio place and the view on the right.
import { create } from "zustand";
import { api } from "./api.ts";
import { decodeScene, pathKey, type PlaceChildren, type PlaceItem, type PlacePath, type PlaceScene, type PlaceSceneRaw } from "../../shared/place.ts";
import type { UiSpec } from "../../shared/ui.ts";

export interface TreeEntry {
  items?: PlaceItem[];
  more?: number;
  loading?: boolean;
  error?: string;
}

export type PlaceView =
  | { kind: "info"; path: PlacePath; item: PlaceItem }
  | { kind: "scene"; path: PlacePath; item: PlaceItem; scene?: PlaceScene; loading?: boolean; error?: string }
  | { kind: "ui"; path: PlacePath; item: PlaceItem; spec?: UiSpec; loading?: boolean; error?: string }
  | { kind: "script"; path: PlacePath; item: PlaceItem; source?: string; loading?: boolean; error?: string };

interface PlaceState {
  tree: Record<string, TreeEntry>;
  expanded: Record<string, boolean>;
  selected: string | null;
  view: PlaceView | null;
  placeName?: string;
  /** Hide the tree so the view gets the whole panel (narrow panels do this by themselves). */
  treeHidden: boolean;
}

export const usePlace = create<PlaceState>(() => ({ tree: {}, expanded: {}, selected: null, view: null, treeHidden: false }));
const set = usePlace.setState;
const get = usePlace.getState;

export const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);
export const GUI_CLASSES = new Set(["ScreenGui", "Frame", "TextLabel", "TextButton", "TextBox", "ImageLabel", "ImageButton", "ScrollingFrame"]);
/** Load the 3D view without asking below this many parts. */
export const AUTO_SCENE_PARTS = 5000;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function loadChildren(path: PlacePath, force = false) {
  const key = pathKey(path);
  const entry = get().tree[key];
  if (!force && (entry?.items || entry?.loading)) return;
  set((s) => ({ tree: { ...s.tree, [key]: { ...s.tree[key], loading: true, error: undefined } } }));
  try {
    const res = await api<PlaceChildren>("/place/children", { body: { path } });
    set((s) => ({
      tree: { ...s.tree, [key]: { items: res.items, more: res.more } },
      placeName: path.length === 0 ? res.placeName : s.placeName,
    }));
  } catch (e) {
    set((s) => ({ tree: { ...s.tree, [key]: { error: errText(e) } } }));
  }
}

export function toggle(path: PlacePath) {
  const key = pathKey(path);
  const open = !get().expanded[key];
  set((s) => ({ expanded: { ...s.expanded, [key]: open } }));
  if (open) void loadChildren(path);
}

/** Reload the whole tree, keeping what is expanded. */
export async function refreshTree() {
  const { expanded } = get();
  set({ tree: {} });
  await loadChildren([], true);
  const open = Object.keys(expanded).filter((k) => expanded[k]);
  // Re-open parents before children.
  open.sort((a, b) => a.split("/").length - b.split("/").length);
  for (const key of open) {
    const path = key.split("/").map((step) => {
      const at = step.lastIndexOf("#");
      return [step.slice(0, at), Number(step.slice(at + 1))] as [string, number];
    });
    await loadChildren(path, true);
  }
}

export function kindOf(item: PlaceItem, path: PlacePath): PlaceView["kind"] {
  if (SCRIPT_CLASSES.has(item.className)) return "script";
  if (GUI_CLASSES.has(item.className) && path[0]?.[0] !== "Workspace") return "ui";
  if (item.parts > 0) return "scene";
  return "info";
}

export function openItem(path: PlacePath, item: PlaceItem, force = false) {
  const kind = kindOf(item, path);
  set({ selected: pathKey(path) });
  if (kind === "script") return void openScript(path, item);
  if (kind === "ui") return void openUi(path, item);
  if (kind === "scene" && (force || (item.parts <= AUTO_SCENE_PARTS && item.className !== "Workspace"))) return void openScene(path, item);
  set({ view: kind === "scene" ? { kind: "scene", path, item } : { kind: "info", path, item } });
}

const current = (path: PlacePath) => get().view && pathKey(get().view!.path) === pathKey(path);

export async function openScene(path: PlacePath, item: PlaceItem) {
  set({ view: { kind: "scene", path, item, loading: true } });
  try {
    const raw = await api<PlaceSceneRaw>("/place/scene", { body: { path } });
    const scene = decodeScene(raw, path);
    if (current(path)) set({ view: { kind: "scene", path, item, scene } });
  } catch (e) {
    if (current(path)) set({ view: { kind: "scene", path, item, error: errText(e) } });
  }
}

async function openUi(path: PlacePath, item: PlaceItem) {
  set({ view: { kind: "ui", path, item, loading: true } });
  try {
    const { spec } = await api<{ spec: UiSpec }>("/place/ui", { body: { path } });
    if (current(path)) set({ view: { kind: "ui", path, item, spec } });
  } catch (e) {
    if (current(path)) set({ view: { kind: "ui", path, item, error: errText(e) } });
  }
}

async function openScript(path: PlacePath, item: PlaceItem) {
  set({ view: { kind: "script", path, item, loading: true } });
  try {
    const { source } = await api<{ source: string }>("/place/script", { body: { path } });
    if (current(path)) set({ view: { kind: "script", path, item, source } });
  } catch (e) {
    if (current(path)) set({ view: { kind: "script", path, item, error: errText(e) } });
  }
}

export function selectInStudio(paths: PlacePath[]) {
  return api<{ selected: number }>("/place/select", { body: { paths } });
}
