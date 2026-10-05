// Tool calls rendered like Claude Code's transcript: "● Tool(args)" with a live timer, then
// "⎿" lines underneath (live input as Claude writes it, progress while it runs, the first
// lines of the result when done). Click a call to see its full input and result.

import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "../store.ts";
import { Icon } from "../lib/icons.tsx";
import { highlightLuau } from "./ScriptView.tsx";
import type { Block } from "../../shared/protocol.ts";

export type ToolBlock = Extract<Block, { type: "tool" }>;

/** Re-render every second while something is live. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const oneLine = (s: unknown, max = 90) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

/**
 * Read a string field from JSON that is still being streamed (it may stop mid-string).
 * Returns the decoded text so far, or undefined if the field hasn't started yet.
 */
export function partialField(partial: string | undefined, key: string): string | undefined {
  if (!partial) return undefined;
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(partial);
  if (!m) return undefined;
  let out = "";
  for (let i = m.index + m[0].length; i < partial.length; i++) {
    const c = partial[i];
    if (c === '"') break;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = partial[++i];
    if (n === undefined) break;
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") continue;
    else if (n === "u") {
      const hex = partial.slice(i + 1, i + 5);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += n;
  }
  return out;
}

interface Described {
  label: string;
  args: string;
}

/** Claude Code-style "Label(args)" for a call, from its (possibly partial) input. */
export function describeCall(b: ToolBlock, assetName?: (id: string) => string | undefined): Described {
  const input = (b.input ?? {}) as Record<string, any>;
  const partial = b.inputPartial;
  const field = (k: string) => (input[k] !== undefined ? input[k] : partialField(partial, k));
  const asset = (id: unknown) => (typeof id === "string" ? assetName?.(id) ?? id : "");
  const short = b.name.replace(/^mcp__forge__/, "");
  const count = (arr: unknown) => (Array.isArray(arr) ? arr.length : 0);
  switch (short) {
    case "create_model": return { label: "Create model", args: field("name") ?? "" };
    case "edit_model":
    case "edit_ui": {
      const bits = [asset(field("id"))];
      if (count(input.add)) bits.push(`+${count(input.add)}`);
      if (count(input.update)) bits.push(`~${count(input.update)}`);
      if (count(input.remove)) bits.push(`−${count(input.remove)}`);
      return { label: short === "edit_model" ? "Edit model" : "Edit UI", args: bits.filter(Boolean).join(" ") };
    }
    case "create_ui": return { label: "Create UI", args: [field("name"), count(input.nodes) ? plural(count(input.nodes), "node") : ""].filter(Boolean).join(" · ") };
    case "create_ui_html": return { label: "Create UI from HTML", args: [field("name"), input.width ? `${input.width}×${input.height ?? 720}` : ""].filter(Boolean).join(" · ") };
    case "edit_ui_html": return { label: "Edit UI HTML", args: [asset(field("id")), count(input.edits) ? plural(count(input.edits), "edit") : ""].filter(Boolean).join(" · ") };
    case "create_script": return count(input.scripts)
      ? { label: "Write scripts", args: (input.scripts as { name?: string }[]).map((x) => x.name).filter(Boolean).join(", ") }
      : { label: "Write script", args: [field("name"), input.kind, input.parent].filter(Boolean).join(" · ") };
    case "create_vfx": return { label: "Create effect", args: [field("name"), count(input.emitters) ? plural(count(input.emitters), "emitter") : ""].filter(Boolean).join(" · ") };
    case "edit_vfx": {
      const bits = [asset(field("id"))];
      if (count(input.add)) bits.push(`+${count(input.add)}`);
      if (count(input.update)) bits.push(`~${count(input.update)}`);
      if (count(input.remove)) bits.push(`−${count(input.remove)}`);
      if (input.scale) bits.push(`×${input.scale}`);
      return { label: "Edit effect", args: bits.filter(Boolean).join(" ") };
    }
    case "create_animation": return { label: "Create animation", args: [field("name"), input.rig, count(input.keyframes) ? plural(count(input.keyframes), "keyframe") : ""].filter(Boolean).join(" · ") };
    case "edit_animation": {
      const bits = [asset(field("id"))];
      if (count(input.keyframes)) bits.push(`~${plural(count(input.keyframes), "keyframe")}`);
      if (count(input.remove)) bits.push(`−${count(input.remove)}`);
      if (input.speed) bits.push(`×${input.speed}`);
      return { label: "Edit animation", args: bits.filter(Boolean).join(" ") };
    }
    case "list_assets": return { label: "List assets", args: "" };
    case "get_asset": return { label: "Read asset", args: asset(field("id")) };
    case "import_to_studio": return { label: "Import to Studio", args: [asset(field("id")), input.parent].filter(Boolean).join(" → ") };
    case "studio_pull_selection": return { label: "Pull Studio selection", args: "" };
    case "studio_execute_luau": return { label: "Run Luau", args: oneLine((field("code") ?? "").split("\n").find((l: string) => l.trim() && !l.trim().startsWith("--")) ?? "", 70) };
    case "studio_query": return { label: input.tree ? "Explorer outline" : "Find in Studio", args: [input.path, input.class, input.name && `"${input.name}"`, input.tag && `#${input.tag}`].filter(Boolean).join(" ") };
    case "studio_edit": {
      const ops = Array.isArray(input.ops) ? (input.ops as { op?: string }[]) : [];
      const kinds = [...new Set(ops.map((o) => o.op).filter(Boolean))];
      return { label: "Edit Studio", args: ops.length ? `${plural(ops.length, "change")} (${kinds.join(", ")})` : "" };
    }
    case "studio_undo": return { label: input.redo ? "Redo in Studio" : "Undo in Studio", args: input.steps && input.steps > 1 ? `${input.steps} steps` : "" };
    case "studio_scripts": return { label: input.pattern ? "Search scripts" : "List scripts", args: input.pattern ? `"${input.pattern}"` : field("path") ?? "" };
    case "studio_lighting": return { label: "Lighting", args: [input.preset, input.lighting && Object.keys(input.lighting).join(", ")].filter(Boolean).join(" · ") };
    case "studio_terrain": return { label: "Terrain", args: Array.isArray(input.ops) ? (input.ops as { op?: string }[]).map((o) => o.op).join(", ") : "" };
    case "studio_playtest": return { label: input.mode === "stop" ? "Stop play-test" : input.mode === "start" ? "Start play-test" : "Play-test", args: input.mode && input.mode !== "test" ? "" : `${input.seconds ?? 5}s` };
    case "studio_inspect": return { label: "Inspect", args: field("path") ?? "" };
    case "studio_script_read": return { label: "Read script", args: field("path") ?? "" };
    case "studio_script_edit": return { label: "Edit script", args: [field("path"), count(input.edits) ? plural(count(input.edits), "edit") : ""].filter(Boolean).join(" · ") };
    case "studio_screenshot": return { label: "Studio screenshot", args: "" };
    case "studio_console": return { label: "Read Studio output", args: "" };
    case "studio_state": return { label: "Studio state", args: "" };
    case "studio_play": return { label: input.start === false ? "Stop play-test" : "Play-test", args: "" };
    case "studio_search_tree": return { label: "Search tree", args: [input.path, input.instance_type, input.keywords && `"${input.keywords}"`].filter(Boolean).join(" ") };
    // Claude Code's own tools (Full Claude Code mode).
    case "Bash": return { label: "Bash", args: oneLine(field("command"), 100) };
    case "Read": return { label: "Read", args: [shortPath(field("file_path")), input.offset ? `from line ${input.offset}` : ""].filter(Boolean).join(" ") };
    case "Write": return { label: "Write", args: shortPath(field("file_path")) };
    case "Edit":
    case "MultiEdit": return { label: "Update", args: shortPath(field("file_path")) };
    case "NotebookEdit": return { label: "Edit notebook", args: shortPath(field("notebook_path")) };
    case "Grep": return { label: "Search", args: [field("pattern") && `"${field("pattern")}"`, input.path && `in ${shortPath(input.path)}`].filter(Boolean).join(" ") };
    case "Glob": return { label: "Find files", args: field("pattern") ?? "" };
    case "WebFetch": return { label: "Fetch", args: oneLine(field("url"), 80) };
    case "WebSearch": return { label: "Web search", args: oneLine(field("query"), 80) };
    case "Task":
    case "Agent": return { label: "Agent", args: oneLine(field("description"), 80) };
    case "TodoWrite": return { label: "Update todos", args: "" };
  }
  const mcp = b.name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (mcp) return { label: `${mcp[2]} (${mcp[1]})`, args: "" };
  return { label: short.replace(/_/g, " "), args: "" };
}

function shortPath(p: unknown): string {
  const s = String(p ?? "");
  const parts = s.split(/[\\/]/);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : s;
}

/** Up to `max` lines of text, with a "+N lines" note. */
function Lines({ text, max = 4, className = "" }: { text: string; max?: number; className?: string }) {
  const lines = text.replace(/\s+$/, "").split("\n");
  const shown = lines.slice(0, max);
  return (
    <div className={`call-lines ${className}`}>
      {shown.map((l, i) => <div key={i}>{l || " "}</div>)}
      {lines.length > max && <div className="call-more">… +{lines.length - max} lines</div>}
    </div>
  );
}

/** The last lines of something being written right now, with a blinking cursor. */
function LiveTail({ text, luau = false, max = 8, cursor = true }: { text: string; luau?: boolean; max?: number; cursor?: boolean }) {
  const lines = text.split("\n");
  const tail = lines.slice(-max);
  const rendered = luau ? highlightLuau(tail.join("\n")) : tail.map((l) => [l]);
  return (
    <div className="call-stream">
      {lines.length > max && <div className="call-more">… {plural(lines.length - max, "line")} above</div>}
      {rendered.map((l, i) => (
        <div key={i}>
          {l.length ? l : " "}
          {cursor && i === rendered.length - 1 && <span className="call-cursor" />}
        </div>
      ))}
    </div>
  );
}

function Diff({ edits }: { edits: { old_string?: string; new_string?: string }[] }) {
  const rows: { sign: "-" | "+"; text: string }[] = [];
  for (const e of edits) {
    for (const l of String(e.old_string ?? "").split("\n")) rows.push({ sign: "-", text: l });
    for (const l of String(e.new_string ?? "").split("\n")) rows.push({ sign: "+", text: l });
  }
  const shown = rows.slice(0, 14);
  return (
    <div className="call-diff">
      {shown.map((r, i) => (
        <div key={i} className={r.sign === "-" ? "del" : "add"}>
          <span>{r.sign}</span>
          {r.text || " "}
        </div>
      ))}
      {rows.length > shown.length && <div className="call-more">… +{rows.length - shown.length} lines</div>}
    </div>
  );
}

function Todos({ todos }: { todos: { content?: string; status?: string; activeForm?: string }[] }) {
  return (
    <div className="call-todos">
      {todos.map((t, i) => (
        <div key={i} className={t.status ?? "pending"}>
          <span className="box">{t.status === "completed" ? "☒" : "☐"}</span>
          {t.status === "in_progress" ? t.activeForm ?? t.content : t.content}
        </div>
      ))}
    </div>
  );
}

/** What goes under "⎿" while the call runs. */
function liveBody(b: ToolBlock): ReactNode {
  const short = b.name.replace(/^mcp__forge__/, "");
  const input = (b.input ?? {}) as Record<string, any>;
  const streaming = b.inputPartial !== undefined;
  const field = (k: string) => (typeof input[k] === "string" ? input[k] : partialField(b.inputPartial, k));
  const size = b.inputChars ? ` · ${kb(b.inputChars)}` : "";

  // Code-like input is shown as it is written.
  const codeKey: Record<string, string> = { studio_execute_luau: "code", create_script: "source", create_ui_html: "html", Write: "content" };
  const key = codeKey[short];
  const code = key ? field(key) : undefined;
  const progress = b.progress && <div className="call-progress">{b.progress}</div>;

  if (short === "Bash") {
    const cmd = field("command");
    return (
      <>
        {cmd && <div className="call-cmd">$ {cmd}{streaming && <span className="call-cursor" />}</div>}
        {progress ?? (!streaming && <div className="call-progress">Running…</div>)}
      </>
    );
  }
  if (short === "TodoWrite" && Array.isArray(input.todos)) return <Todos todos={input.todos} />;
  if ((short === "Edit" || short === "MultiEdit") && !streaming) return <Diff edits={short === "Edit" ? [input] : input.edits ?? []} />;
  if (code !== undefined) {
    return (
      <>
        {streaming || short === "studio_execute_luau" ? <LiveTail text={code} luau={short === "studio_execute_luau" || short === "create_script"} max={short === "studio_execute_luau" && !streaming ? 14 : 8} cursor={streaming} /> : null}
        {progress ?? (streaming ? <div className="call-progress">Writing{size}</div> : <div className="call-progress">Running…</div>)}
      </>
    );
  }
  if (streaming) {
    const items = b.inputItems ?? 0;
    const what = /model/.test(short) ? "part" : /ui/.test(short) ? "node" : "";
    return <div className="call-progress">Writing{what && items ? ` · ${plural(items, what)}` : ""}{size}</div>;
  }
  return progress ?? <div className="call-progress">Running…</div>;
}

/** What goes under "⎿" once the call is done. */
function doneBody(b: ToolBlock): ReactNode {
  const short = b.name.replace(/^mcp__forge__/, "");
  const input = (b.input ?? {}) as Record<string, any>;
  const text = b.result?.text ?? "";
  const bad = b.status === "error" || b.status === "denied";
  if (bad) return <Lines text={text || (b.status === "denied" ? "Declined" : "Failed")} max={5} className="bad" />;
  if (short === "TodoWrite" && Array.isArray(input.todos)) return <Todos todos={input.todos} />;
  if (short === "Edit" || short === "MultiEdit") return <Diff edits={short === "Edit" ? [input] : input.edits ?? []} />;
  if (short === "Write" && typeof input.content === "string") return <Lines text={`Wrote ${plural(input.content.split("\n").length, "line")}`} />;
  if (short === "Read") return <Lines text={`Read ${plural(text.split("\n").length, "line")}`} />;
  if (short === "Grep" || short === "Glob") {
    const n = text.trim() ? text.trim().split("\n").length : 0;
    return <Lines text={n ? `${plural(n, "result")}\n${text}` : "No matches"} max={4} />;
  }
  if (short === "studio_execute_luau") {
    return (
      <>
        {typeof input.code === "string" && <LiveTail text={input.code} luau max={6} cursor={false} />}
        <Lines text={text.trim() ? `→ ${text.trim()}` : "→ nil"} max={4} />
      </>
    );
  }
  return text.trim() ? <Lines text={text} max={short === "Bash" ? 6 : 3} /> : <Lines text="(no output)" />;
}

export function ToolCall({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const running = block.status === "running";
  const now = useNow(running);
  const assetName = (id: string) => useStore.getState().assets.find((a) => a.id === id)?.name;
  const { label, args } = describeCall(block, assetName);
  const elapsed = block.startedAt ? (block.endedAt ?? (running ? now : block.startedAt)) - block.startedAt : 0;

  let detail: ReactNode = null;
  if (open) {
    const input = block.input as Record<string, unknown> | undefined;
    const short = block.name.replace(/^mcp__forge__/, "");
    let inputView: ReactNode = null;
    if (short === "studio_execute_luau" && typeof input?.code === "string") {
      inputView = <pre>{highlightLuau(input.code).map((l, i) => <div key={i}>{l.length ? l : " "}</div>)}</pre>;
    } else if (input && Object.keys(input).length) {
      const json = JSON.stringify(input, null, 2);
      inputView = <pre>{json.length > 8000 ? json.slice(0, 8000) + "\n…" : json}</pre>;
    }
    detail = (
      <div className="call-detail">
        <span className="tool-label">input · {block.name}</span>
        {inputView ?? <pre>{block.inputPartial ?? "{}"}</pre>}
        {block.result?.text && (
          <>
            <span className="tool-label">result</span>
            <pre>{block.result.text}</pre>
          </>
        )}
      </div>
    );
  }

  return (
    <li className={`call ${block.status}`}>
      <button className="call-head" onClick={() => setOpen((v) => !v)} title={open ? "Hide input and result" : "Show input and result"}>
        <span className="call-dot" />
        <span className="call-label">{label}</span>
        {args && <span className="call-args">({args})</span>}
        {block.status === "denied" && <span className="call-tag">declined</span>}
        <span className="call-time">{running || elapsed >= 1000 ? fmtDuration(elapsed) : ""}</span>
        <Icon name="chevronRight" size={12} className={`chev ${open ? "open" : ""}`} />
      </button>
      <div className="call-body">
        <span className="call-elbow">⎿</span>
        <div className="call-content">
          {running ? liveBody(block) : doneBody(block)}
          {block.result?.images?.map((src, i) => <img key={i} className="step-image" src={src} alt="Studio viewport" />)}
          {detail}
        </div>
      </div>
    </li>
  );
}

/** A run of consecutive tool calls. */
export function ToolCalls({ tools }: { tools: ToolBlock[] }) {
  return (
    <ol className="calls">
      {tools.map((t) => <ToolCall key={t.id} block={t} />)}
    </ol>
  );
}

/** Rough output size of a message so far (shown in the live status line). */
export function approxTokens(blocks: Block[]): number {
  let chars = 0;
  for (const b of blocks) {
    if (b.type === "tool") chars += b.inputChars ?? JSON.stringify(b.input ?? {}).length;
    else if (b.type !== "compact") chars += b.text.length;
  }
  return Math.round(chars / 3.8);
}
