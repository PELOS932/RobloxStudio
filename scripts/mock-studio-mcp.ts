// A stand-in for Roblox Studio's built-in MCP server, for development and tests on
// machines without Studio. It implements the same tool names and executes Luau with
// Lune (https://lune-org.github.io/docs) against a place file kept between calls.
//
// Use it by setting the Studio command in Settings to:
//   npx tsx scripts/mock-studio-mcp.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const LUNE = process.env.LUNE_BIN ?? "lune";
const dir = process.env.MOCK_STUDIO_DIR ?? mkdtempSync(join(tmpdir(), "mock-studio-"));
const place = join(dir, "place.rbxlx");
const selection = join(dir, "selection.txt");
const runner = join(import.meta.dirname, "mock-studio", "run.luau");
const STUDIO_ID = "mock-studio-1";
// 1x1 dark pixel.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const server = new McpServer({ name: "mock-studio", version: "0.0.1" });
const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });
const studioId = z.string().describe("Selects Roblox Studio instance");

server.registerTool("list_roblox_studios", { inputSchema: {} }, async () =>
  text(JSON.stringify({ studios: [{ id: STUDIO_ID, name: "MockPlace (placeId: 0)" }] })),
);

server.registerTool(
  "execute_luau",
  { inputSchema: { code: z.string(), datamodel_type: z.enum(["Edit", "Client", "Server"]), studio_id: studioId } },
  async ({ code, studio_id }) => {
    if (studio_id !== STUDIO_ID) return text("Client proxy is out of date, restart to update", true);
    const file = join(dir, "code.luau");
    writeFileSync(file, code);
    try {
      return text(execFileSync(LUNE, ["run", runner, place, file, selection], { encoding: "utf8", timeout: 60_000 }));
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      return text(`CommandExecution:1: ${e.stderr || e.message}`, true);
    }
  },
);

server.registerTool("get_studio_state", { inputSchema: { studio_id: studioId } }, async () =>
  text("- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit"),
);
server.registerTool("get_console_output", { inputSchema: { studio_id: studioId } }, async () => text("(mock) no output"));
server.registerTool(
  "screen_capture",
  { inputSchema: { capture_id: z.string(), studio_id: studioId, camera_position: z.array(z.number()).optional(), look_at_position: z.array(z.number()).optional() } },
  async () => ({ content: [{ type: "image" as const, data: PNG, mimeType: "image/png" }] }),
);
server.registerTool(
  "start_stop_play",
  { inputSchema: { is_start: z.boolean(), studio_id: studioId } },
  async ({ is_start }) => text(is_start ? "Game Started" : "Game Stopped"),
);

await server.connect(new StdioServerTransport());
