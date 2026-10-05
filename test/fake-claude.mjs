#!/usr/bin/env node
// Minimal stand-in for `claude -p --input-format stream-json --output-format stream-json`
// used by the end-to-end test. It speaks the same event format and calls the Forge MCP
// tools over HTTP exactly like Claude Code would.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
// `claude update` moves the fake from 9.9.9 to 9.9.10 (remembered in the app's data dir).
const updatedMarker = join(process.env.FORGE_DATA_DIR ?? ".", "fake-claude-updated");
const VERSION = existsSync(updatedMarker) ? "9.9.10" : "9.9.9";
if (args.includes("--version")) {
  console.log(`${VERSION} (Fake Claude Code)`);
  process.exit(0);
}
if (args[0] === "update") {
  writeFileSync(updatedMarker, "1");
  console.log(`Current version: ${VERSION}\nSuccessfully updated from ${VERSION} to version 9.9.10`);
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }));
  process.exit(0);
}

// Like Claude Code, report subscription usage with each request (utilization 0..1, seconds).
const resetIn = (s) => Math.floor(Date.now() / 1000) + s;
const rateLimit = (session, week) => ({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed", resetsAt: resetIn(3 * 3600), rateLimitType: "five_hour", overageStatus: "rejected", overageDisabledReason: "out_of_credits", isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: session, resetsAt: resetIn(3 * 3600) }, seven_day: { utilization: week, resetsAt: resetIn(4 * 86400) } },
  },
});
// Usage check from Studio Forge: one tiny request with no tools.
if (!args.includes("--input-format") && args.includes("--tools") && args[args.indexOf("--tools") + 1] === "") {
  process.stdout.write(JSON.stringify({ ...rateLimit(0.31, 0.12), session_id: "probe" }) + "\n");
  setTimeout(() => process.exit(0), 5000); // Studio Forge should stop it once usage arrives
  await new Promise(() => {});
}

const required = ["-p", "--input-format", "--output-format", "--verbose", "--include-partial-messages", "--mcp-config", "--append-system-prompt-file", "--permission-prompt-tool", "--allowedTools"];
for (const r of required) if (!args.includes(r)) {
  console.error(`missing flag ${r}`);
  process.exit(2);
}

const mcp = JSON.parse(readFileSync(arg("--mcp-config"), "utf8")).mcpServers.forge;
const client = new Client({ name: "fake-claude", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: mcp.headers } }));
const sessionId = arg("--resume") ?? randomUUID();
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sessionId }) + "\n");
let initSent = false;
let lastAssetId = "";
let apiCount = 0;

function streamText(text) {
  const id = `msg_${++apiCount}`;
  out({ type: "stream_event", event: { type: "message_start", message: { id, usage: { input_tokens: 4, cache_read_input_tokens: 9000, cache_creation_input_tokens: 200 } } }, parent_tool_use_id: null });
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null });
  for (const chunk of text.match(/.{1,8}/gs)) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } }, parent_tool_use_id: null });
  }
  out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null });
  out({ type: "assistant", message: { id, content: [{ type: "text", text }] }, parent_tool_use_id: null });
}

// Like Claude Code: the tool_use is streamed first; beforeRun (e.g. the permission prompt)
// happens while it is shown, then the tool runs and its result is reported.
async function toolCall(name, input, beforeRun) {
  const id = `msg_${++apiCount}`;
  const toolId = `toolu_${apiCount}`;
  const json = JSON.stringify(input);
  out({ type: "stream_event", event: { type: "message_start", message: { id } }, parent_tool_use_id: null });
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name: `mcp__forge__${name}`, input: {} } }, parent_tool_use_id: null });
  for (let i = 0; i < json.length; i += 40) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 40) } }, parent_tool_use_id: null });
  }
  out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null });
  out({ type: "assistant", message: { id, content: [{ type: "tool_use", id: toolId, name: `mcp__forge__${name}`, input }] }, parent_tool_use_id: null });
  if (beforeRun && !(await beforeRun())) {
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: [{ type: "text", text: "The user declined this action." }], is_error: true }] }, parent_tool_use_id: null });
    return null;
  }
  const res = await client.callTool({ name, arguments: input });
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: res.content, is_error: !!res.isError }] }, parent_tool_use_id: null });
  return res;
}

const lantern = {
  name: "Lantern",
  parts: [
    { name: "Base", size: [2, 0.4, 2], pos: [0, 0.2, 0], color: "#2b2b30", material: "Slate" },
    { name: "Pole", shape: "cylinder", axis: "y", size: [0.4, 6, 0.4], pos: [0, 3.4, 0], color: "#1d1d22", material: "Metal" },
    { name: "Bulb", shape: "ball", size: [1, 1, 1], pos: [0, 6.9, 0], color: "#ffcc66", material: "Neon", light: { type: "point", range: 16 } },
  ],
};

for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  const prompt = msg.message.content.find((c) => c.type === "text")?.text ?? "";
  out(rateLimit(0.05 + 0.01 * apiCount, 0.04));
  if (!initSent) {
    initSent = true;
    out({ type: "system", subtype: "init", model: arg("--model"), tools: [], mcp_servers: [{ name: "forge", status: "connected" }] });
  }
  const started = Date.now();
  if (/too old/i.test(prompt) && VERSION === "9.9.9") {
    // What Claude Code prints when the chosen model needs a newer CLI.
    const error = "API Error: 400 Claude Code 9.9.9 does not support this model; version 9.9.10 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";
    out({ type: "assistant", message: { id: `msg_${++apiCount}`, content: [{ type: "text", text: error }] }, parent_tool_use_id: null });
    out({ type: "result", subtype: "success", is_error: true, result: error, num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    continue;
  }
  if (/too old/i.test(prompt)) {
    streamText(`Running on Claude Code ${VERSION}.`);
    out({ type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, duration_ms: 1, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } });
    continue;
  }
  if (/html hud/i.test(prompt)) {
    const html = readFileSync(new URL("./html/hud.html", import.meta.url), "utf8");
    streamText("Designing the HUD in HTML.");
    const res = await toolCall("create_ui_html", { name: "Hud", html });
    lastAssetId = res.content[0].text.match(/\b(u_[a-z0-9]{6})\b/)?.[1] ?? lastAssetId;
    streamText("The HUD is ready.");
    out({ type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, duration_ms: 1, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } });
    continue;
  }
  if (/edit html/i.test(prompt)) {
    await toolCall("edit_ui_html", { id: lastAssetId, edits: [{ find: "Level 12 reached!", replace: "Level 13 reached!" }] });
    streamText("Updated.");
    out({ type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, duration_ms: 1, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } });
    continue;
  }
  const example = /cabin/i.test(prompt) ? ["create_model", "cozy-cabin.model.json"] : /shop/i.test(prompt) ? ["create_ui", "item-shop.ui.json"] : null;
  if (example) {
    const spec = JSON.parse(readFileSync(new URL(`../examples/${example[1]}`, import.meta.url), "utf8")).spec;
    streamText(example[0] === "create_model" ? "I'll build a cozy log cabin with a porch, warm lantern light, pine trees and a fence." : "Here's a dark item shop with tabs, a coin counter and a grid of item cards.");
    await toolCall(example[0], spec);
    streamText(example[0] === "create_model"
      ? "Done — **Cozy Cabin** is in the preview (76 parts). Click any part to ask for changes, or hit *Import to Studio*."
      : "The **ItemShop** UI is ready. It scales with the screen, so check the Phone and Desktop presets.");
  } else if (/dance/i.test(prompt)) {
    streamText("Making a little R15 dance.");
    const res = await toolCall("create_animation", {
      name: "Dance", rig: "R15", loop: true,
      keyframes: [
        { t: 0, ease: "cubic", poses: { rightShoulder: [0, 0, 150], leftShoulder: [0, 0, -150], root: { pos: [0, 0, 0] } } },
        { t: 0.5, ease: "cubic", poses: { rightShoulder: [0, 0, 100], leftShoulder: [0, 0, -100], root: { pos: [0, 0.4, 0] }, rightKnee: [-40, 0, 0] } },
        { t: 1, poses: { rightShoulder: [0, 0, 150], leftShoulder: [0, 0, -150], root: { pos: [0, 0, 0] } } },
      ],
    });
    const animId = res.content[0].text.match(/\b(a_[a-z0-9]{6})\b/)?.[1];
    await toolCall("edit_animation", { id: animId, speed: 2, keyframes: [{ t: 0.5, poses: { neck: [0, 20, 0] } }] });
    streamText("Done.");
  } else if (/lantern/i.test(prompt)) {
    streamText("Building a lantern.");
    await toolCall("create_model", lantern);
    streamText("Done — the lantern is in your preview.");
  } else if (/luau/i.test(prompt)) {
    const tool = "mcp__forge__studio_execute_luau";
    const input = { code: "return 1 + 1" };
    let allowed = false;
    await toolCall("studio_execute_luau", input, async () => {
      const perm = await client.callTool({ name: "permission_prompt", arguments: { tool_name: tool, input } });
      allowed = JSON.parse(perm.content[0].text).behavior === "allow";
      return allowed;
    });
    streamText(allowed ? "Ran it." : "Skipped.");
  } else {
    streamText(`Echo: ${prompt}`);
  }
  out({
    type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, duration_ms: Date.now() - started,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 12, output_tokens: 80, cache_read_input_tokens: 18000, cache_creation_input_tokens: 400 },
  });
}
