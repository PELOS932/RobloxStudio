import { useMemo, type ReactNode } from "react";

const KEYWORDS = new Set([
  "and", "break", "continue", "do", "else", "elseif", "end", "export", "false", "for", "function", "if", "in",
  "local", "nil", "not", "or", "repeat", "return", "then", "true", "type", "typeof", "until", "while",
]);
const GLOBALS = new Set([
  "game", "workspace", "script", "Instance", "Vector3", "Vector2", "CFrame", "Color3", "UDim", "UDim2", "Enum",
  "task", "math", "string", "table", "print", "warn", "error", "pcall", "xpcall", "require", "tick", "os",
  "TweenInfo", "BrickColor", "Ray", "RaycastParams", "NumberSequence", "ColorSequence", "Players", "self",
]);

/** Tiny Luau tokenizer good enough for read-only highlighting. */
export function highlightLuau(src: string): ReactNode[][] {
  const lines: ReactNode[][] = [[]];
  const push = (text: string, cls?: string) => {
    const parts = text.split("\n");
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1].push(cls ? <span key={lines[lines.length - 1].length} className={cls}>{p}</span> : p);
    });
  };
  const re = /(--\[(=*)\[[\s\S]*?\]\2\]|--[^\n]*)|(\[(=*)\[[\s\S]*?\]\4\]|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b0x[0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_]\w*)(\s*\()?|([\s\S])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) push(m[1], "tok-com");
    else if (m[3]) push(m[3], "tok-str");
    else if (m[5]) push(m[5], "tok-num");
    else if (m[6]) {
      const word = m[6];
      if (KEYWORDS.has(word)) push(word, "tok-kw");
      else if (GLOBALS.has(word)) push(word, "tok-glob");
      else if (m[7]) push(word, "tok-fn");
      else push(word);
      if (m[7]) push(m[7]);
    } else push(m[8]);
  }
  return lines;
}

export function ScriptView({ source }: { source: string }) {
  const lines = useMemo(() => highlightLuau(source), [source]);
  return (
    <div className="code-view">
      {lines.map((l, i) => (
        <div className="code-line" key={i}>
          <span className="ln">{i + 1}</span>
          <span>{l.length ? l : " "}</span>
        </div>
      ))}
    </div>
  );
}
