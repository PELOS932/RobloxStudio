// HTML → Roblox GUI translator.
//
// The HTML is rendered by the browser itself (sandboxed iframe, scripts disabled) at
// the design resolution. We then read the *computed* layout and styles of every
// element and emit Roblox GuiObjects at exactly the same positions: the browser does
// all the CSS work (flexbox, grid, margins, fonts, percentages …), so the result is
// as close to the HTML as Roblox's GUI model allows.

import {
  backgroundUrls, hasRadialGradient, instanceName, mapFont, parseColor, parseLinearGradient, parseShadows,
  parseTransform, splitTopLevel, toHex, type Rgba, type Transform2D,
} from "../../shared/css.ts";
import { sanitizeUiSpec, UiSpecSchema, type UiNode, type UiSpec, type UiType } from "../../shared/ui.ts";
import type { FontName } from "../../shared/roblox-data.ts";

export interface HtmlConvertOptions {
  name: string;
  width: number;
  height: number;
  /** Proportional scaling from the design resolution (default true). */
  autoScale?: boolean;
  /** Approximate box-shadows with layered frames (default true). */
  shadows?: boolean;
}

export interface HtmlConvertResult {
  spec: UiSpec;
  warnings: string[];
  elements: number;
}

const SKIP_TAGS = new Set(["script", "style", "link", "meta", "head", "title", "template", "noscript", "base", "wbr"]);
const INLINE_FORMAT = new Set([
  "b", "strong", "i", "em", "u", "s", "del", "ins", "mark", "small", "sub", "sup", "span", "a", "code", "abbr",
  "label", "font", "br", "kbd", "q", "cite", "time", "data", "big", "var", "samp", "bdi", "bdo",
]);
const UNSUPPORTED = new Set(["svg", "canvas", "video", "audio", "iframe", "object", "embed", "picture", "math"]);
const UTILITY_CLASS = /^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|rounded|shadow|border|items|justify|content|self|place|text|font|bg|from|via|to|ring|gap|space|overflow|truncate|uppercase|lowercase|capitalize|italic|underline|transition|duration|ease|transform|cursor|select|pointer|group|peer|w|h|p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|min|max|z|top|left|right|bottom|inset|opacity|leading|tracking|aspect|object|order|shrink|grow|basis|wrap|whitespace|break|sr|antialiased|backdrop|blur|drop|filter|outline|divide|active|selected|disabled|done|on|off|primary|secondary|ghost|small|large|big|dark|light|clearfix|row|col)$/;
const TAG_NAMES: Record<string, string> = {
  header: "Header", footer: "Footer", nav: "Nav", main: "Main", section: "Section", aside: "Sidebar", article: "Article",
  h1: "Title", h2: "Heading", h3: "Heading", h4: "Heading", h5: "Heading", h6: "Heading", p: "Text", ul: "List", ol: "List",
  li: "Item", form: "Form", label: "Label", table: "Table", tr: "Row", td: "Cell", th: "Cell", figure: "Figure", dialog: "Dialog",
};

// --------------------------------------------------------------- utilities

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let colorCtx: CanvasRenderingContext2D | null = null;
const colorCache = new Map<string, Rgba>();

/** Resolve any CSS color (including oklch/lab/hsl) to sRGB via a 1px canvas. */
export function resolveColor(css: string | null | undefined): Rgba {
  if (!css) return { r: 0, g: 0, b: 0, a: 0 };
  const parsed = parseColor(css);
  if (parsed) return parsed;
  const hit = colorCache.get(css);
  if (hit) return hit;
  colorCtx ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  let out: Rgba = { r: 0, g: 0, b: 0, a: 1 };
  if (colorCtx) {
    colorCtx.clearRect(0, 0, 1, 1);
    colorCtx.fillStyle = "#000";
    colorCtx.fillStyle = css;
    colorCtx.fillRect(0, 0, 1, 1);
    const d = colorCtx.getImageData(0, 0, 1, 1).data;
    out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  }
  colorCache.set(css, out);
  return out;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const px = (v: string) => parseFloat(v) || 0;

function thumbAssetId(url: string): string | null {
  const m = url.match(/\/api\/thumb\/(\d+)/) ?? url.match(/rbxassetid:\/\/(\d+)/);
  return m ? `rbxassetid://${m[1]}` : null;
}

/** Make the HTML safe and deterministic to render: no scripts, eager images, rbxassetid → thumbnail proxy. */
export function prepareHtml(html: string): string {
  let s = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<meta[^>]+http-equiv[^>]*>/gi, "")
    .replace(/\bloading\s*=\s*(["'])lazy\1/gi, 'loading="eager"')
    .replace(/(<img\b[^>]*?)\bsrc\s*=\s*(["'])rbxassetid:\/\/(\d+)\2/gi, (_m, pre, q, id) => `${pre}src=${q}/api/thumb/${id}${q} data-rbx-image=${q}rbxassetid://${id}${q}`)
    .replace(/url\(\s*(["']?)rbxassetid:\/\/(\d+)\1\s*\)/gi, (_m, q, id) => `url(${q}/api/thumb/${id}${q})`);
  const reset = `<style data-forge-reset>html,body{margin:0}html{scrollbar-width:none}html::-webkit-scrollbar{display:none}</style>`;
  if (!/<html[\s>]/i.test(s)) {
    s = `<!doctype html><html><head><meta charset="utf-8">${reset}</head><body>${s}</body></html>`;
  } else {
    if (!/^\s*<!doctype/i.test(s)) s = "<!doctype html>" + s;
    s = /<head[^>]*>/i.test(s) ? s.replace(/<head[^>]*>/i, (m) => m + reset) : s.replace(/<html[^>]*>/i, (m) => m + "<head>" + reset + "</head>");
  }
  return s;
}

/** Render prepared HTML in a hidden sandboxed iframe at the given size. */
async function renderFrame(html: string, width: number, height: number): Promise<HTMLIFrameElement> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  Object.assign(iframe.style, {
    position: "fixed", left: "-30000px", top: "0", width: `${width}px`, height: `${height}px`,
    border: "0", opacity: "0", pointerEvents: "none",
  });
  const loaded = new Promise<void>((res) => (iframe.onload = () => res()));
  iframe.srcdoc = prepareHtml(html);
  document.body.appendChild(iframe);
  await Promise.race([loaded, sleep(8000)]);
  const doc = iframe.contentDocument!;
  await Promise.race([doc.fonts.ready, sleep(3000)]);
  await Promise.race([
    Promise.all([...doc.images].map((img) => (img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r)))))),
    sleep(3000),
  ]);
  await sleep(30);
  return iframe;
}

/** Replace ::before/::after content with real spans so they can be measured and exported. */
function materializePseudo(doc: Document, win: Window) {
  const jobs: { el: Element; which: "::before" | "::after"; cs: CSSStyleDeclaration; text: string }[] = [];
  for (const el of [doc.body, ...doc.body.querySelectorAll("*")]) {
    if (SKIP_TAGS.has(el.tagName.toLowerCase()) || UNSUPPORTED.has(el.tagName.toLowerCase())) continue;
    for (const which of ["::before", "::after"] as const) {
      const cs = win.getComputedStyle(el, which);
      const content = cs.content;
      if (!content || content === "none" || content === "normal") continue;
      const m = content.match(/^(["'])(.*)\1$/s);
      if (!m) continue; // counters, attr(), url() …
      const text = m[2].replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_x, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, "$1");
      jobs.push({ el, which, cs, text });
    }
  }
  if (!jobs.length) return;
  const style = doc.createElement("style");
  style.textContent = ".__forge-nopseudo::before,.__forge-nopseudo::after{content:none!important}";
  for (const j of jobs) {
    const span = doc.createElement("span");
    span.setAttribute("data-forge-pseudo", j.which);
    for (let i = 0; i < j.cs.length; i++) {
      const prop = j.cs[i];
      span.style.setProperty(prop, j.cs.getPropertyValue(prop));
    }
    span.style.setProperty("content", "normal");
    span.textContent = j.text;
    if (j.which === "::before") j.el.insertBefore(span, j.el.firstChild);
    else j.el.appendChild(span);
  }
  for (const j of jobs) j.el.classList.add("__forge-nopseudo");
  doc.head.appendChild(style);
}

/**
 * Keep translations but drop rotation/scale so getBoundingClientRect returns layout boxes;
 * rotations are re-applied as GuiObject.Rotation.
 */
function neutralizeTransforms(doc: Document, win: Window): Map<Element, Transform2D> {
  const out = new Map<Element, Transform2D>();
  for (const el of doc.body.querySelectorAll("*")) {
    const t = parseTransform(win.getComputedStyle(el).transform);
    if (t.identityLinear) continue;
    out.set(el, t);
    (el as HTMLElement).style?.setProperty("transform", `translate(${t.tx}px, ${t.ty}px)`, "important");
  }
  for (const el of doc.querySelectorAll("*")) {
    if ((el as HTMLElement).scrollTop) (el as HTMLElement).scrollTop = 0;
  }
  return out;
}

// --------------------------------------------------------------- converter

interface Space {
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  flexX: boolean;
  flexY: boolean;
  opacity: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

class Converter {
  nodes: UiNode[] = [];
  used = new Set<string>();
  warnings = new Set<string>();
  elements = 0;
  constructor(private win: Window, private doc: Document, private opts: HtmlConvertOptions, private transforms: Map<Element, Transform2D>) {}

  warn(msg: string) {
    if (this.warnings.size < 25) this.warnings.add(msg);
  }

  unique(base: string): string {
    base = (base || "Frame").slice(0, 50);
    let name = base;
    let n = 2;
    while (this.used.has(name)) name = `${base}${n++}`;
    this.used.add(name);
    return name;
  }

  baseName(el: Element, type: UiType, text?: string): string {
    const explicit = el.getAttribute("data-name") || el.id;
    if (explicit) return instanceName(explicit) || "Frame";
    const cls = [...el.classList].find((c) => /^[a-z][a-z-_]*[a-z]$/i.test(c) && !UTILITY_CLASS.test(c.toLowerCase()) && !c.startsWith("__forge"));
    const suffix = type === "TextButton" || type === "ImageButton" ? "Button" : type === "TextLabel" ? "Label" : type === "TextBox" ? "Input" : type === "ImageLabel" ? "Image" : type === "ScrollingFrame" ? "List" : "";
    if (cls) {
      const base = instanceName(cls);
      return suffix && !base.endsWith(suffix) && type !== "Frame" ? base + suffix : base;
    }
    if (text) {
      const words = instanceName(text.replace(/<[^>]+>/g, "").split(/\s+/).slice(0, 3).join(" "));
      if (words && suffix) return words.slice(0, 32) + suffix;
    }
    const tagName = TAG_NAMES[el.tagName.toLowerCase()];
    if (tagName) return tagName;
    return suffix || "Frame";
  }

  /** Position/size an absolute box inside a parent space with edge/center anchoring. */
  place(b: Box, parent: Space) {
    const axis = (start: number, len: number, total: number, flexible: boolean) => {
      const a0 = Math.round(start), a1 = Math.round(start + len);
      const size = a1 - a0;
      if (!flexible) return { s: 0, o: a0, a: 0, ss: 0, so: size, flex: false };
      if (Math.abs(start) <= 1.5 && Math.abs(start + len - total) <= 1.5) return { s: 0, o: 0, a: 0, ss: 1, so: Math.round(len - total), flex: true };
      const center = start + len / 2 - total / 2;
      const before = start, after = total - start - len;
      if (Math.abs(center) <= 2) return { s: 0.5, o: Math.round(center), a: 0.5, ss: 0, so: size, flex: false };
      if (after < before) return { s: 1, o: -Math.round(after), a: 1, ss: 0, so: size, flex: false };
      return { s: 0, o: a0, a: 0, ss: 0, so: size, flex: false };
    };
    const x = axis(b.x - parent.x, b.w, parent.w, parent.flexX);
    const y = axis(b.y - parent.y, b.h, parent.h, parent.flexY);
    return {
      pos: [x.s, x.o, y.s, y.o],
      size: [x.ss, x.so, y.ss, y.so],
      anchor: x.a || y.a ? [x.a, y.a] : undefined,
      flexX: x.flex,
      flexY: y.flex,
    };
  }

  /** Place a box with the same anchoring as another node (so e.g. its shadow moves with it). */
  placeAs(b: Box, parent: Space, ref: ReturnType<Converter["place"]>) {
    const anchor = ref.anchor ?? [0, 0];
    const axis = (start: number, len: number, total: number, posScale: number, a: number, sizeScale: number) => ({
      o: Math.round(start + a * len - posScale * total),
      so: sizeScale === 1 ? Math.round(len - total) : Math.round(len),
    });
    const x = axis(b.x - parent.x, b.w, parent.w, ref.pos[0], anchor[0], ref.size[0]);
    const y = axis(b.y - parent.y, b.h, parent.h, ref.pos[2], anchor[1], ref.size[2]);
    return { pos: [ref.pos[0], x.o, ref.pos[2], y.o], size: [ref.size[0], x.so, ref.size[2], y.so], anchor: ref.anchor };
  }

  push(node: UiNode) {
    if (this.nodes.length >= 2900) {
      this.warn("Stopped at 2900 GUI objects — simplify the HTML for a complete translation.");
      return false;
    }
    this.nodes.push(node);
    return true;
  }

  // ----------------------------------------------------------- text

  textStyle(cs: CSSStyleDeclaration, opacity: number) {
    const c = resolveColor(cs.color);
    const weight = parseInt(cs.fontWeight) || 400;
    const size = Math.max(1, Math.min(100, Math.round(px(cs.fontSize))));
    if (px(cs.fontSize) > 100.5) this.warn("Text larger than 100px is capped at 100 (Roblox's maximum TextSize).");
    const font: FontName = mapFont(cs.fontFamily, weight);
    const out: Partial<UiNode> = { textColor: toHex(c), textSize: size, font };
    const textT = round3(1 - c.a * opacity);
    if (textT > 0) out.textT = Math.min(1, textT);
    const strokeW = px(cs.getPropertyValue("-webkit-text-stroke-width"));
    if (strokeW > 0) {
      const sc = resolveColor(cs.getPropertyValue("-webkit-text-stroke-color"));
      out.textStroke = { color: toHex(sc), transparency: round3(1 - sc.a * opacity) };
    } else {
      const sh = parseShadows(cs.textShadow)[0];
      if (sh) {
        const sc = resolveColor(sh.color);
        if (sc.a > 0.05) out.textStroke = { color: toHex(sc), transparency: round3(1 - Math.min(1, sc.a * (sh.blur > 4 ? 0.6 : 1)) * opacity) };
      }
    }
    return out;
  }

  /** Text of an inline-only subtree, as plain text and as Roblox RichText. */
  buildText(el: Element, base: CSSStyleDeclaration): { text: string; rich: boolean } {
    const win = this.win;
    const pre = /^pre/.test(base.whiteSpace) || base.whiteSpace === "break-spaces";
    const baseWeight = parseInt(base.fontWeight) || 400;
    const baseItalic = /italic|oblique/.test(base.fontStyle);
    let usesRich = false;
    let plain = "";
    let rich = "";
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const transform = (t: string, mode: string) =>
      mode === "uppercase" ? t.toUpperCase() : mode === "lowercase" ? t.toLowerCase() : mode === "capitalize" ? t.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : t;
    const visit = (node: Node, cs: CSSStyleDeclaration) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          let t = child.textContent ?? "";
          if (!pre) t = t.replace(/\s+/g, " ");
          t = transform(t, cs.textTransform);
          plain += t;
          rich += esc(t);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const c = child as Element;
          const tag = c.tagName.toLowerCase();
          if (tag === "br") {
            plain += "\n";
            rich += "\n";
            continue;
          }
          const ccs = win.getComputedStyle(c);
          if (ccs.display === "none") continue;
          const open: string[] = [];
          const close: string[] = [];
          const w = parseInt(ccs.fontWeight) || 400;
          if (w >= 600 && baseWeight < 600) open.push("<b>"), close.unshift("</b>");
          if (/italic|oblique/.test(ccs.fontStyle) && !baseItalic) open.push("<i>"), close.unshift("</i>");
          if (ccs.textDecorationLine.includes("underline") && !base.textDecorationLine.includes("underline")) open.push("<u>"), close.unshift("</u>");
          if (ccs.textDecorationLine.includes("line-through") && !base.textDecorationLine.includes("line-through")) open.push("<s>"), close.unshift("</s>");
          const attrs: string[] = [];
          if (ccs.color !== cs.color) {
            const col = resolveColor(ccs.color);
            attrs.push(`color="${toHex(col)}"`);
            if (col.a < 0.99) attrs.push(`transparency="${round3(1 - col.a)}"`);
          }
          if (ccs.fontSize !== cs.fontSize) attrs.push(`size="${Math.round(px(ccs.fontSize))}"`);
          if (attrs.length) open.push(`<font ${attrs.join(" ")}>`), close.unshift("</font>");
          if (open.length) usesRich = true;
          rich += open.join("");
          visit(c, ccs);
          rich += close.join("");
        }
      }
    };
    visit(el, base);
    const tidy = (s: string) => (pre ? s : s.replace(/ {2,}/g, " ").replace(/ ?\n ?/g, "\n").trim());
    plain = tidy(plain);
    rich = tidy(rich).replace(/^(<[^/][^>]*>)+ /, (m) => m.trimEnd());
    // Styles on the element itself apply to the whole label.
    if (baseItalic) rich = `<i>${rich}</i>`;
    if (base.textDecorationLine.includes("underline")) rich = `<u>${rich}</u>`;
    if (base.textDecorationLine.includes("line-through")) rich = `<s>${rich}</s>`;
    if (baseItalic || /underline|line-through/.test(base.textDecorationLine)) usesRich = true;
    return usesRich ? { text: rich, rich: true } : { text: plain, rich: false };
  }

  textGeometry(target: Node, content: Box, cs: CSSStyleDeclaration) {
    const range = this.doc.createRange();
    range.selectNodeContents(target);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    range.detach?.();
    if (!rects.length) return null;
    const left = Math.min(...rects.map((r) => r.left)), right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
    const lineTops = new Set(rects.map((r) => Math.round((r.top + r.bottom) / 2 / 4)));
    const lines = lineTops.size;
    const align = cs.textAlign;
    let xAlign: "left" | "center" | "right";
    const lg = left - content.x, rg = content.x + content.w - right;
    if (lines > 1 || (lg < 1.5 && rg < 1.5)) xAlign = align === "center" ? "center" : align === "right" || align === "end" ? "right" : "left";
    else if (Math.abs(lg - rg) <= 2.5) xAlign = "center";
    else xAlign = rg < lg ? "right" : "left";
    const tg = top - content.y, bg = content.y + content.h - bottom;
    const yAlign: "top" | "center" | "bottom" = Math.abs(tg - bg) <= 3 ? "center" : tg < bg ? "top" : "bottom";
    return { box: { x: left, y: top, w: right - left, h: bottom - top }, lines, xAlign, yAlign };
  }

  /** Apply text props to a node whose text area is `content`. */
  applyText(node: UiNode, el: Element, cs: CSSStyleDeclaration, content: Box, opacity: number) {
    const { text, rich } = this.buildText(el, cs);
    const geo = this.textGeometry(el, content, cs);
    Object.assign(node, this.textStyle(cs, opacity));
    node.text = text.slice(0, 2000);
    if (rich) node.rich = true;
    if (geo) {
      if (geo.xAlign !== "center") node.xAlign = geo.xAlign;
      if (geo.yAlign !== "center") node.yAlign = geo.yAlign;
      const nowrap = cs.whiteSpace === "nowrap" || cs.whiteSpace === "pre";
      if (geo.lines > 1 && !nowrap) node.textWrapped = true;
    }
    if (cs.textOverflow === "ellipsis") node.truncate = true;
  }

  /** A loose text run inside a mixed-content element becomes its own label. */
  textRun(textNode: Text, cs: CSSStyleDeclaration, space: Space) {
    const range = this.doc.createRange();
    range.selectNodeContents(textNode);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    if (!rects.length) return;
    const left = Math.min(...rects.map((r) => r.left)) - 1, right = Math.max(...rects.map((r) => r.right)) + 3;
    const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
    const lines = new Set(rects.map((r) => Math.round(r.top / 4))).size;
    let text = (textNode.textContent ?? "").replace(/\s+/g, " ").trim();
    if (cs.textTransform === "uppercase") text = text.toUpperCase();
    if (!text) return;
    const p = this.place({ x: left, y: top, w: right - left, h: bottom - top }, space);
    const node: UiNode = {
      name: this.unique(this.baseName(textNode.parentElement!, "TextLabel", text)),
      parent: space.name,
      type: "TextLabel",
      pos: p.pos,
      size: p.size,
      ...(p.anchor ? { anchor: p.anchor } : {}),
      text,
      xAlign: "left",
      ...this.textStyle(cs, space.opacity),
    };
    if (lines > 1) node.textWrapped = true;
    this.push(node);
  }

  // ----------------------------------------------------------- elements

  hasVisualBox(cs: CSSStyleDeclaration): boolean {
    if (resolveColor(cs.backgroundColor).a > 0.01) return true;
    if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
    if (cs.boxShadow && cs.boxShadow !== "none") return true;
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      if (px(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 && cs.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none") return true;
    }
    return false;
  }

  /** Text-only element (text plus inline formatting such as <b>, <span style="color">, <br>). */
  isTextLeaf(el: Element): boolean {
    let hasText = false;
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        if ((n.textContent ?? "").trim()) hasText = true;
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const c = n as Element;
        const tag = c.tagName.toLowerCase();
        if (tag === "br") continue;
        if (SKIP_TAGS.has(tag)) continue;
        const ccs = this.win.getComputedStyle(c);
        if (ccs.display === "none") continue;
        if (!INLINE_FORMAT.has(tag) || ccs.display !== "inline" || this.hasVisualBox(ccs) || c.hasAttribute("data-name") || c.id || c.hasAttribute("data-forge-pseudo")) return false;
        if (c.children.length && !this.isTextLeaf(c)) return false;
        if ((c.textContent ?? "").trim()) hasText = true;
      }
    }
    return hasText;
  }

  listMarker(el: Element, cs: CSSStyleDeclaration, outer: Box, parent: Space, opacity: number) {
    const type = cs.listStyleType;
    const siblings = el.parentElement ? [...el.parentElement.children].filter((c) => this.win.getComputedStyle(c).display === "list-item") : [el];
    const index = siblings.indexOf(el) + Number(el.parentElement?.getAttribute("start") ?? 1);
    const marker =
      type === "circle" ? "◦" : type === "square" ? "▪" : type === "decimal" || type === "decimal-leading-zero" ? `${index}.` :
      type === "lower-alpha" || type === "lower-latin" ? `${String.fromCharCode(96 + index)}.` : type === "upper-alpha" || type === "upper-latin" ? `${String.fromCharCode(64 + index)}.` : "•";
    const range = this.doc.createRange();
    range.selectNodeContents(el);
    const first = [...range.getClientRects()].find((r) => r.width > 0 && r.height > 0);
    const size = px(cs.fontSize);
    const w = Math.ceil(size * (marker.length > 1 ? marker.length * 0.6 + 0.4 : 1.1));
    const top = first ? first.top : outer.y;
    const h = first ? first.height : size * 1.2;
    const p = this.place({ x: outer.x - w - (cs.listStylePosition === "inside" ? -w : 2), y: top, w, h }, parent);
    this.push({
      name: this.unique(`${this.baseName(el, "Frame")}Bullet`),
      parent: parent.name,
      type: "TextLabel",
      pos: p.pos,
      size: p.size,
      ...(p.anchor ? { anchor: p.anchor } : {}),
      text: marker,
      xAlign: "right",
      ...this.textStyle(cs, opacity),
    });
  }

  walkChildren(el: Element, space: Space, cs: CSSStyleDeclaration) {
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) this.walk(child as Element, space);
      else if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim()) this.textRun(child as Text, cs, space);
    }
  }

  walk(el: Element, parent: Space) {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    const win = this.win;
    const cs = win.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return;
    this.elements++;
    const opacity = parent.opacity * (parseFloat(cs.opacity) || 0);
    if (opacity < 0.01) return;
    if (cs.display === "contents") return this.walkChildren(el, parent, cs);
    if (UNSUPPORTED.has(tag)) {
      this.warn(`<${tag}> isn't supported in Roblox GUIs and was skipped — use an rbxassetid image, emoji or text instead.`);
      return;
    }

    const rect = el.getBoundingClientRect();
    let outer: Box = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    const tf = this.transforms.get(el);
    const rotation = tf && Math.abs(tf.rotation) > 0.5 ? Math.round(tf.rotation * 10) / 10 : 0;
    if (tf && (Math.abs(tf.scaleX - 1) > 0.01 || Math.abs(tf.scaleY - 1) > 0.01)) {
      const cx = outer.x + outer.w / 2, cy = outer.y + outer.h / 2;
      outer = { x: cx - (outer.w * tf.scaleX) / 2, y: cy - (outer.h * tf.scaleY) / 2, w: outer.w * tf.scaleX, h: outer.h * tf.scaleY };
      if (el.children.length) this.warn("Scaled elements keep their children at the original scale.");
    }

    const type = (el as HTMLInputElement).type?.toLowerCase?.() ?? "";
    const isTextInput = tag === "textarea" || (tag === "input" && !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "hidden", "image"].includes(type));
    const isImg = tag === "img" || (tag === "input" && type === "image");
    const isButton = tag === "button" || tag === "select" || (tag === "a" && el.hasAttribute("href")) || el.getAttribute("role") === "button" || (tag === "input" && ["button", "submit", "reset"].includes(type));
    const isCheck = tag === "input" && (type === "checkbox" || type === "radio");
    const isProgress = tag === "progress" || tag === "meter";
    if (tag === "input" && type === "hidden") return;

    const bg = resolveColor(cs.backgroundColor);
    const bgImage = cs.backgroundImage && cs.backgroundImage !== "none" ? cs.backgroundImage : "";
    const gradient = bgImage ? parseLinearGradient(bgImage) : null;
    const bgUrl = bgImage ? backgroundUrls(bgImage).map(thumbAssetId).find(Boolean) ?? null : null;
    const otherUrl = bgImage && !bgUrl && backgroundUrls(bgImage).length > 0;
    const radial = bgImage && !gradient && hasRadialGradient(bgImage);
    const sides = (["top", "right", "bottom", "left"] as const).map((s) => ({
      w: cs.getPropertyValue(`border-${s}-style`) === "none" || cs.getPropertyValue(`border-${s}-style`) === "hidden" ? 0 : px(cs.getPropertyValue(`border-${s}-width`)),
      color: resolveColor(cs.getPropertyValue(`border-${s}-color`)),
    }));
    const uniformBorder = sides.every((s) => s.w > 0 && Math.abs(s.w - sides[0].w) < 0.1 && toHex(s.color) === toHex(sides[0].color) && Math.abs(s.color.a - sides[0].color.a) < 0.01);
    const partialBorders = !uniformBorder && sides.some((s) => s.w > 0 && s.color.a > 0.01);
    const outlineW = cs.outlineStyle !== "none" ? px(cs.outlineWidth) : 0;
    const shadows = this.opts.shadows === false ? [] : parseShadows(cs.boxShadow).filter((s) => !s.inset && resolveColor(s.color).a > 0.02);
    const overflowX = cs.overflowX, overflowY = cs.overflowY;
    const clips = ["hidden", "clip", "auto", "scroll"].includes(overflowX) || ["hidden", "clip", "auto", "scroll"].includes(overflowY);
    const scrollY = ["auto", "scroll"].includes(overflowY) && el.scrollHeight > el.clientHeight + 1;
    const scrollX = ["auto", "scroll"].includes(overflowX) && el.scrollWidth > el.clientWidth + 1;
    const scrollable = scrollY || scrollX;
    const textLeaf = !isTextInput && !isImg && this.isTextLeaf(el);
    const named = !!(el.id || el.hasAttribute("data-name"));
    const visual = bg.a > 0.01 || !!gradient || !!bgUrl || !!radial || uniformBorder || partialBorders || outlineW > 0 || shadows.length > 0;
    const isBody = el === this.doc.body || el === this.doc.documentElement;

    if (isBody) {
      if (visual) this.warn("The page background isn't exported — in Roblox the game world shows behind the UI. Use a full-screen <div> if you want a backdrop.");
      return this.walkChildren(el, parent, cs);
    }
    if (otherUrl) this.warn("Background images must be rbxassetid://… — other URLs were skipped.");

    // Wrappers grouping several items inside a stretchy parent become (invisible) frames so the
    // items stay together when edge-anchored on other screen shapes.
    const visibleKids = [...el.children].filter((c) => !SKIP_TAGS.has(c.tagName.toLowerCase()) && win.getComputedStyle(c).display !== "none").length;
    const groups = visibleKids >= 2 && (parent.flexX || parent.flexY) && (outer.w < parent.w - 2 || outer.h < parent.h - 2);
    const makesNode = visual || isTextInput || isImg || isButton || isCheck || isProgress || scrollable || textLeaf || rotation !== 0 || named || groups || (clips && el.children.length > 0);
    if (!makesNode || outer.w < 0.5 || outer.h < 0.5) {
      if (outer.w < 0.5 && outer.h < 0.5 && !el.children.length) return;
      return this.walkChildren(el, parent, cs);
    }

    // Node type.
    let nodeType: UiType;
    if (isTextInput) nodeType = "TextBox";
    else if (isImg) nodeType = "ImageLabel";
    else if (scrollable) nodeType = "ScrollingFrame";
    else if (isButton || isCheck) nodeType = textLeaf || isCheck ? "TextButton" : bgUrl ? "ImageButton" : "TextButton";
    else if (bgUrl && !textLeaf) nodeType = "ImageLabel";
    else if (textLeaf) nodeType = "TextLabel";
    else nodeType = "Frame";

    // Uniform borders become an outside UIStroke on a frame shrunk by the border width.
    const bw = uniformBorder ? sides[0].w : 0;
    const box: Box = { x: outer.x + bw, y: outer.y + bw, w: Math.max(0, outer.w - 2 * bw), h: Math.max(0, outer.h - 2 * bw) };
    const placed = this.place(box, parent);
    const textForName = textLeaf ? (el.textContent ?? "").trim() : isTextInput ? (el as HTMLInputElement).placeholder : undefined;
    const name = this.unique(this.baseName(el, nodeType, textForName));
    const node: UiNode = {
      name,
      parent: parent.name,
      type: nodeType,
      pos: placed.pos,
      size: placed.size,
      ...(placed.anchor ? { anchor: placed.anchor } : {}),
    };
    if (rotation) node.rotation = rotation;

    // Background.
    if (gradient) {
      const stops = gradient.stops.length > 8 ? Array.from({ length: 8 }, (_, i) => gradient.stops[Math.round((i * (gradient.stops.length - 1)) / 7)]) : gradient.stops;
      const cols = stops.map((s) => resolveColor(s.color));
      node.bg = "#ffffff";
      node.bgT = round3(1 - opacity);
      node.gradient = {
        colors: cols.map(toHex),
        stops: stops.map((s) => round3(s.pos ?? 0)),
        rotation: Math.round(gradient.angle - 90),
      };
      if (cols.some((c) => c.a < 0.99)) node.gradient.transparency = cols.map((c) => round3(1 - c.a));
    } else if (radial) {
      const cols = [...bgImage.matchAll(/(rgba?\([^)]+\)|#[0-9a-f]{3,8})/gi)].map((m) => resolveColor(m[1]));
      const avg = cols.reduce((a, c) => ({ r: a.r + c.r / cols.length, g: a.g + c.g / cols.length, b: a.b + c.b / cols.length, a: a.a + c.a / cols.length }), { r: 0, g: 0, b: 0, a: 0 });
      node.bg = toHex(avg);
      node.bgT = round3(1 - avg.a * opacity);
      this.warn("Radial/conic gradients are approximated with their average color (Roblox only has linear gradients).");
    } else if (bg.a > 0.01) {
      node.bg = toHex(bg);
      node.bgT = round3(1 - bg.a * opacity);
    } else {
      node.bgT = 1;
    }

    // Corners.
    const radii = ["top-left", "top-right", "bottom-right", "bottom-left"].map((c) => {
      const v = cs.getPropertyValue(`border-${c}-radius`).split(" ")[0];
      return v.endsWith("%") ? (parseFloat(v) / 100) * Math.min(outer.w, outer.h) : px(v);
    });
    const radius = Math.max(...radii);
    if (radius > 0.5) {
      const minSide = Math.min(box.w, box.h);
      const r = Math.max(0, radius - bw);
      node.corner = r >= minSide / 2 - 0.5 ? [0.5, 0] : Math.round(r);
    }

    // Borders / outline.
    if (uniformBorder) {
      node.stroke = { color: toHex(sides[0].color), thickness: round3(bw), transparency: round3(1 - sides[0].color.a * opacity) };
    } else if (outlineW > 0 && !partialBorders) {
      const oc = resolveColor(cs.outlineColor);
      if (oc.a > 0.01) node.stroke = { color: toHex(oc), thickness: round3(outlineW), transparency: round3(1 - oc.a * opacity) };
    }
    if (node.stroke && node.stroke.transparency === 0) delete node.stroke.transparency;
    if (cs.borderTopStyle !== "solid" && uniformBorder && cs.borderTopStyle !== "none") this.warn("Dashed/dotted borders are drawn solid in Roblox.");

    if (clips && !scrollable) node.clip = true;
    if (scrollable) {
      node.canvas = [0, scrollX ? Math.round(el.scrollWidth) : 0, 0, scrollY ? Math.round(el.scrollHeight) : 0];
      const sbw = cs.getPropertyValue("scrollbar-width");
      node.scrollBar = sbw === "none" ? 0 : sbw === "thin" ? 4 : 6;
      const sbc = cs.getPropertyValue("scrollbar-color");
      if (sbc && sbc !== "auto") node.scrollColor = toHex(resolveColor(splitTopLevel(sbc, " ")[0]));
    }

    // Padding (only for nodes that render their own text, so children offsets stay absolute).
    const pad = [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)].map((v) => Math.round(v));
    const content: Box = { x: box.x + pad[3], y: box.y + pad[0], w: Math.max(0, box.w - pad[1] - pad[3]), h: Math.max(0, box.h - pad[0] - pad[2]) };
    const setPadding = () => {
      if (pad.some((v) => v > 0)) node.padding = pad[0] === pad[1] && pad[1] === pad[2] && pad[2] === pad[3] ? pad[0] : (pad as [number, number, number, number]);
    };

    if (isTextInput) {
      const input = el as HTMLInputElement;
      Object.assign(node, this.textStyle(cs, opacity));
      node.text = input.value ?? "";
      if (input.placeholder) node.placeholder = input.placeholder;
      const ph = resolveColor(win.getComputedStyle(el, "::placeholder").color);
      if (ph.a > 0) node.placeholderColor = toHex(ph);
      node.xAlign = cs.textAlign === "center" ? "center" : cs.textAlign === "right" || cs.textAlign === "end" ? "right" : "left";
      if (tag === "textarea") {
        node.yAlign = "top";
        node.textWrapped = true;
      }
      setPadding();
    } else if (isImg) {
      const img = el as HTMLImageElement;
      const id = img.getAttribute("data-rbx-image") ?? thumbAssetId(img.currentSrc || img.src || "");
      node.image = id ?? "";
      if (!id) this.warn(`Image "${(img.getAttribute("src") ?? "").slice(0, 60)}" needs a Roblox asset id (upload it to Roblox and use src="rbxassetid://ID").`);
      const fit = cs.objectFit;
      node.scaleType = fit === "contain" || fit === "scale-down" || fit === "none" ? "Fit" : fit === "cover" ? "Crop" : "Stretch";
      if (opacity < 1) node.imageT = round3(1 - opacity);
    } else if (isCheck) {
      // Native look: a ticked checkbox is a filled accent box with a white tick;
      // a selected radio is a white circle with an accent ring and dot.
      const checked = (el as HTMLInputElement).checked;
      const accent = toHex(resolveColor(cs.accentColor && cs.accentColor !== "auto" ? cs.accentColor : "#3b82f6"));
      const filled = checked && type === "checkbox";
      node.text = checked ? (type === "radio" ? "●" : "✓") : "";
      node.textColor = filled ? "#ffffff" : accent;
      node.textSize = Math.round(box.h * (type === "radio" ? 0.6 : 0.8));
      node.font = "BuilderSansBold";
      if (bg.a <= 0.01) {
        node.bg = filled ? accent : "#ffffff";
        node.bgT = round3(1 - opacity);
      }
      node.stroke ??= { color: checked ? accent : "#8a8f9c", thickness: 1 };
      node.corner ??= type === "radio" ? [0.5, 0] : 3;
    } else if (textLeaf || (isButton && tag === "select")) {
      if (tag === "select") {
        const sel = el as HTMLSelectElement;
        Object.assign(node, this.textStyle(cs, opacity));
        node.text = `${sel.selectedOptions[0]?.textContent?.trim() ?? ""}  ▾`;
        node.xAlign = "left";
      } else this.applyText(node, el, cs, content, opacity);
      setPadding();
    } else if (bgUrl) {
      node.image = bgUrl;
      const size = cs.backgroundSize;
      node.scaleType = size === "contain" ? "Fit" : size === "cover" ? "Crop" : "Stretch";
      if (opacity < 1) node.imageT = round3(1 - opacity);
    }
    if (isButton && !textLeaf && tag !== "select" && nodeType === "TextButton") node.text = "";

    if (cs.position !== "static" && cs.zIndex !== "auto") {
      const z = parseInt(cs.zIndex);
      if (Number.isFinite(z) && z > 0) node.z = Math.min(1000, z + 1);
    }

    // Soft shadow approximation: a few concentric frames behind the node whose alphas combine
    // to the shadow's alpha, spread across the blur radius. They share the node's anchoring.
    if (shadows.length) {
      const s = shadows.reduce((a, b) => (b.blur + b.spread > a.blur + a.spread ? b : a));
      const col = resolveColor(s.color);
      const blur = Math.min(s.blur, 48);
      const count = blur >= 16 ? 4 : blur >= 6 ? 3 : blur > 1 ? 2 : 1;
      // A blurred shadow is lighter than its color at the edges; keep the layered version subtle.
      const strength = blur > 1 ? 0.6 : 1;
      const layerAlpha = 1 - Math.pow(1 - Math.min(0.95, col.a * strength), 1 / count);
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0.5 : i / (count - 1);
        const grow = s.spread + blur * (t - 0.4) * 0.7;
        const sb: Box = { x: outer.x + s.x - grow, y: outer.y + s.y - grow, w: outer.w + 2 * grow, h: outer.h + 2 * grow };
        if (sb.w <= 1 || sb.h <= 1) continue;
        const sp = this.placeAs(sb, parent, placed);
        const shadow: UiNode = {
          name: this.unique(`${name}Shadow${i ? i + 1 : ""}`),
          parent: parent.name,
          type: "Frame",
          pos: sp.pos,
          size: sp.size,
          ...(sp.anchor ? { anchor: sp.anchor } : {}),
          bg: toHex(col),
          bgT: round3(1 - layerAlpha * opacity),
          ...(node.z ? { z: node.z } : {}),
          ...(rotation ? { rotation } : {}),
        };
        const r = Math.max(0, radius + grow);
        if (r > 0.5) shadow.corner = r >= Math.min(sb.w, sb.h) / 2 - 0.5 ? [0.5, 0] : Math.round(r);
        this.push(shadow);
      }
    }

    // List bullets (::marker) become a small label left of the first line.
    if (cs.display === "list-item" && cs.listStyleType !== "none") this.listMarker(el, cs, outer, parent, opacity);

    if (!this.push(node)) return;

    // Single-side borders become thin frames along the inside edges.
    if (partialBorders) {
      const [t, r, b, l] = sides;
      const lines: [string, Box, Rgba][] = [];
      if (t.w > 0) lines.push(["Top", { x: 0, y: 0, w: outer.w, h: t.w }, t.color]);
      if (b.w > 0) lines.push(["Bottom", { x: 0, y: outer.h - b.w, w: outer.w, h: b.w }, b.color]);
      if (l.w > 0) lines.push(["Left", { x: 0, y: 0, w: l.w, h: outer.h }, l.color]);
      if (r.w > 0) lines.push(["Right", { x: outer.w - r.w, y: 0, w: r.w, h: outer.h }, r.color]);
      for (const [side, lb, color] of lines) {
        if (color.a <= 0.01) continue;
        const own: Space = { name, x: 0, y: 0, w: outer.w, h: outer.h, flexX: placed.flexX, flexY: placed.flexY, opacity };
        const lp = this.place(lb, own);
        this.push({ name: this.unique(`${name}Border${side}`), parent: name, type: "Frame", pos: lp.pos, size: lp.size, ...(lp.anchor ? { anchor: lp.anchor } : {}), bg: toHex(color), bgT: round3(1 - color.a * opacity) });
      }
    }

    if (isProgress) {
      const p = el as HTMLProgressElement;
      const ratio = p.max ? Math.max(0, Math.min(1, p.value / p.max)) : 0;
      const accent = resolveColor(cs.accentColor && cs.accentColor !== "auto" ? cs.accentColor : "#3b82f6");
      if (node.bgT === 1) {
        node.bg = "#2a2d36";
        node.bgT = round3(1 - opacity);
      }
      node.clip = true;
      this.push({ name: this.unique(`${name}Fill`), parent: name, type: "Frame", size: [ratio, 0, 1, 0], bg: toHex(accent), ...(node.corner ? { corner: node.corner } : {}) });
      return;
    }

    // Text-bearing nodes consumed their inline children.
    if (isTextInput || isImg || isCheck || textLeaf || tag === "select") return;

    const space: Space = {
      name,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      flexX: placed.flexX && !scrollable,
      flexY: placed.flexY && !scrollable,
      opacity,
    };
    this.walkChildren(el, space, cs);
  }
}

/** Translate an HTML document/fragment into a Roblox UI spec. Runs in the browser. */
export async function convertHtmlToUi(html: string, opts: HtmlConvertOptions): Promise<HtmlConvertResult> {
  const width = Math.round(opts.width), height = Math.round(opts.height);
  const iframe = await renderFrame(html, width, height);
  try {
    const doc = iframe.contentDocument!;
    const win = iframe.contentWindow!;
    materializePseudo(doc, win);
    const transforms = neutralizeTransforms(doc, win);
    const conv = new Converter(win, doc, { ...opts, width, height }, transforms);
    conv.walk(doc.body, { x: 0, y: 0, w: width, h: height, flexX: true, flexY: true, opacity: 1 });
    if (!conv.nodes.length) throw new Error("The HTML produced no visible elements.");
    const raw: UiSpec = {
      name: opts.name,
      ignoreInset: true,
      resetOnSpawn: false,
      ...(opts.autoScale !== false ? { autoScale: { width, height } } : {}),
      nodes: conv.nodes,
    };
    const { spec, warnings } = sanitizeUiSpec(UiSpecSchema.parse(raw));
    return { spec, warnings: [...conv.warnings, ...warnings], elements: conv.elements };
  } finally {
    iframe.remove();
  }
}
