import type { AssetSummary, Block, Conversation } from "../../shared/protocol.ts";

const time = (t: number) => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function toolLine(b: Extract<Block, { type: "tool" }>): string {
  const name = b.name.replace(/^mcp__forge__/, "");
  const input = b.input as Record<string, unknown> | undefined;
  const subject = typeof input?.name === "string" ? ` "${input.name}"` : "";
  const status = b.status === "done" ? "" : ` (${b.status})`;
  return `- \`${name}\`${subject}${status}`;
}

/** A readable Markdown transcript: messages, tool calls as a list, and the assets that were made. */
export function conversationMarkdown(conv: Conversation, assets: AssetSummary[]): string {
  const out: string[] = [`# ${conv.title}`, "", `Exported from Studio Forge · ${time(Date.now())}`, ""];
  const mentioned = new Set<string>();
  for (const m of conv.messages) {
    if (m.role === "user") {
      const text = m.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
      out.push(`## You · ${time(m.createdAt)}`, "", text, "");
      continue;
    }
    out.push(`## Claude${m.model ? ` (${m.model})` : ""} · ${time(m.createdAt)}`, "");
    let tools: string[] = [];
    const flush = () => {
      if (tools.length) out.push(...tools, "");
      tools = [];
    };
    for (const b of m.blocks) {
      if (b.type === "tool") {
        tools.push(toolLine(b));
        for (const id of b.result?.text.match(/\b[mus]_[a-z0-9]{6}\b/g) ?? []) mentioned.add(id);
      } else if (b.type === "text" && b.text.trim()) {
        flush();
        out.push(b.text.trim(), "");
      }
    }
    flush();
    if (m.error) out.push(`> Error: ${m.error}`, "");
    if (m.interrupted) out.push("> Stopped.", "");
  }
  const made = assets.filter((a) => mentioned.has(a.id));
  if (made.length) {
    out.push("## Assets", "");
    for (const a of made) out.push(`- **${a.name}** (${a.kind}, v${a.version}, \`${a.id}\`)${a.lastImport ? ` · in Studio at ${a.lastImport.path}` : ""}`);
    out.push("");
  }
  return out.join("\n");
}
