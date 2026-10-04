// Roblox GUI layout, re-implemented for the browser preview.
// Rects are relative to the parent's box so DOM nesting gives rotation/clipping for free.

import { FONTS } from "../../shared/roblox-data.ts";
import {
  buildUiTree, paddingOf, resolveUiNode,
  type ResolvedUiNode, type UiNode, type UiSpec, type UiTreeNode,
} from "../../shared/ui.ts";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidOut {
  node: UiNode;
  r: ResolvedUiNode;
  /** Position/size relative to the parent's box (or canvas, inside ScrollingFrames). */
  box: Box;
  /** Content area for children, relative to this node's box. */
  content: Box;
  /** ScrollingFrame canvas size. */
  canvas?: { w: number; h: number };
  fontSize: number;
  children: LaidOut[];
}

export const LINE_HEIGHT = 1.2;

let measureCtx: CanvasRenderingContext2D | null = null;
export function fontCss(r: ResolvedUiNode, size: number): string {
  const f = FONTS[r.font] ?? FONTS.GothamMedium;
  // Some Roblox fonts are single-weight but visually heavy (FredokaOne ≈ Fredoka SemiBold).
  const weight = "webWeight" in f ? f.webWeight : f.weight;
  return `${f.style === "Italic" ? "italic " : ""}${weight} ${size}px "${f.web}", system-ui, sans-serif`;
}

export function stripRich(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function measure(text: string, font: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 8;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Wrap text into lines no wider than maxW (when wrap is on). */
export function wrapLines(text: string, font: string, maxW: number, wrap: boolean): { lines: string[]; width: number } {
  const out: string[] = [];
  let width = 0;
  for (const para of text.split("\n")) {
    if (!wrap) {
      out.push(para);
      width = Math.max(width, measure(para, font));
      continue;
    }
    const words = para.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const next = line + w;
      if (line && measure(next.trimEnd(), font) > maxW) {
        out.push(line.trimEnd());
        width = Math.max(width, measure(line.trimEnd(), font));
        line = w.trimStart();
      } else line = next;
    }
    out.push(line);
    width = Math.max(width, measure(line, font));
  }
  return { lines: out, width };
}

function fitTextSize(r: ResolvedUiNode, text: string, w: number, h: number): number {
  let lo = 1, hi = 100;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const font = fontCss(r, mid);
    const { lines, width } = wrapLines(text, font, w, true);
    const fits = width <= w + 0.5 && lines.length * mid * LINE_HEIGHT <= h + 0.5;
    if (fits) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const udim = (scale: number, offset: number, size: number) => scale * size + offset;

function applyAspect(n: UiNode, w: number, h: number): [number, number] {
  if (!n.aspect || w <= 0 || h <= 0) return [w, h];
  // FitWithinMaxSize: shrink one axis to keep width/height = aspect.
  if (w / h > n.aspect) return [h * n.aspect, h];
  return [w, w / n.aspect];
}

function sorted(children: UiTreeNode[]): UiTreeNode[] {
  return children
    .map((c, i) => ({ c, i, o: resolveUiNode(c.node).order }))
    .sort((a, b) => a.o - b.o || a.i - b.i)
    .map((x) => x.c);
}

/** Lay out one node given its base size; recursively lays out children. */
function layoutNode(t: UiTreeNode, x: number, y: number, w: number, h: number): LaidOut {
  const r = resolveUiNode(t.node);
  const pad = paddingOf(t.node) ?? [0, 0, 0, 0];
  let out = finish(t, r, { x, y, w, h }, pad);
  // AutomaticSize: grow to fit content, then lay children out again with the final size.
  if (r.autoSize) {
    const need = contentExtent(out, r, pad);
    const nw = r.autoSize.includes("x") ? Math.max(w, need.w) : w;
    const nh = r.autoSize.includes("y") ? Math.max(h, need.h) : h;
    if (nw !== w || nh !== h) out = finish(t, r, { x, y, w: nw, h: nh }, pad);
  }
  return out;
}

function finish(t: UiTreeNode, r: ResolvedUiNode, box: Box, pad: [number, number, number, number]): LaidOut {
  const content: Box = { x: pad[3], y: pad[0], w: Math.max(0, box.w - pad[1] - pad[3]), h: Math.max(0, box.h - pad[0] - pad[2]) };
  const out: LaidOut = { node: t.node, r, box, content, fontSize: r.textSize, children: [] };
  if (r.isText && r.textScaled) out.fontSize = fitTextSize(r, displayText(r), content.w, content.h);

  let area = { w: content.w, h: content.h };
  if (r.type === "ScrollingFrame") {
    const c = t.node.canvas ?? [0, 0, 0, 0];
    area = {
      w: Math.max(box.w, udim(c[0], c[1], box.w)),
      h: Math.max(box.h, udim(c[2], c[3], box.h)),
    };
  }
  out.children = layoutChildren(t, area);
  if (r.type === "ScrollingFrame") {
    let { w, h } = area;
    if (t.node.autoCanvas) {
      const ext = childrenExtent(out.children);
      if (t.node.autoCanvas.includes("x")) w = Math.max(w, ext.w + pad[1] + pad[3]);
      if (t.node.autoCanvas.includes("y")) h = Math.max(h, ext.h + pad[0] + pad[2]);
    }
    out.canvas = { w, h };
  }
  return out;
}

function displayText(r: ResolvedUiNode): string {
  return r.rich ? stripRich(r.text) : r.text;
}

function childrenExtent(children: LaidOut[]): { w: number; h: number } {
  let w = 0, h = 0;
  for (const c of children) {
    w = Math.max(w, c.box.x + c.box.w);
    h = Math.max(h, c.box.y + c.box.h);
  }
  return { w, h };
}

function contentExtent(out: LaidOut, r: ResolvedUiNode, pad: [number, number, number, number]): { w: number; h: number } {
  let { w, h } = childrenExtent(out.children);
  w -= out.content.x;
  h -= out.content.y;
  if (r.isText) {
    const font = fontCss(r, out.fontSize);
    const m = wrapLines(displayText(r), font, r.textWrapped ? out.content.w : Infinity, r.textWrapped && !r.autoSize?.includes("x"));
    w = Math.max(w, m.width);
    h = Math.max(h, m.lines.length * out.fontSize * LINE_HEIGHT);
  }
  return { w: w + pad[1] + pad[3], h: h + pad[0] + pad[2] };
}

function baseSize(n: UiNode, areaW: number, areaH: number): [number, number] {
  const r = resolveUiNode(n);
  const w = udim(r.size[0], r.size[1], areaW);
  const h = udim(r.size[2], r.size[3], areaH);
  return applyAspect(n, Math.max(0, w), Math.max(0, h));
}

function layoutChildren(parent: UiTreeNode, area: { w: number; h: number }): LaidOut[] {
  const pad = paddingOf(parent.node) ?? [0, 0, 0, 0];
  const ox = pad[3], oy = pad[0];
  const kids = parent.children.filter((c) => resolveUiNode(c.node).visible);
  const layout = parent.node.layout;
  const W = parent.node.type === "ScrollingFrame" ? area.w - pad[1] - pad[3] : area.w;
  const H = parent.node.type === "ScrollingFrame" ? area.h - pad[0] - pad[2] : area.h;

  if (layout?.type === "list") {
    const vertical = layout.dir !== "horizontal";
    const gap = layout.gap ?? 0;
    const items = sorted(kids).map((c) => {
      const [w, h] = baseSize(c.node, W, H);
      const lo = layoutNode(c, 0, 0, w, h);
      return lo;
    });
    // Rows (only horizontal lists wrap).
    const rows: LaidOut[][] = [[]];
    let run = 0;
    for (const it of items) {
      const len = vertical ? it.box.h : it.box.w;
      const limit = vertical ? H : W;
      if (layout.wraps && !vertical && rows.at(-1)!.length && run + gap + len > limit) {
        rows.push([]);
        run = 0;
      }
      run += (rows.at(-1)!.length ? gap : 0) + len;
      rows.at(-1)!.push(it);
    }
    let cross = 0;
    const crossSizes = rows.map((row) => Math.max(0, ...row.map((it) => (vertical ? it.box.w : it.box.h))));
    const totalCross = crossSizes.reduce((a, b) => a + b, 0) + gap * (rows.length - 1);
    rows.forEach((row, ri) => {
      const total = row.reduce((s, it) => s + (vertical ? it.box.h : it.box.w), 0) + gap * Math.max(0, row.length - 1);
      const mainAlign = vertical ? layout.vAlign ?? "top" : layout.hAlign ?? "left";
      const crossAlign = vertical ? layout.hAlign ?? "left" : layout.vAlign ?? "top";
      const space = (vertical ? H : W) - total;
      let pos = mainAlign === "center" ? space / 2 : mainAlign === "bottom" || mainAlign === "right" ? space : 0;
      const rowCross = crossSizes[ri];
      const crossBase = rows.length > 1
        ? (crossAlign === "center" ? ((vertical ? W : H) - totalCross) / 2 : crossAlign === "bottom" || crossAlign === "right" ? (vertical ? W : H) - totalCross : 0) + cross
        : 0;
      for (const it of row) {
        const len = vertical ? it.box.h : it.box.w;
        const size = vertical ? it.box.w : it.box.h;
        const avail = rows.length > 1 ? rowCross : vertical ? W : H;
        const c = crossAlign === "center" ? (avail - size) / 2 : crossAlign === "bottom" || crossAlign === "right" ? avail - size : 0;
        if (vertical) {
          it.box.x = ox + crossBase + c;
          it.box.y = oy + pos;
        } else {
          it.box.x = ox + pos;
          it.box.y = oy + crossBase + c;
        }
        pos += len + gap;
      }
      cross += rowCross + gap;
    });
    return items;
  }

  if (layout?.type === "grid") {
    const cell = layout.cell ?? [0, 100, 0, 100];
    const cw = Math.max(0, udim(cell[0], cell[1], W));
    const ch = Math.max(0, udim(cell[2], cell[3], H));
    const [gx, gy] = layout.cellGap ?? [5, 5];
    const vertical = layout.dir === "vertical";
    const fit = vertical ? Math.floor((H + gy) / (ch + gy)) : Math.floor((W + gx) / (cw + gx));
    const per = Math.max(1, layout.maxCells && layout.maxCells > 0 ? Math.min(layout.maxCells, Math.max(1, fit)) : fit);
    const list = sorted(kids);
    const lines = Math.ceil(list.length / per);
    const cols = vertical ? lines : Math.min(per, list.length);
    const rows = vertical ? Math.min(per, list.length) : lines;
    const blockW = cols * cw + Math.max(0, cols - 1) * gx;
    const blockH = rows * ch + Math.max(0, rows - 1) * gy;
    const hA = layout.hAlign ?? "left";
    const vA = layout.vAlign ?? "top";
    const sx = hA === "center" ? (W - blockW) / 2 : hA === "right" ? W - blockW : 0;
    const sy = vA === "center" ? (H - blockH) / 2 : vA === "bottom" ? H - blockH : 0;
    return list.map((c, i) => {
      const col = vertical ? Math.floor(i / per) : i % per;
      const row = vertical ? i % per : Math.floor(i / per);
      return layoutNode(c, ox + sx + col * (cw + gx), oy + sy + row * (ch + gy), cw, ch);
    });
  }

  return kids.map((c) => {
    const r = resolveUiNode(c.node);
    const [w, h] = baseSize(c.node, W, H);
    const lo = layoutNode(c, 0, 0, w, h);
    // AnchorPoint uses the final (auto-sized) size.
    lo.box.x = ox + udim(r.pos[0], r.pos[1], W) - r.anchor[0] * lo.box.w;
    lo.box.y = oy + udim(r.pos[2], r.pos[3], H) - r.anchor[1] * lo.box.h;
    return lo;
  });
}

export interface ScreenLayout {
  roots: LaidOut[];
  top: number;
  /** UIScale applied by the auto-scale root (1 when not used). */
  scale: number;
  /** Box the roots are laid out in, before scaling (auto-scale root is 1/scale of the screen). */
  root: Box;
}

export function layoutScreen(spec: UiSpec, width: number, height: number, inset: number): ScreenLayout {
  const top = spec.ignoreInset ? 0 : inset;
  const W = width, H = height - top;
  const root: UiTreeNode = { node: { name: "__screen", type: "Frame" }, children: buildUiTree(spec) };
  if (!spec.autoScale) return { roots: layoutChildren(root, { w: W, h: H }), top, scale: 1, root: { x: 0, y: top, w: W, h: H } };
  // Same math as the generated AutoScaleController LocalScript.
  const a = spec.autoScale;
  const scale = Math.min(a.max ?? 1.5, Math.max(a.min ?? 0.35, Math.min(W / a.width, H / a.height)));
  const rw = W / scale, rh = H / scale;
  return { roots: layoutChildren(root, { w: rw, h: rh }), top, scale, root: { x: (W - rw) / 2, y: top + (H - rh) / 2, w: rw, h: rh } };
}
