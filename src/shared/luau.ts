// Helpers for emitting Luau source.

/** Quote a string as a Luau double-quoted literal. */
export function luaString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 32 || c === 127) out += "\\" + c.toString().padStart(3, "0");
    else out += ch;
  }
  return out + '"';
}

/** Luau long-bracket string whose level never collides with the content. */
export function luaLongString(s: string): string {
  let level = 0;
  // Append "]" so content ending in "]" or "]==" cannot merge with the closing bracket.
  while ((s + "]").includes("]" + "=".repeat(level) + "]")) level++;
  const eq = "=".repeat(level);
  // A leading newline right after the opening bracket is dropped by Luau, so add one to preserve content.
  return `[${eq}[\n${s}]${eq}]`;
}

export function luaNum(n: number, decimals = 6): string {
  if (!Number.isFinite(n)) return "0";
  const f = 10 ** decimals;
  const r = Math.round(n * f) / f;
  if (Object.is(r, -0) || r === 0) return "0";
  return String(r);
}

/** Valid Luau identifier check (for table keys). */
export function isIdent(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}
