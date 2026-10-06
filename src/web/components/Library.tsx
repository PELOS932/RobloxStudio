import { useEffect, useMemo, useRef, useState } from "react";
import {
  createGame, deleteAsset, deleteGame, importAsset, openAsset, renameGame, setLibraryTab, setRightTab, toast, updateAssetMeta, useStore,
  type LibraryTab,
} from "../store.ts";
import { api } from "../lib/api.ts";
import { Icon, type IconName } from "../lib/icons.tsx";
import { LIBRARY_KINDS, sizeLabel, type AssetKind, type AssetSummary } from "../../shared/assets.ts";
import type { Asset, Game } from "../../shared/protocol.ts";
import { AssetThumb } from "./AssetThumb.tsx";
import { AnimatePanel } from "./AnimatePanel.tsx";
import { VfxPanel } from "./VfxPanel.tsx";
import { AbilityPanel } from "./AbilityPanel.tsx";

// The library, organized by game (Studio place), with Models, Animations, VFX and Abilities tabs. New assets
// are filed under the game open in Studio. Model previews come from cached images and turn around
// on hover. Scripts go straight into Studio and UIs live in the preview, so neither is listed here.

const inLibrary = (a: AssetSummary) => (LIBRARY_KINDS as readonly string[]).includes(a.kind);

function localGet(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function localSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice just isn't remembered.
  }
}

export function timeAgo(t: number): string {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(t).toLocaleDateString();
}

export function Library() {
  const assets = useStore((s) => s.assets);
  const games = useStore((s) => s.games);
  const currentGameId = useStore((s) => s.currentGameId);
  const selection = useStore((s) => s.libraryGame);
  const studio = useStore((s) => s.studio);
  const tab = useStore((s) => s.libraryTab);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pulling, setPulling] = useState(false);

  const studioReady = studio.state === "connected" && !!studio.studioId;
  // "open" follows the game open in Studio (everything when no place is open).
  const filter = selection === "open" ? currentGameId ?? "all" : selection === "all" || selection === "none" || games.some((g) => g.id === selection) ? selection : "all";
  const gameName = (id?: string) => (id ? games.find((g) => g.id === id)?.name : undefined);
  const inGame = (a: AssetSummary) => filter === "all" || (filter === "none" ? !a.gameId || !gameName(a.gameId) : a.gameId === filter);
  const byKind = useMemo(() => {
    const out: Record<AssetKind, AssetSummary[]> = { model: [], animation: [], vfx: [], ability: [], ui: [], script: [] };
    for (const a of assets) if (inGame(a)) out[a.kind].push(a);
    return out;
  }, [assets, games, filter]);

  const pull = async () => {
    setPulling(true);
    try {
      const r = await api<{ ok: boolean; error?: string; id?: string; skipped?: string[] }>("/studio/pull", { method: "POST" });
      if (r.ok && r.id) toast(`Saved the Studio selection${r.skipped?.length ? ` (${r.skipped.length} unsupported objects skipped)` : ""}`, "success");
      else toast(r.error ?? "Nothing was saved", "error");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setPulling(false);
    }
  };

  const title = filter === "all" ? "All games" : filter === "none" ? "Unfiled" : gameName(filter) ?? "All games";
  const tabs: [LibraryTab, string, IconName, number][] = [
    ["models", "Models", "cube", byKind.model.length],
    ["animations", "Animations", "anim", byKind.animation.length],
    ["vfx", "VFX", "flame", byKind.vfx.length],
    ["abilities", "Abilities", "wand", byKind.ability.length],
  ];

  return (
    <div className="lib">
      <div className="lib-head">
        <GameSwitcher filter={filter} title={title} />
        <span style={{ flex: 1 }} />
        {studioReady && tab === "models" && (
          <button className="btn small" disabled={pulling} title="Save what's selected in Studio (parts or models) to this library" onClick={() => void pull()}>
            {pulling ? <span className="spinner" /> : <Icon name="download" size={13} />} <span className="long">Save Studio selection</span>
          </button>
        )}
        <AddMenu onJson={() => setPasteOpen((v) => !v)} />
      </div>
      <div className="lib-subtabs" role="tablist" aria-label="Library">
        {tabs.map(([id, label, icon, n]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setLibraryTab(id)}>
            <Icon name={icon} size={14} /> {label} <span className="count">{n}</span>
          </button>
        ))}
      </div>
      {pasteOpen && <PasteJson onDone={() => setPasteOpen(false)} />}
      {tab === "models" && <ModelGrid items={byKind.model} all={assets} filter={filter} title={title} gameName={gameName} />}
      {tab === "animations" && <AnimatePanel items={byKind.animation} />}
      {tab === "vfx" && <VfxPanel items={byKind.vfx} animations={byKind.animation} />}
      {tab === "abilities" && <AbilityPanel items={byKind.ability} />}
    </div>
  );
}

function ModelGrid({ items, all, filter, title, gameName }: {
  items: AssetSummary[]; all: AssetSummary[]; filter: string; title: string; gameName: (id?: string) => string | undefined;
}) {
  const activeId = useStore((s) => s.activeAssetId);
  const [q, setQ] = useState("");
  const [view, setView] = useState<"grid" | "list">(() => (localGet("forge.libraryView") === "list" ? "list" : "grid"));
  const [hover, setHover] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const { list, elsewhere } = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (a: AssetSummary) =>
      terms.every((t) => a.name.toLowerCase().includes(t) || !!a.description?.toLowerCase().includes(t) || !!gameName(a.gameId)?.toLowerCase().includes(t));
    const list = items.filter(matches);
    const everywhere = terms.length ? all.filter((a) => a.kind === "model" && matches(a)).length : 0;
    return { list, elsewhere: Math.max(0, everywhere - list.length) };
  }, [items, all, q]);

  return (
    <>
      <div className="lib-tools">
        <div className="lib-search">
          <Icon name="search" size={13} />
          <input
            ref={searchRef}
            placeholder={`Search models in ${filter === "all" ? "every game" : title}`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQ("")}
          />
          {q && (
            <button className="icon-btn" title="Clear" onClick={() => (setQ(""), searchRef.current?.focus())}>
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
        <button
          className="icon-btn"
          title={view === "grid" ? "List view" : "Grid view"}
          onClick={() => {
            const next = view === "grid" ? "list" : "grid";
            setView(next);
            localSet("forge.libraryView", next);
          }}
        >
          <Icon name={view === "grid" ? "layout" : "grid"} size={15} />
        </button>
      </div>
      <div className={`lib-body ${view}`}>
        {list.length === 0 && (
          <div className="lib-empty">
            <div className="big">{q ? `No models in ${title} match "${q}"` : `No models in ${title} yet`}</div>
            <div>{q ? "" : "Ask Claude to build something, save your Studio selection, or move models here from another game."}</div>
          </div>
        )}
        {list.map((a) => (
          <Card
            key={a.id}
            asset={a}
            view={view}
            active={a.id === activeId}
            spin={hover === a.id}
            game={filter === "all" ? gameName(a.gameId) : undefined}
            onHover={(on) => setHover(on ? a.id : null)}
          />
        ))}
        {elsewhere > 0 && (
          <button className="lib-more" onClick={() => useStore.setState({ libraryGame: "all" })}>
            {elsewhere} more in other games — search every game
          </button>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function GameSwitcher({ filter, title }: { filter: string; title: string }) {
  const games = useStore((s) => s.games);
  const assets = useStore((s) => s.assets);
  const currentGameId = useStore((s) => s.currentGameId);
  const { open, setOpen, ref } = useMenu();
  const count = (id: string) => assets.filter((a) => inLibrary(a) && (id === "all" ? true : id === "none" ? !a.gameId || !games.some((g) => g.id === a.gameId) : a.gameId === id)).length;
  const choose = (id: string) => {
    useStore.setState({ libraryGame: id === currentGameId ? "open" : id });
    setOpen(false);
  };
  const game = games.find((g) => g.id === filter);

  return (
    <div className="dropdown" ref={ref}>
      <button className="game-btn" onClick={() => setOpen((v) => !v)} title="Choose a game">
        <Icon name="map" size={14} />
        <span className="game-name">{title}</span>
        {filter === currentGameId && <i className="sq ok" title="Open in Studio" />}
        <span className="game-count">{count(filter)}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="menu game-menu">
          <div className="menu-title">Games</div>
          <button className={filter === "all" ? "on" : ""} onClick={() => choose("all")}>
            <span>All games</span>
            <span className="game-count">{count("all")}</span>
          </button>
          {games.map((g) => (
            <button key={g.id} className={filter === g.id ? "on" : ""} onClick={() => choose(g.id)}>
              <span className="game-row">
                {g.name}
                {g.id === currentGameId && <small className="game-open"><i className="sq ok" /> open in Studio</small>}
              </span>
              <span className="game-count">{count(g.id)}</span>
            </button>
          ))}
          <button className={filter === "none" ? "on" : ""} onClick={() => choose("none")}>
            <span className="muted">Unfiled</span>
            <span className="game-count">{count("none")}</span>
          </button>
          <div className="menu-sep" />
          <button
            onClick={async () => {
              setOpen(false);
              const name = prompt("Name of the new game");
              if (!name?.trim()) return;
              const g = await createGame(name);
              if (g) useStore.setState({ libraryGame: g.id });
            }}
          >
            <span><Icon name="plus" size={13} /> New game…</span>
          </button>
          {game && (
            <>
              <button
                onClick={() => {
                  setOpen(false);
                  const name = prompt("Rename the game", game.name);
                  if (name?.trim()) void renameGame(game.id, name);
                }}
              >
                <span><Icon name="pencil" size={13} /> Rename "{game.name}"…</span>
              </button>
              <button
                className="danger"
                onClick={() => {
                  setOpen(false);
                  if (confirm(`Delete the game "${game.name}"? Its ${count(game.id)} assets stay in the library as unfiled.`)) {
                    void deleteGame(game.id);
                    useStore.setState({ libraryGame: "all" });
                  }
                }}
              >
                <span><Icon name="trash" size={13} /> Delete "{game.name}"…</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AddMenu({ onJson }: { onJson: () => void }) {
  const { open, setOpen, ref } = useMenu();
  return (
    <div className="dropdown" ref={ref}>
      <button className="icon-btn" title="Add to the library" onClick={() => setOpen((v) => !v)}>
        <Icon name="plus" size={15} />
      </button>
      {open && (
        <div className="menu menu-compact">
          <button onClick={() => (setOpen(false), useStore.setState({ htmlImportOpen: true }))}>
            <Icon name="code" size={14} /> Translate HTML into a UI
          </button>
          <button onClick={() => (setOpen(false), onJson())}>
            <Icon name="file" size={14} /> Paste a JSON spec
          </button>
        </div>
      )}
    </div>
  );
}

function Card({ asset: a, view, active, spin, game, onHover }: {
  asset: AssetSummary; view: "grid" | "list"; active: boolean; spin: boolean; game?: string; onHover: (on: boolean) => void;
}) {
  const inStudio = a.lastImport && a.lastImport.version === a.version;
  const meta = `${sizeLabel(a.kind, a.size)} · ${timeAgo(a.updatedAt)}`;
  return (
    <div
      className={`lib-card ${active ? "active" : ""}`}
      role="button"
      tabIndex={0}
      title={a.description || a.name}
      onClick={() => openAsset(a.id)}
      onKeyDown={(e) => e.key === "Enter" && openAsset(a.id)}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
    >
      {view === "grid" ? (
        <AssetThumb id={a.id} kind={a.kind} version={a.version} width="100%" height="auto" thumb={a.thumb} spin={spin} />
      ) : (
        <AssetThumb id={a.id} kind={a.kind} version={a.version} width={72} height={45} thumb={a.thumb} spin={spin} />
      )}
      <div className="lib-card-meta">
        <b>{a.name}</b>
        <small>{meta}</small>
        {(game || inStudio || a.fromHtml) && (
          <span className="lib-badges">
            {game && <span className="badge">{game}</span>}
            {a.fromHtml && <span className="badge">HTML</span>}
            {inStudio && <span className="badge ok">In Studio</span>}
          </span>
        )}
      </div>
      <CardMenu asset={a} />
    </div>
  );
}

function CardMenu({ asset: a }: { asset: AssetSummary }) {
  const games = useStore((s) => s.games);
  const studio = useStore((s) => s.studio);
  const { open, setOpen, ref } = useMenu();
  const [moving, setMoving] = useState(false);
  const ready = studio.state === "connected" && !!studio.studioId;
  const close = () => (setOpen(false), setMoving(false));
  const move = async (gameId: string | null) => {
    close();
    await updateAssetMeta(a.id, { gameId });
    const g = games.find((x) => x.id === gameId);
    toast(g ? `Moved "${a.name}" to ${g.name}` : `"${a.name}" is now unfiled`, "success");
  };
  return (
    <div className="dropdown lib-card-menu" ref={ref} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button className="icon-btn" title="More" onClick={() => setOpen((v) => !v)}>
        <Icon name="dots" size={15} />
      </button>
      {open && (
        <div className="menu menu-compact">
          {moving ? (
            <>
              <div className="menu-title">Move to</div>
              {games.map((g: Game) => (
                <button key={g.id} disabled={g.id === a.gameId} onClick={() => void move(g.id)}>
                  <Icon name="map" size={14} /> {g.name}
                </button>
              ))}
              <button disabled={!a.gameId} onClick={() => void move(null)}>
                <Icon name="x" size={14} /> No game (unfiled)
              </button>
              <button
                onClick={async () => {
                  close();
                  const name = prompt("Name of the new game");
                  if (!name?.trim()) return;
                  const g = await createGame(name);
                  if (g) void move(g.id);
                }}
              >
                <Icon name="plus" size={14} /> New game…
              </button>
            </>
          ) : (
            <>
              <button onClick={() => (close(), openAsset(a.id))}>
                <Icon name="eye" size={14} /> Open
              </button>
              <button
                onClick={() => {
                  close();
                  if (!ready) return void (setRightTab("studio"), toast("Connect Roblox Studio first.", "info"));
                  void importAsset(a.id);
                }}
              >
                <Icon name="upload" size={14} /> {a.lastImport ? "Update in Studio" : "Import to Studio"}
              </button>
              <button onClick={() => setMoving(true)}>
                <Icon name="map" size={14} /> Move to game…
              </button>
              <button
                onClick={() => {
                  close();
                  const name = prompt("Rename", a.name);
                  if (name?.trim() && name.trim() !== a.name) void updateAssetMeta(a.id, { name: name.trim() });
                }}
              >
                <Icon name="pencil" size={14} /> Rename…
              </button>
              <button onClick={() => (close(), (location.href = `/api/assets/${a.id}/export?format=rbxmx`))}>
                <Icon name="download" size={14} /> Download .rbxmx
              </button>
              <div className="menu-sep" />
              <button className="danger" onClick={() => (close(), confirm(`Delete "${a.name}"? This only removes it from Studio Forge.`) && void deleteAsset(a.id))}>
                <Icon name="trash" size={14} /> Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PasteJson({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const submit = async () => {
    try {
      const parsed = JSON.parse(text);
      const kind = parsed.kind ?? (parsed.parts ? "model" : parsed.nodes ? "ui" : parsed.emitters ? "vfx" : parsed.events ? "ability" : parsed.keyframes ? "animation" : undefined);
      const spec = parsed.spec ?? parsed;
      const asset = await api<Asset>("/assets", { body: { kind, spec } });
      openAsset(asset.id);
      onDone();
    } catch (err) {
      toast(`Could not add asset: ${err instanceof Error ? err.message : err}`, "error");
    }
  };
  return (
    <div className="lib-paste">
      <textarea className="console-input" placeholder='Paste a Studio Forge JSON export ({"kind":"model" | "animation" | "vfx" | "ui","spec":{...}})' value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn ghost" onClick={onDone}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={!text.trim()}>Add asset</button>
      </div>
    </div>
  );
}
