// Types shared by the local server and the web UI.

import type { Asset, AssetSummary } from "./assets.ts";

export type Effort = "default" | "low" | "medium" | "high" | "xhigh" | "max";
export type ToolMode = "studio" | "full";

export interface ImportDefaults {
  placement: "camera" | "origin" | "keep";
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
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      input: unknown;
      inputPartial?: string;
      status: ToolStatus;
      result?: { text: string; images?: string[]; isError: boolean };
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

export type { Asset, AssetSummary };
