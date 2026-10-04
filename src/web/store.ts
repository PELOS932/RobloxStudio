import { create } from "zustand";
import { api, socket } from "./lib/api.ts";
import type {
  Asset, AssetSummary, ChatMessage, ClaudeStatus, Conversation, ConversationMeta, ConvStatus,
  HtmlConvertRequest, ImportResult, PermissionRequest, QueuedMessage, ServerEvent, Settings, StudioStatus,
} from "../shared/protocol.ts";

export type RightTab = "preview" | "assets" | "studio";
export type MobileView = "chats" | "chat" | "panel";

export interface Toast {
  id: number;
  level: "info" | "success" | "error";
  message: string;
}

interface State {
  online: boolean;
  booted: boolean;
  settings: Settings | null;
  conversations: ConversationMeta[];
  convs: Record<string, Conversation>;
  activeConvId: string | null;
  running: Record<string, ConvStatus>;
  queues: Record<string, QueuedMessage[]>;
  /** A reply finished while the tab was in the background (shown in the tab title). */
  unseenDone: boolean;
  lastError: Record<string, string | undefined>;
  assets: AssetSummary[];
  assetCache: Record<string, Asset>;
  activeAssetId: string | null;
  studio: StudioStatus;
  claude: ClaudeStatus;
  permissions: PermissionRequest[];
  toasts: Toast[];
  loginLines: string[];
  loginRunning: boolean;
  rightTab: RightTab;
  mobileView: MobileView;
  sidebarOpen: boolean;
  settingsOpen: false | "general" | "account" | "studio" | "import" | "advanced";
  htmlImportOpen: boolean;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  composerInsert: { text: string; nonce: number; replace?: boolean } | null;
  importing: Record<string, boolean>;
}

export const useStore = create<State>(() => ({
  online: false,
  booted: false,
  settings: null,
  conversations: [],
  convs: {},
  activeConvId: null,
  running: {},
  queues: {},
  unseenDone: false,
  lastError: {},
  assets: [],
  assetCache: {},
  activeAssetId: null,
  studio: { state: "disconnected", studios: [] },
  claude: { cli: "unknown" },
  permissions: [],
  toasts: [],
  loginLines: [],
  loginRunning: false,
  rightTab: "preview",
  mobileView: "chat",
  sidebarOpen: true,
  settingsOpen: false,
  htmlImportOpen: false,
  paletteOpen: false,
  shortcutsOpen: false,
  composerInsert: null,
  importing: {},
}));

const set = useStore.setState;
const get = useStore.getState;

let toastId = 0;
export function toast(message: string, level: Toast["level"] = "info") {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts.slice(-4), { id, level, message }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), level === "error" ? 8000 : 4000);
}

function upsertMessage(conv: Conversation, message: ChatMessage): Conversation {
  const i = conv.messages.findIndex((m) => m.id === message.id);
  const messages = conv.messages.slice();
  if (i >= 0) messages[i] = message;
  else messages.push(message);
  return { ...conv, messages };
}

function onEvent(e: ServerEvent) {
  switch (e.type) {
    case "boot": {
      const s = e.state;
      set((st) => ({
        booted: true,
        settings: s.settings,
        conversations: s.conversations,
        assets: s.assets,
        studio: s.studio,
        claude: s.claude,
        running: s.running,
        queues: s.queues ?? {},
        permissions: s.permissions,
        activeAssetId: st.activeAssetId ?? s.assets[0]?.id ?? null,
      }));
      const active = get().activeConvId;
      if (active) void loadConversation(active, true);
      else if (s.conversations[0]) void openConversation(s.conversations[0].id);
      break;
    }
    case "conversation":
      set((s) => {
        const list = [e.meta, ...s.conversations.filter((c) => c.id !== e.meta.id)].sort((a, b) => b.updatedAt - a.updatedAt);
        const cached = s.convs[e.meta.id];
        return { conversations: list, convs: cached ? { ...s.convs, [e.meta.id]: { ...cached, ...e.meta } } : s.convs };
      });
      break;
    case "conversation.deleted":
      set((s) => {
        const { [e.id]: _gone, ...convs } = s.convs;
        return {
          conversations: s.conversations.filter((c) => c.id !== e.id),
          convs,
          activeConvId: s.activeConvId === e.id ? null : s.activeConvId,
        };
      });
      break;
    case "message":
      set((s) => {
        const conv = s.convs[e.convId];
        if (!conv) return {};
        return { convs: { ...s.convs, [e.convId]: upsertMessage(conv, e.message) } };
      });
      break;
    case "status":
      set((s) => {
        const running = { ...s.running };
        if (e.status === "idle") delete running[e.convId];
        else running[e.convId] = e.status;
        return {
          running,
          lastError: { ...s.lastError, [e.convId]: e.error },
          unseenDone: s.unseenDone || (e.status === "idle" && !!s.running[e.convId] && document.hidden),
        };
      });
      if (e.error) toast(e.error, "error");
      break;
    case "queue":
      set((s) => ({ queues: { ...s.queues, [e.convId]: e.items } }));
      break;
    case "asset":
      set((s) => {
        const assets = [e.asset, ...s.assets.filter((a) => a.id !== e.asset.id)].sort((a, b) => b.updatedAt - a.updatedAt);
        const cached = s.assetCache[e.asset.id];
        // Specs only change with the version; import info lives on the summary.
        const assetCache = cached && cached.version !== e.asset.version ? omit(s.assetCache, e.asset.id) : s.assetCache;
        return e.focus
          ? { assets, assetCache, activeAssetId: e.asset.id, rightTab: "preview" as RightTab }
          : { assets, assetCache };
      });
      break;
    case "asset.deleted":
      set((s) => ({
        assets: s.assets.filter((a) => a.id !== e.id),
        assetCache: omit(s.assetCache, e.id),
        activeAssetId: s.activeAssetId === e.id ? (s.assets.find((a) => a.id !== e.id)?.id ?? null) : s.activeAssetId,
      }));
      break;
    case "studio":
      set({ studio: e.status });
      break;
    case "claude":
      set({ claude: e.status });
      break;
    case "settings":
      set({ settings: e.settings });
      break;
    case "permission":
      set((s) => ({ permissions: [...s.permissions.filter((p) => p.id !== e.request.id), e.request] }));
      break;
    case "permission.resolved":
      set((s) => ({ permissions: s.permissions.filter((p) => p.id !== e.id) }));
      break;
    case "login":
      set((s) => ({ loginLines: [...s.loginLines.slice(-200), e.line], loginRunning: !e.done }));
      break;
    case "toast":
      toast(e.message, e.level);
      break;
    case "convert.html":
      void handleConvert(e.id, e.request);
      break;
  }
}

/** The server asks this tab to translate HTML (it needs a real browser layout engine). */
async function handleConvert(id: string, request: HtmlConvertRequest) {
  try {
    const { convertHtmlToUi } = await import("./lib/html-to-ui.ts");
    const r = await convertHtmlToUi(request.html, { name: request.name, width: request.width, height: request.height, autoScale: request.autoScale });
    socket.send({ type: "convert.result", id, spec: r.spec, warnings: r.warnings });
  } catch (err) {
    socket.send({ type: "convert.result", id, error: err instanceof Error ? err.message : String(err) });
  }
}

function omit<T extends Record<string, unknown>>(o: T, key: string): T {
  const { [key]: _x, ...rest } = o;
  return rest as T;
}

export function startConnection() {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && get().unseenDone) set({ unseenDone: false });
  });
  socket.onEvent = onEvent;
  socket.onConnection = (up) => {
    set({ online: up });
    // This tab can render HTML, so the server may ask it to translate HTML UIs.
    if (up) socket.send({ type: "hello", capabilities: ["convert.html"] });
  };
  socket.connect();
}

// ---------------------------------------------------------------------------
// Actions

export async function loadConversation(id: string, force = false) {
  if (!force && get().convs[id]) return;
  try {
    const conv = await api<Conversation>(`/conversations/${id}`);
    set((s) => ({ convs: { ...s.convs, [id]: conv } }));
  } catch (err) {
    toast(String(err), "error");
  }
}

export async function openConversation(id: string) {
  set({ activeConvId: id, mobileView: "chat" });
  await loadConversation(id);
}

export async function newConversation(): Promise<string> {
  const conv = await api<Conversation>("/conversations", { method: "POST" });
  set((s) => ({ convs: { ...s.convs, [conv.id]: conv }, activeConvId: conv.id, mobileView: "chat" }));
  return conv.id;
}

/** Show an empty composer; the conversation is created on the first message. */
export function startNewChat() {
  set({ activeConvId: null, mobileView: "chat" });
}

export async function renameConversation(id: string, title: string) {
  const t = title.trim();
  if (!t) return;
  await api(`/conversations/${id}`, { method: "PATCH", body: { title: t } }).catch((e) => toast(String(e), "error"));
}

export async function deleteConversation(id: string) {
  await api(`/conversations/${id}`, { method: "DELETE" });
}

export async function sendMessage(text: string, images?: { mediaType: string; data: string }[]) {
  let id = get().activeConvId;
  if (!id) id = await newConversation();
  socket.send({ type: "chat.send", convId: id, text, images });
}

export function stopConversation(id: string) {
  socket.send({ type: "chat.stop", convId: id });
}

/** Drop a follow-up that hasn't started yet. */
export function unqueueMessage(convId: string, id: string) {
  socket.send({ type: "chat.unqueue", convId, id });
}

export function respondPermission(id: string, allow: boolean, always = false) {
  socket.send({ type: "permission.respond", id, allow, always });
}

export async function loadAsset(id: string): Promise<Asset | null> {
  const cached = get().assetCache[id];
  if (cached) return cached;
  try {
    const asset = await api<Asset>(`/assets/${id}`);
    set((s) => ({ assetCache: { ...s.assetCache, [id]: asset } }));
    return asset;
  } catch {
    return null;
  }
}

export function openAsset(id: string) {
  set({ activeAssetId: id, rightTab: "preview", mobileView: "panel" });
}

export async function importAsset(id: string, overrides: Record<string, unknown> = {}): Promise<ImportResult> {
  set((s) => ({ importing: { ...s.importing, [id]: true } }));
  try {
    const r = await api<ImportResult>(`/assets/${id}/import`, { body: overrides });
    if (r.ok) {
      const extra = r.optimizedFrom ? ` · ${r.parts} parts (from ${r.optimizedFrom})` : r.parts !== undefined ? ` · ${r.parts} parts` : "";
      toast(`${r.replaced ? "Updated" : "Imported"} ${r.path}${extra}`, "success");
    } else toast(r.error ?? "Import failed", "error");
    return r;
  } catch (err) {
    toast(String(err), "error");
    return { ok: false, error: String(err) };
  } finally {
    set((s) => ({ importing: { ...s.importing, [id]: false } }));
  }
}

export async function deleteAsset(id: string) {
  await api(`/assets/${id}`, { method: "DELETE" });
}

/** Make an earlier version current again; the server stores it as a new version. */
export async function restoreAssetVersion(id: string, version: number) {
  try {
    const a = await api<Asset>(`/assets/${id}/restore`, { body: { version } });
    toast(`Restored v${version} of ${a.name} as v${a.version}`, "success");
  } catch (err) {
    toast(String(err), "error");
  }
}

/** Download a conversation as Markdown. */
export async function exportConversation(id: string) {
  await loadConversation(id);
  const conv = get().convs[id];
  if (!conv) return;
  const { conversationMarkdown } = await import("./lib/export.ts");
  const blob = new Blob([conversationMarkdown(conv, get().assets)], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${conv.title.replace(/[^\w -]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "chat"}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function updateSettings(patch: Partial<Settings>) {
  try {
    const s = await api<Settings>("/settings", { method: "PUT", body: patch });
    set({ settings: s });
  } catch (err) {
    toast(String(err), "error");
  }
}

export function insertIntoComposer(text: string) {
  set({ composerInsert: { text, nonce: Date.now() }, mobileView: "chat" });
}

export function setRightTab(tab: RightTab) {
  set({ rightTab: tab });
}
