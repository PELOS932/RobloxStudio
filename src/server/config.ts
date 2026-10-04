import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Settings } from "../shared/protocol.ts";

export const ROOT = resolve(import.meta.dirname, "../..");

/** Minimal .env loader (KEY=value lines) so users can drop tokens next to the app. */
function loadDotEnv() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

export const PORT = Number(process.env.FORGE_PORT ?? 4317);
export const HOST = process.env.FORGE_HOST ?? "127.0.0.1";
export const DATA_DIR = resolve(process.env.FORGE_DATA_DIR ?? join(ROOT, "data"));
/** Secret that Claude Code presents when calling the local Forge MCP endpoint. */
export const MCP_TOKEN = randomBytes(24).toString("hex");

for (const dir of ["assets", "conversations", "run"]) mkdirSync(join(DATA_DIR, dir), { recursive: true });

/** Locate the Roblox Studio built-in MCP server (StudioMCP) for this platform. */
export function detectStudioCommand(): { command: string; args: string[] } | null {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    const versions = join(local, "Roblox", "Versions");
    try {
      const candidates = readdirSync(versions)
        .filter((d) => d.startsWith("version-"))
        .map((d) => join(versions, d, "StudioMCP.exe"))
        .filter((p) => existsSync(p))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (candidates[0]) return { command: candidates[0], args: [] };
    } catch {
      // No Versions folder.
    }
    const alt = join(local, "Roblox Studio", "StudioMCP.exe");
    if (existsSync(alt)) return { command: alt, args: [] };
    const bat = join(local, "Roblox", "mcp.bat");
    if (existsSync(bat)) return { command: "cmd.exe", args: ["/c", bat] };
    return null;
  }
  if (process.platform === "darwin") {
    for (const p of [
      "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP",
      join(homedir(), "Applications/RobloxStudio.app/Contents/MacOS/StudioMCP"),
    ]) {
      if (existsSync(p)) return { command: p, args: [] };
    }
  }
  return null;
}

export const DEFAULT_SETTINGS: Settings = {
  model: "claude-opus-5-5",
  effort: "default",
  toolMode: "studio",
  autoApproveLuau: false,
  autoImport: true,
  longCache: true,
  claudePath: process.env.CLAUDE_PATH ?? "claude",
  workspaceDir: join(DATA_DIR, "workspace"),
  studio: { command: "", args: [], autoConnect: true },
  import: { placement: "camera", optimize: true, performance: true, replace: true },
};

const SETTINGS_FILE = join(DATA_DIR, "settings.json");

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      studio: { ...DEFAULT_SETTINGS.studio, ...raw.studio },
      import: { ...DEFAULT_SETTINGS.import, ...raw.import },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: Settings) {
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}
