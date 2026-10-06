// Types shared by the local server and the web UI.

import type { Asset, AssetSummary } from "./assets.ts";
import type { AutoCompact } from "./context.ts";

export type Effort = "default" | "low" | "medium" | "high" | "xhigh" | "max";
export type ToolMode = "studio" | "full";

export interface ImportDefaults {
  placement: "camera" | "origin" | "keep";
  /** Camera placement: turn the model's front toward the camera (in 90° steps). */
  faceCamera: boolean;
  optimize: boolean;
  performance: boolean;
  replace: boolean;
}

export interface Settings {
  model: string;
  effort: Effort;
  /** studio = only Studio Forge tools (lean prompt); full = all Claude Code tools in the workspace folder. */
  toolMode: ToolMode;
  autoApproveLuau: boolean;
  /** Import assets into Studio automatically after Claude creates or edits them. */
  autoImport: boolean;
  /** Ask Claude Code for 1-hour prompt caching (ENABLE_PROMPT_CACHING_1H). */
  longCache: boolean;
  /** When Claude Code compacts the conversation: "auto", "off" or about this many tokens. */
  autoCompact: AutoCompact;
  /** Send the Studio selection and camera focus along with each message (saves a lookup call). */
  studioContext: boolean;
  claudePath: string;
  workspaceDir: string;
  studio: { command: string; args: string[]; autoConnect: boolean };
  import: ImportDefaults;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  turns: number;
}

export interface TurnUsage extends UsageTotals {
  durationMs: number;
  /** Tokens in the prompt of the last API call (context size). */
  contextTokens: number;
}

export type ToolStatus = "running" | "done" | "error" | "denied";

export type Block =
  | { type: "text"; text: string }
  | {
      /** Claude Code summarized the conversation so far (automatically or on request). */
      type: "compact";
      trigger: "auto" | "manual";
      status: "running" | "done" | "error";
      preTokens?: number;
      postTokens?: number;
      startedAt?: number;
      endedAt?: number;
    }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      input: unknown;
      inputPartial?: string;
      status: ToolStatus;
      result?: { text: string; images?: string[]; isError: boolean };
      /** When Claude started writing the call, and when its result arrived (ms). */
      startedAt?: number;
      endedAt?: number;
      /** Live status line reported by the tool while it runs (e.g. "Importing into Studio…"). */
      progress?: string;
      /** While the input streams: its full length and how many parts/nodes it has so far. */
      inputChars?: number;
      inputItems?: number;
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  blocks: Block[];
  createdAt: number;
  /** Model that produced an assistant message. */
  model?: string;
  usage?: TurnUsage;
  error?: string;
  interrupted?: boolean;
}

/** Claude Code's auto-compact state for a running conversation. */
export interface ContextState {
  enabled: boolean;
  /** Context size (tokens) at which it compacts. */
  threshold: number;
  /** Usable context window after the reply reserve. */
  window: number;
  compacting?: boolean;
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  claudeSessionId?: string;
  usage: UsageTotals;
}

export interface Conversation extends ConversationMeta {
  messages: ChatMessage[];
}

export type ConvStatus = "idle" | "starting" | "running";

export interface StudioStatus {
  state: "unconfigured" | "disconnected" | "connecting" | "connected" | "error";
  detail?: string;
  flavor?: "builtin" | "legacy";
  studios: { id: string; name: string }[];
  studioId?: string;
  command?: string;
}

export interface ClaudeStatus {
  cli: "unknown" | "missing" | "ok";
  version?: string;
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  detail?: string;
}

export interface PermissionRequest {
  id: string;
  convId: string;
  toolName: string;
  input: unknown;
  createdAt: number;
}

/** One subscription usage window as Claude Code reports it (utilization 0..1). */
export interface UsageWindow {
  utilization: number;
  /** ms since epoch */
  resetsAt?: number;
}

/** Claude subscription usage, from Claude Code's rate_limit_event (same data as /usage). */
export interface PlanUsage {
  /** "allowed", "allowed_warning" (close to a limit) or "rejected" (limit reached). */
  status: string;
  /** The window the status refers to, e.g. "five_hour" or "seven_day". */
  limitType?: string;
  resetsAt?: number;
  /** e.g. five_hour, seven_day, seven_day_opus */
  windows: Record<string, UsageWindow>;
  overage?: { status?: string; disabledReason?: string; inUse?: boolean };
  updatedAt: number;
}

/** A game (Studio place) the library is organized by. */
export interface Game {
  id: string;
  name: string;
  /** Roblox PlaceId once the place is published. */
  placeId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BootState {
  settings: Settings;
  conversations: ConversationMeta[];
  assets: AssetSummary[];
  studio: StudioStatus;
  claude: ClaudeStatus;
  running: Record<string, ConvStatus>;
  /** Follow-up messages waiting for the current turn to finish, per conversation. */
  queues: Record<string, QueuedMessage[]>;
  permissions: PermissionRequest[];
  /** Latest subscription usage (null until Claude Code has reported it). */
  limits: PlanUsage | null;
  /** Auto-compact state of conversations with a running Claude Code. */
  contexts: Record<string, ContextState>;
  games: Game[];
  /** The game open in Studio right now, if any. */
  currentGameId?: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
}

/** One stored version of an asset (the current one included). */
export interface AssetVersion {
  version: number;
  updatedAt: number;
  size: number;
  name: string;
  current: boolean;
}

export type ServerEvent =
  | { type: "boot"; state: BootState }
  | { type: "conversation"; meta: ConversationMeta }
  | { type: "conversation.deleted"; id: string }
  | { type: "message"; convId: string; message: ChatMessage }
  | { type: "status"; convId: string; status: ConvStatus; error?: string }
  | { type: "queue"; convId: string; items: QueuedMessage[] }
  | { type: "limits"; limits: PlanUsage }
  | { type: "context"; convId: string; state: ContextState }
  | { type: "place.progress"; text: string | null }
  | { type: "games"; games: Game[]; currentGameId?: string }
  | { type: "asset"; asset: AssetSummary; focus?: boolean }
  | { type: "asset.deleted"; id: string }
  | { type: "studio"; status: StudioStatus }
  | { type: "claude"; status: ClaudeStatus }
  | { type: "settings"; settings: Settings }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission.resolved"; id: string }
  | { type: "login"; line: string; done?: boolean }
  | { type: "toast"; level: "info" | "success" | "error"; message: string }
  | { type: "convert.html"; id: string; request: HtmlConvertRequest };

export interface HtmlConvertRequest {
  name: string;
  html: string;
  width: number;
  height: number;
  autoScale: boolean;
}

export type ClientEvent =
  | { type: "chat.send"; convId: string; text: string; images?: { mediaType: string; data: string }[] }
  | { type: "chat.stop"; convId: string }
  /** The user is typing: start Claude Code now so the first reply comes sooner. */
  | { type: "chat.warm"; convId: string }
  | { type: "chat.compact"; convId: string; instructions?: string }
  | { type: "chat.unqueue"; convId: string; id: string }
  | { type: "permission.respond"; id: string; allow: boolean; always?: boolean }
  | { type: "convert.result"; id: string; spec?: unknown; warnings?: string[]; error?: string }
  | { type: "hello"; capabilities: string[] };

export interface ImportResult {
  ok: boolean;
  path?: string;
  parts?: number;
  elements?: number;
  replaced?: boolean;
  error?: string;
  optimizedFrom?: number;
}

export type { Asset, AssetSummary, AutoCompact };
