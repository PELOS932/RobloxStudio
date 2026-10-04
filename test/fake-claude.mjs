#!/usr/bin/env node
// Minimal stand-in for `claude -p --input-format stream-json --output-format stream-json`
// used by the end-to-end test. It speaks the same event format and calls the Forge MCP
// tools over HTTP exactly like Claude Code would.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes("--version")) {
  console.log("9.9.9 (Fake Claude Code)");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }));
  process.exit(0);
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

async function toolCall(name, input) {
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
  if (!initSent) {
    initSent = true;
    out({ type: "system", subtype: "init", model: arg("--model"), tools: [], mcp_servers: [{ name: "forge", status: "connected" }] });
  }
  const started = Date.now();
  const example = /cabin/i.test(prompt) ? ["create_model", "cozy-cabin.model.json"] : /shop/i.test(prompt) ? ["create_ui", "item-shop.ui.json"] : null;
  if (example) {
    const spec = JSON.parse(readFileSync(new URL(`../examples/${example[1]}`, import.meta.url), "utf8")).spec;
    streamText(example[0] === "create_model" ? "I'll build a cozy log cabin with a porch, warm lantern light, pine trees and a fence." : "Here's a dark item shop with tabs, a coin counter and a grid of item cards.");
    await toolCall(example[0], spec);
    streamText(example[0] === "create_model"
      ? "Done — **Cozy Cabin** is in the preview (76 parts). Click any part to ask for changes, or hit *Import to Studio*."
      : "The **ItemShop** UI is ready. It scales with the screen, so check the Phone and Desktop presets.");
  } else if (/lantern/i.test(prompt)) {
    streamText("Building a lantern.");
    await toolCall("create_model", lantern);
    streamText("Done — the lantern is in your preview.");
  } else if (/luau/i.test(prompt)) {
    const tool = "mcp__forge__studio_execute_luau";
    const input = { code: "return 1 + 1" };
    const perm = await client.callTool({ name: "permission_prompt", arguments: { tool_name: tool, input } });
    const decision = JSON.parse(perm.content[0].text);
    if (decision.behavior === "allow") await toolCall("studio_execute_luau", decision.updatedInput);
    streamText(decision.behavior === "allow" ? "Ran it." : "Skipped.");
  } else {
    streamText(`Echo: ${prompt}`);
  }
  out({
    type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, duration_ms: Date.now() - started,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 12, output_tokens: 80, cache_read_input_tokens: 18000, cache_creation_input_tokens: 400 },
  });
}
