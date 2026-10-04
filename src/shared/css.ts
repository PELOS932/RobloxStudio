// Parsers for computed CSS values (as returned by getComputedStyle) used by the
// HTML → Roblox UI translator. Pure functions so they can be unit-tested in Node.

import type { FontName } from "./roblox-data.ts";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  orange: "#ffa500", purple: "#800080", gray: "#808080", grey: "#808080", silver: "#c0c0c0", gold: "#ffd700",
  pink: "#ffc0cb", cyan: "#00ffff", magenta: "#ff00ff", lime: "#00ff00", navy: "#000080", teal: "#008080",
};

/** Split on commas that are not inside parentheses. */
export function splitTopLevel(value: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Split on whitespace outside parentheses. */
export function splitTokens(value: string): string[] {
  return splitTopLevel(value.trim().replace(/\s+/g, " "), " ");
}

/** Parse rgb()/rgba()/hex/named colors. Returns null for anything else (the browser resolver handles those). */
export function parseColor(input: string): Rgba | null {
  const v = input.trim().toLowerCase();
  if (!v || v === "none") return null;
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (NAMED[v]) return parseColor(NAMED[v]);
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = v.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (p: string) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return { r: ch(parts[0]), g: ch(parts[1]), b: ch(parts[2]), a: Number.isFinite(a) ? a : 1 };
  }
  m = v.match(/^color\(srgb\s+([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
    return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts[3] ?? 1 };
  }
  return null;
}

export function toHex(c: Rgba): string {
  return "#" + [c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

/** Find where a leading color token ends in a gradient stop / shadow ("rgb(…) 10%" → "rgb(…)"). */
function takeColor(tokens: string[]): { color: string | null; rest: string[] } {
  const i = tokens.findIndex((t) => /^(#|rgb|hsl|hwb|lab|lch|oklab|oklch|color\(|transparent$|currentcolor$|[a-z]+$)/i.test(t) && !/^-?\d/.test(t) && !/^(inset|to|in)$/i.test(t));
  if (i < 0) return { color: null, rest: tokens };
  return { color: tokens[i], rest: tokens.filter((_, k) => k !== i) };
}

export interface GradientStop {
  color: string;
  /** 0..1, or null when the browser omitted it (filled in evenly). */
  pos: number | null;
}

export interface LinearGradient {
  /** CSS angle in degrees (0 = to top, 90 = to right, 180 = to bottom). */
  angle: number;
  stops: GradientStop[];
}

const SIDE_ANGLES: Record<string, number> = {
  "to top": 0, "to right": 90, "to bottom": 180, "to left": 270,
  "to top right": 45, "to right top": 45, "to bottom right": 135, "to right bottom": 135,
  "to bottom left": 225, "to left bottom": 225, "to top left": 315, "to left top": 315,
};

function parseAngle(t: string): number | null {
  const m = t.match(/^(-?[\d.]+)(deg|rad|turn|grad)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === "deg" ? n : m[2] === "rad" ? (n * 180) / Math.PI : m[2] === "turn" ? n * 360 : n * 0.9;
}

/** Parse the top-most linear-gradient layer of a background-image value. */
export function parseLinearGradient(backgroundImage: string): LinearGradient | null {
  for (const layer of splitTopLevel(backgroundImage)) {
    const m = layer.match(/^(?:-webkit-)?linear-gradient\((.*)\)$/s);
    if (!m) continue;
    const args = splitTopLevel(m[1]);
    let angle = 180;
    let first = args[0]?.trim() ?? "";
    // Drop color-interpolation hints such as "in oklab".
    first = first.replace(/\bin\s+[a-z-]+(\s+(shorter|longer|increasing|decreasing)\s+hue)?/i, "").trim();
    if (SIDE_ANGLES[first] !== undefined) {
      angle = SIDE_ANGLES[first];
      args.shift();
    } else if (parseAngle(first) !== null) {
      angle = parseAngle(first)!;
      args.shift();
    } else if (!first) args.shift();
    const stops: GradientStop[] = [];
    for (const a of args) {
      const { color, rest } = takeColor(splitTokens(a));
      if (!color) continue; // color hint
      const positions = rest.filter((t) => /%$/.test(t)).map((t) => parseFloat(t) / 100);
      if (positions.length >= 2) {
        stops.push({ color, pos: positions[0] }, { color, pos: positions[1] });
      } else stops.push({ color, pos: positions[0] ?? null });
    }
    if (stops.length < 2) return null;
    return { angle, stops: fillStopPositions(stops) };
  }
  return null;
}

/** CSS rules for missing stop positions: first 0, last 1, gaps distributed evenly; positions never decrease. */
export function fillStopPositions(stops: GradientStop[]): GradientStop[] {
  const out = stops.map((s) => ({ ...s }));
  if (out[0].pos === null) out[0].pos = 0;
  if (out[out.length - 1].pos === null) out[out.length - 1].pos = 1;
  let last = out[0].pos!;
  for (let i = 1; i < out.length; i++) {
    if (out[i].pos !== null) {
      out[i].pos = Math.max(last, out[i].pos!);
      last = out[i].pos!;
      continue;
    }
    let j = i;
    while (out[j].pos === null) j++;
    const start = out[i - 1].pos!, end = Math.max(start, out[j].pos!);
    for (let k = i; k < j; k++) out[k].pos = start + ((end - start) * (k - i + 1)) / (j - i + 1);
    i = j - 1;
  }
  return out.map((s) => ({ ...s, pos: Math.max(0, Math.min(1, s.pos!)) }));
}

export function hasRadialGradient(backgroundImage: string): boolean {
  return /radial-gradient|conic-gradient/.test(backgroundImage);
}

export function backgroundUrls(backgroundImage: string): string[] {
  return [...backgroundImage.matchAll(/url\((["']?)(.*?)\1\)/g)].map((m) => m[2]);
}

export interface Shadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  inset: boolean;
}

/** Parse box-shadow / text-shadow (computed form: "rgba(0, 0, 0, 0.3) 0px 4px 12px 0px, …"). */
export function parseShadows(value: string): Shadow[] {
  if (!value || value === "none") return [];
  return splitTopLevel(value).map((part) => {
    const tokens = splitTokens(part);
    const inset = tokens.includes("inset");
    const { color, rest } = takeColor(tokens.filter((t) => t !== "inset"));
    const nums = rest.map((t) => parseFloat(t)).filter((n) => Number.isFinite(n));
    return { x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, spread: nums[3] ?? 0, color: color ?? "rgba(0, 0, 0, 0.5)", inset };
  });
}

export interface Transform2D {
  rotation: number;
  scaleX: number;
  scaleY: number;
  tx: number;
  ty: number;
  identityLinear: boolean;
}

/** Decompose a computed transform ("none" | "matrix(a, b, c, d, e, f)" | "matrix3d(…)"). */
export function parseTransform(value: string): Transform2D {
  const id: Transform2D = { rotation: 0, scaleX: 1, scaleY: 1, tx: 0, ty: 0, identityLinear: true };
  if (!value || value === "none") return id;
  let a: number, b: number, c: number, d: number, e: number, f: number;
  const m2 = value.match(/^matrix\(([^)]+)\)$/);
  const m3 = value.match(/^matrix3d\(([^)]+)\)$/);
  if (m2) [a, b, c, d, e, f] = m2[1].split(",").map(parseFloat);
  else if (m3) {
    const v = m3[1].split(",").map(parseFloat);
    [a, b, c, d, e, f] = [v[0], v[1], v[4], v[5], v[12], v[13]];
  } else return id;
  const scaleX = Math.hypot(a, b);
  const scaleY = Math.hypot(c, d);
  const rotation = (Math.atan2(b, a) * 180) / Math.PI;
  const identityLinear = Math.abs(a - 1) < 1e-4 && Math.abs(b) < 1e-4 && Math.abs(c) < 1e-4 && Math.abs(d - 1) < 1e-4;
  return { rotation, scaleX, scaleY, tx: e, ty: f, identityLinear };
}

// --------------------------------------------------------------------- fonts

type WeightMap = Partial<Record<100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900, FontName>>;

const FONT_GROUPS: [RegExp, WeightMap][] = [
  [/^(builder ?sans|inter|system-ui|-apple-system|blinkmacsystemfont|segoe ui|helvetica( neue)?|sf pro( display| text)?|ui-sans-serif|noto sans|open sans|lato|poppins|dm sans|manrope|plus jakarta sans|outfit|figtree|sora|rubik|work sans|ibm plex sans|sans-serif)$/,
    { 400: "BuilderSans", 500: "BuilderSansMedium", 600: "BuilderSansBold", 700: "BuilderSansBold", 800: "BuilderSansExtraBold" }],
  [/^(montserrat|gotham( ssm)?|raleway)$/, { 400: "Gotham", 500: "GothamMedium", 600: "GothamBold", 700: "GothamBold", 900: "GothamBlack" }],
  [/^(source sans( pro| 3)?)$/, { 300: "SourceSansLight", 400: "SourceSans", 600: "SourceSansSemibold", 700: "SourceSansBold" }],
  [/^(arial|arimo|liberation sans)$/, { 400: "Arimo", 700: "ArimoBold" }],
  [/^roboto$/, { 400: "Roboto" }],
  [/^roboto condensed$/, { 400: "RobotoCondensed" }],
  [/^(roboto mono|monospace|ui-monospace|jetbrains mono|fira code|fira mono|consolas|menlo|monaco|courier( new)?|sf mono|source code pro)$/, { 400: "RobotoMono" }],
  [/^(inconsolata)$/, { 400: "Code" }],
  [/^(fredoka( one)?|baloo( 2)?|varela round|nunito sans)$/, { 400: "FredokaOne" }],
  [/^nunito$/, { 400: "Nunito" }],
  [/^(luckiest guy|lilita one|titan one)$/, { 400: "LuckiestGuy" }],
  [/^bangers$/, { 400: "Bangers" }],
  [/^(press start 2p|vt323|silkscreen|pixelify sans)$/, { 400: "Arcade" }],
  [/^(oswald|bebas neue|anton|league gothic)$/, { 400: "Oswald" }],
  [/^ubuntu$/, { 400: "Ubuntu" }],
  [/^(merriweather|serif|georgia|times( new roman)?|playfair display|lora|pt serif|ui-serif)$/, { 400: "Merriweather" }],
  [/^(titillium web|exo( 2)?|rajdhani)$/, { 400: "TitilliumWeb" }],
  [/^(josefin sans)$/, { 400: "JosefinSans" }],
  [/^(permanent marker|caveat brush|marker felt)$/, { 400: "PermanentMarker" }],
  [/^creepster$/, { 400: "Creepster" }],
  [/^(indie flower|caveat|shadows into light)$/, { 400: "IndieFlower" }],
  [/^(special elite|courier prime)$/, { 400: "SpecialElite" }],
  [/^kalam$/, { 400: "Kalam" }],
  [/^jura$/, { 400: "Jura" }],
  [/^(michroma|audiowide)$/, { 400: "Michroma" }],
  [/^(orbitron|zekton)$/, { 400: "SciFi" }],
  [/^sarpanch$/, { 400: "Sarpanch" }],
  [/^(amatic sc)$/, { 400: "AmaticSC" }],
  [/^(patrick hand|gochi hand)$/, { 400: "PatrickHand" }],
  [/^(denk one)$/, { 400: "DenkOne" }],
  [/^fondamento$/, { 400: "Fondamento" }],
  [/^(grenze gotisch|unifrakturmaguntia)$/, { 400: "GrenzeGotisch" }],
  [/^(comic neue|comic sans ms|comic sans)$/, { 400: "Cartoon" }],
  [/^(cinzel|trajan( pro)?)$/, { 400: "Antique" }],
];

/** Map a CSS font-family list + weight to the closest Roblox Enum.Font. */
export function mapFont(familyList: string, weight: number): FontName {
  const families = splitTopLevel(familyList).map((f) => f.replace(/^["']|["']$/g, "").trim().toLowerCase());
  for (const fam of families) {
    const group = FONT_GROUPS.find(([re]) => re.test(fam));
    if (!group) continue;
    const map = group[1];
    const weights = Object.keys(map).map(Number);
    const best = weights.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) || (Math.abs(b - weight) === Math.abs(a - weight) && b > a) ? b : a));
    return map[best as keyof WeightMap]!;
  }
  return mapFont("sans-serif", weight);
}

/** Make a Roblox-friendly instance name from an id/class ("shop-card__title" → "ShopCardTitle"). */
export function instanceName(raw: string): string {
  const words = raw.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return (/^\d/.test(name) ? "N" + name : name).slice(0, 48);
}
