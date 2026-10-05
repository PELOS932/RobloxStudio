import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { Icon, type IconName } from "../lib/icons.tsx";
import {
  AUTO_SCENE_PARTS, loadChildren, openItem, openScene, refreshTree, selectInStudio, toggle, usePlace, type PlaceView,
} from "../lib/place.ts";
import { insertIntoComposer, openAsset, setRightTab, toast, useStore } from "../store.ts";
import { fullName, pathKey, type PlaceItem, type PlacePath, type PlaceScene, type ScenePart } from "../../shared/place.ts";
import { MATERIALS } from "../../shared/roblox-data.ts";
import { matToEulerXYZDeg, rgbToHex } from "../../shared/math.ts";
import type { Asset } from "../../shared/assets.ts";
import { PlaceViewer } from "./PlaceViewer.tsx";
import { UiPreview } from "./UiPreview.tsx";
import { ScriptView } from "./ScriptView.tsx";

// The Place tab: Roblox Studio's Explorer for the open place, read live through the Studio MCP.
// Parts, models and the whole map open in 3D, ScreenGuis in the UI preview, scripts as code.

const SERVICE_ICONS: Record<string, IconName> = {
  Workspace: "globe", Players: "person", Lighting: "light", ReplicatedFirst: "box", ReplicatedStorage: "box",
  ServerScriptService: "code", ServerStorage: "box", StarterGui: "layout", StarterPack: "box", StarterPlayer: "person",
  Teams: "person", SoundService: "sound", TextChatService: "message", MaterialService: "grid",
};
const PART_CLASSES = new Set(["Part", "MeshPart", "WedgePart", "CornerWedgePart", "TrussPart", "UnionOperation", "IntersectOperation", "NegateOperation", "SpawnLocation", "Seat", "VehicleSeat", "SkateboardPlatform"]);

export function classIcon(className: string): { icon: IconName; tone: string } {
  if (SERVICE_ICONS[className]) return { icon: SERVICE_ICONS[className], tone: "" };
  if (className === "Script") return { icon: "code", tone: "script" };
  if (className === "LocalScript") return { icon: "code", tone: "local" };
  if (className === "ModuleScript") return { icon: "code", tone: "module" };
  if (className === "Folder" || className === "Configuration") return { icon: "folder", tone: "folder" };
  if (className === "Model" || className === "Tool" || className === "Accessory") return { icon: "cube", tone: "" };
  if (PART_CLASSES.has(className)) return { icon: "box", tone: "" };
  if (/Gui$|^(Frame|TextLabel|TextButton|TextBox|ImageLabel|ImageButton|ScrollingFrame|CanvasGroup|ViewportFrame)$/.test(className)) return { icon: "layout", tone: "gui" };
  if (/Light$/.test(className)) return { icon: "light", tone: "" };
  if (className === "Sound" || className === "SoundGroup") return { icon: "sound", tone: "" };
  if (className === "Camera") return { icon: "camera", tone: "" };
  if (className === "Terrain") return { icon: "map", tone: "" };
  return { icon: "file", tone: "dim" };
}

const compact = (n: number) => (n < 1000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(n / 1000)}k`);
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const TOP = ["Camera", "Terrain"];

export function PlacePanel() {
  const studio = useStore((s) => s.studio);
  const ready = studio.state === "connected" && !!studio.studioId;
  const root = usePlace((s) => s.tree[""]);
  const view = usePlace((s) => s.view);
  const treeHidden = usePlace((s) => s.treeHidden);
  const placeName = usePlace((s) => s.placeName);
  const [filter, setFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (ready) void loadChildren([]);
  }, [ready, studio.studioId]);

  if (!ready) {
    return (
      <div className="stage">
        <div className="stage-empty">
          <div>
            <div className="big">Connect Roblox Studio to browse your place</div>
            <div>The Explorer, the map in 3D, every ScreenGui and every script, read live from Studio.</div>
            <button className="btn primary" style={{ marginTop: 14 }} onClick={() => setRightTab("studio")}>
              <Icon name="plug" /> Open the Studio tab
            </button>
          </div>
        </div>
      </div>
    );
  }

  const workspace = root?.items?.find((i) => i.className === "Workspace");
  // An unsaved place is just "DataModel"; Studio's window name is more useful then.
  const windowName = studio.studios.find((s) => s.id === studio.studioId)?.name.replace(/\s*\(placeId:.*\)$/, "");
  const place = placeName && placeName !== "DataModel" ? placeName : windowName;

  return (
    <div className={`place ${treeHidden ? "tree-hidden" : ""} ${view ? "has-view" : ""}`}>
      <div className="place-head">
        <button className={`icon-btn place-tree-toggle ${treeHidden ? "" : "active"}`} title={treeHidden ? "Show the Explorer" : "Hide the Explorer"} onClick={() => usePlace.setState({ treeHidden: !treeHidden })}>
          <Icon name="sidebar" size={15} />
        </button>
        <span className="place-name" title={place}>{place ?? "Place"}</span>
        <input className="search place-filter" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {workspace && (
          <button className="btn small" title="Load every part and the terrain of Workspace" onClick={() => openItem([["Workspace", 1]], workspace, true)}>
            <Icon name="map" size={13} /> Map
          </button>
        )}
        <button
          className={`icon-btn ${refreshing ? "spin" : ""}`}
          title="Reload from Studio"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void refreshTree().finally(() => setRefreshing(false));
          }}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <div className="place-body">
        {!treeHidden && (
          <div className="place-tree" role="tree">
            <TreeLevel path={[]} depth={0} filter={filter.trim().toLowerCase()} />
          </div>
        )}
        <div className="place-view">{view ? <ViewPane view={view} /> : <Welcome workspace={workspace} />}</div>
      </div>
    </div>
  );
}

function Welcome({ workspace }: { workspace?: PlaceItem }) {
  return (
    <div className="stage">
      <div className="stage-empty">
        <div>
          <div className="big">Pick something in the Explorer</div>
          <div>Parts and models open in 3D, ScreenGuis in the UI preview and scripts as code.</div>
          {workspace && (
            <button className="btn primary" style={{ marginTop: 14 }} onClick={() => openItem([["Workspace", 1]], workspace, true)}>
              <Icon name="map" /> View the whole map ({compact(workspace.parts)} parts)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TreeLevel({ path, depth, filter }: { path: PlacePath; depth: number; filter: string }) {
  const entry = usePlace((s) => s.tree[pathKey(path)]);
  const items = useMemo(() => {
    if (!entry?.items) return [];
    if (depth === 0) return entry.items;
    return [...entry.items].sort((a, b) => {
      const ta = TOP.indexOf(a.className), tb = TOP.indexOf(b.className);
      if (ta !== tb) return (ta < 0 ? 9 : ta) - (tb < 0 ? 9 : tb);
      return natural.compare(a.name, b.name) || a.nth - b.nth;
    });
  }, [entry?.items, depth]);
  const pad = { paddingLeft: 10 + depth * 14 };
  if (!entry || (entry.loading && !entry.items)) {
    return <div className="tree-row tree-note" style={pad}><span className="spinner" /> Loading…</div>;
  }
  if (entry.error) {
    return (
      <div className="tree-row tree-note err" style={pad} title={entry.error}>
        {entry.error} <button className="link-btn" onClick={() => void loadChildren(path, true)}>Retry</button>
      </div>
    );
  }
  return (
    <>
      {items.map((item) => (
        <TreeNode key={`${item.name}#${item.nth}`} path={[...path, [item.name, item.nth]]} item={item} depth={depth} filter={filter} />
      ))}
      {!!entry.more && <div className="tree-row tree-note" style={pad}>…and {entry.more.toLocaleString()} more</div>}
      {items.length === 0 && depth > 0 && <div className="tree-row tree-note" style={pad}>Empty</div>}
    </>
  );
}

function TreeNode({ path, item, depth, filter }: { path: PlacePath; item: PlaceItem; depth: number; filter: string }) {
  const key = pathKey(path);
  const expanded = usePlace((s) => !!s.expanded[key]);
  const selected = usePlace((s) => s.selected === key);
  if (filter && !expanded && !item.name.toLowerCase().includes(filter)) return null;
  const { icon, tone } = classIcon(item.className);
  const container = !PART_CLASSES.has(item.className) && item.parts > 0;
  return (
    <>
      <div
        className={`tree-row ${selected ? "selected" : ""}`}
        style={{ paddingLeft: 4 + depth * 14 }}
        role="treeitem"
        aria-expanded={item.children > 0 ? expanded : undefined}
        aria-selected={selected}
        tabIndex={0}
        title={`${item.name} (${item.className})`}
        onClick={() => openItem(path, item)}
        onDoubleClick={() => item.children > 0 && toggle(path)}
        onKeyDown={(e) => {
          if (e.key === "Enter") openItem(path, item);
          if ((e.key === "ArrowRight" && !expanded) || (e.key === "ArrowLeft" && expanded)) item.children > 0 && toggle(path);
        }}
      >
        <button
          className={`tree-twisty ${item.children > 0 ? "" : "none"}`}
          tabIndex={-1}
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation();
            if (item.children > 0) toggle(path);
          }}
        >
          {item.children > 0 && <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} />}
        </button>
        <span className={`tree-icon ${tone}`}><Icon name={icon} size={14} /></span>
        <span className="tree-name">{item.name}</span>
        {container && <span className="tree-meta" title={`${item.parts.toLocaleString()} parts`}>{compact(item.parts)}</span>}
      </div>
      {expanded && <TreeLevel path={path} depth={depth + 1} filter={filter} />}
    </>
  );
}

// ---------------------------------------------------------------------------

function ViewPane({ view }: { view: PlaceView }) {
  const progress = useStore((s) => s.placeProgress);
  const { icon, tone } = classIcon(view.item.className);
  const name = fullName(view.path);
  const ask = (what = name, cls = view.item.className) => insertIntoComposer(`In Studio, ${what} (${cls}): `);
  const loading = "loading" in view && view.loading;
  const error = "error" in view ? view.error : undefined;

  const select = (paths: PlacePath[]) =>
    void selectInStudio(paths)
      .then((r) => toast(r.selected ? "Selected in Studio" : "It no longer exists in Studio", r.selected ? "success" : "error"))
      .catch((e) => toast(String(e), "error"));

  const save = async () => {
    try {
      let body: { kind: string; spec: unknown };
      if (view.kind === "ui" && view.spec) body = { kind: "ui", spec: view.spec };
      else if (view.kind === "script" && view.source !== undefined) {
        body = { kind: "script", spec: { name: view.item.name, kind: view.item.className, parent: view.path.slice(0, -1).map(([n]) => n).join("."), source: view.source } };
      } else if (view.kind === "scene" && view.scene) body = { kind: "model", spec: sceneToModel(view.item.name, view.scene) };
      else return;
      const asset = await api<Asset>("/assets", { body });
      toast(`Saved "${asset.name}" to your assets`, "success");
      openAsset(asset.id);
    } catch (e) {
      toast(`Could not save: ${e instanceof Error ? e.message : e}`, "error");
    }
  };
  const canSave =
    (view.kind === "ui" && !!view.spec) ||
    (view.kind === "script" && view.source !== undefined) ||
    (view.kind === "scene" && !!view.scene && view.scene.parts.length <= 3000 && !view.scene.terrain);

  return (
    <>
      <div className="place-view-head">
        <button className="icon-btn place-back" title="Back to the Explorer" onClick={() => usePlace.setState({ treeHidden: false, view: null, selected: null })}>
          <Icon name="chevronRight" size={14} style={{ transform: "rotate(180deg)" }} />
        </button>
        <span className={`tree-icon ${tone}`}><Icon name={icon} size={15} /></span>
        <div className="grow">
          <span className="place-view-name" title={name}>{view.item.name}</span>
          <span className="sub" title={name}>{view.item.className} · {name}</span>
        </div>
        <button className="btn small" title="Select it in Studio's Explorer" onClick={() => select([view.path])}>
          <Icon name="focus" size={13} /> <span className="long">Select in Studio</span>
        </button>
        <button className="btn small" title="Ask Claude about it" onClick={() => ask()}>
          <Icon name="message" size={13} /> <span className="long">Ask Claude</span>
        </button>
        {canSave && (
          <button className="btn small" title="Copy it into your Studio Forge assets so Claude can edit it" onClick={() => void save()}>
            <Icon name="download" size={13} /> <span className="long">Save as asset</span>
          </button>
        )}
        <button className="icon-btn" title="Reload from Studio" onClick={() => openItem(view.path, view.item, true)}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <div className="stage">
        {loading ? (
          <div className="stage-empty">
            <div>
              <span className="spinner" />
              <div style={{ marginTop: 10 }}>{(view.kind === "scene" && progress) || "Reading from Studio…"}</div>
            </div>
          </div>
        ) : error ? (
          <div className="stage-empty">
            <div>
              <div className="big">Couldn't read it</div>
              <div>{error}</div>
              <button className="btn" style={{ marginTop: 12 }} onClick={() => openItem(view.path, view.item, true)}>Try again</button>
            </div>
          </div>
        ) : view.kind === "scene" && view.scene ? (
          <PlaceViewer
            scene={view.scene}
            onSelectInStudio={(p) => select([p.path])}
            onAsk={(p) => ask(fullName(p.path), p.className)}
          />
        ) : view.kind === "scene" ? (
          <div className="stage-empty">
            <div>
              <div className="big">{view.item.parts.toLocaleString()} parts{view.item.className === "Workspace" ? " and the terrain" : ""}</div>
              <div>{view.item.parts > AUTO_SCENE_PARTS ? "Large places take a moment to transfer from Studio." : "Load it in 3D."}</div>
              <button className="btn primary" style={{ marginTop: 14 }} onClick={() => void openScene(view.path, view.item)}>
                <Icon name="cube" /> Load the 3D view
              </button>
            </div>
          </div>
        ) : view.kind === "ui" && view.spec ? (
          <UiPreview spec={view.spec} onReference={(node) => ask(`${name} › ${node}`, "GuiObject")} />
        ) : view.kind === "script" && view.source !== undefined ? (
          <ScriptView source={view.source} />
        ) : (
          <div className="stage-empty">
            <div>
              <div className="big">{view.item.className}</div>
              <div>
                {view.item.children ? `${view.item.children.toLocaleString()} children. ` : ""}
                Nothing here to show in 3D, as a UI or as code.
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** A loaded scene as a Studio Forge model (supported shapes only), relative to its bottom center. */
function sceneToModel(name: string, scene: PlaceScene) {
  const { min, max } = scene.bounds;
  const origin = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
  const shape: Partial<Record<ScenePart["kind"], string>> = { ball: "ball", cylinder: "cylinder", wedge: "wedge" };
  const r = (n: number) => Math.round(n * 1000) / 1000;
  const used = new Set<string>();
  return {
    name,
    parts: scene.parts.map((p) => {
      let n = p.name, k = 2;
      while (used.has(n)) n = `${p.name}_${k++}`;
      used.add(n);
      const rot = matToEulerXYZDeg(p.rot).map((v) => Math.round(v * 100) / 100);
      return {
        name: n,
        ...(shape[p.kind] ? { shape: shape[p.kind] } : {}),
        size: p.size,
        pos: p.pos.map((v, i) => r(v - origin[i])),
        ...(rot.some((v) => v !== 0) ? { rot } : {}),
        color: rgbToHex(p.color),
        ...((MATERIALS as readonly string[]).includes(p.material) && p.material !== "Plastic" ? { material: p.material } : {}),
        ...(p.transparency ? { transparency: p.transparency } : {}),
        ...(p.group.length ? { group: p.group.join("/") } : {}),
      };
    }),
  };
}
