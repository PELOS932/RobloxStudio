import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cornerOf, gradientStops, type UiSpec } from "../../shared/ui.ts";
import { FONTS, TOPBAR_INSET } from "../../shared/roblox-data.ts";
import { hexToRgb } from "../../shared/math.ts";
import { fontCss, layoutScreen, LINE_HEIGHT, type LaidOut } from "../lib/ui-layout.ts";
import { Icon } from "../lib/icons.tsx";

const DEVICES = {
  desktop: { label: "Desktop", w: 1920, h: 1080 },
  laptop: { label: "Laptop", w: 1366, h: 768 },
  tablet: { label: "Tablet", w: 1024, h: 768 },
  phone: { label: "Phone", w: 844, h: 390 },
  portrait: { label: "Portrait", w: 390, h: 844 },
} as const;
type DeviceKey = keyof typeof DEVICES;

// Weights to request per Google font family (single-weight families get none).
const FONT_WEIGHTS: Record<string, string> = {
  Inter: "400;500;600;700;800;900",
  Montserrat: "400;500;600;700;800;900",
  "Source Sans 3": "300;400;600;700",
  Roboto: "400;500;700",
  "Roboto Condensed": "400;700",
  "Roboto Mono": "400;700",
  Ubuntu: "400;500;700",
  Nunito: "400;600;700;800",
  Oswald: "400;500;700",
  Merriweather: "400;700;900",
  Arimo: "400;700",
  "Josefin Sans": "400;600;700",
  "Titillium Web": "400;600;700",
  Fredoka: "400;500;600;700",
};
const requestedFonts = new Set<string>();

function useWebFonts(spec: UiSpec, onLoaded: () => void) {
  useEffect(() => {
    const families = new Set(spec.nodes.map((n) => FONTS[n.font ?? "GothamMedium"]?.web).filter(Boolean) as string[]);
    let added = false;
    for (const fam of families) {
      if (requestedFonts.has(fam)) continue;
      requestedFonts.add(fam);
      const w = FONT_WEIGHTS[fam];
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, "+")}${w ? `:wght@${w}` : ""}&display=swap`;
      document.head.appendChild(link);
      added = true;
    }
    let cancelled = false;
    const done = () => !cancelled && onLoaded();
    if (added) setTimeout(() => document.fonts.ready.then(done), 300);
    document.fonts.ready.then(done);
    return () => {
      cancelled = true;
    };
  }, [spec]); // eslint-disable-line react-hooks/exhaustive-deps
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

function assetUrl(image?: string): string | null {
  if (!image) return null;
  const m = image.match(/(?:rbxassetid:\/\/|[?&]id=)(\d+)/i);
  if (m) return `/api/thumb/${m[1]}`;
  if (/^https?:\/\//.test(image)) return image;
  return null;
}

const imageStatus = new Map<string, { state: "loading" | "ok" | "error"; w: number; h: number; listeners: Set<() => void> }>();
function useImage(url: string | null) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!url) return;
    let entry = imageStatus.get(url);
    if (!entry) {
      entry = { state: "loading", w: 0, h: 0, listeners: new Set() };
      imageStatus.set(url, entry);
      const img = new Image();
      const e = entry;
      img.onload = () => {
        e.state = "ok";
        e.w = img.naturalWidth;
        e.h = img.naturalHeight;
        e.listeners.forEach((l) => l());
      };
      img.onerror = () => {
        e.state = "error";
        e.listeners.forEach((l) => l());
      };
      img.src = url;
    }
    const l = () => force((n) => n + 1);
    entry.listeners.add(l);
    return () => void entry!.listeners.delete(l);
  }, [url]);
  return url ? imageStatus.get(url) ?? null : null;
}

// --------------------------------------------------------------- rich text

function renderRich(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const stack: CSSProperties[] = [{}];
  const re = /<(\/?)(\w+)([^>]*)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  let key = 0;
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  while ((m = re.exec(text))) {
    if (m[4] !== undefined || m[5] !== undefined) {
      const style = Object.assign({}, ...stack);
      out.push(<span key={key++} style={style}>{decode(m[4] ?? m[5])}</span>);
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3];
    if (tag === "br") {
      out.push(<br key={key++} />);
      continue;
    }
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const s: CSSProperties = {};
    if (tag === "b") s.fontWeight = 700;
    else if (tag === "i") s.fontStyle = "italic";
    else if (tag === "u") s.textDecoration = "underline";
    else if (tag === "s") s.textDecoration = "line-through";
    else if (tag === "uppercase" || tag === "uc") s.textTransform = "uppercase";
    else if (tag === "smallcaps" || tag === "sc") s.fontVariant = "small-caps";
    else if (tag === "font") {
      const color = attrs.match(/color\s*=\s*["']([^"']+)["']/i)?.[1];
      const size = attrs.match(/size\s*=\s*["'](\d+)["']/i)?.[1];
      const weight = attrs.match(/weight\s*=\s*["'](\w+)["']/i)?.[1];
      const transparency = attrs.match(/transparency\s*=\s*["']([\d.]+)["']/i)?.[1];
      if (color) s.color = color.startsWith("rgb(") ? color : color;
      if (size) s.fontSize = `${size}px`;
      if (weight) s.fontWeight = /^\d+$/.test(weight) ? Number(weight) : weight === "bold" ? 700 : weight === "heavy" ? 900 : weight === "light" ? 300 : 400;
      if (transparency) s.opacity = 1 - Number(transparency);
    } else if (tag === "stroke") {
      const color = attrs.match(/color\s*=\s*["']([^"']+)["']/i)?.[1] ?? "#000";
      s.textShadow = `1px 0 ${color}, -1px 0 ${color}, 0 1px ${color}, 0 -1px ${color}`;
    }
    stack.push(s);
  }
  return out;
}

// --------------------------------------------------------------- node view

interface ViewProps {
  lo: LaidOut;
  hover: string | null;
  selected: string | null;
  setHover: (n: string | null) => void;
  setSelected: (n: string | null) => void;
}

function gradientCss(lo: LaidOut, base: string, baseAlpha: number): string | null {
  const g = lo.node.gradient;
  if (!g) return null;
  // UIGradient multiplies the node's own color.
  const [br, bg, bb] = hexToRgb(base);
  const stops = gradientStops(g).map((st) => {
    const [r, gg, b] = hexToRgb(st.color);
    const alpha = baseAlpha * (1 - st.transparency);
    return `rgba(${Math.round((r * br) / 255)}, ${Math.round((gg * bg) / 255)}, ${Math.round((b * bb) / 255)}, ${alpha}) ${+(st.t * 100).toFixed(2)}%`;
  });
  return `linear-gradient(${90 + (g.rotation ?? 0)}deg, ${stops.join(", ")})`;
}

function ImageFill({ lo }: { lo: LaidOut }) {
  const n = lo.node;
  const url = assetUrl(n.image);
  const status = useImage(url);
  const tint = n.imageColor ?? "#ffffff";
  const alpha = 1 - (n.imageT ?? 0);
  const base: CSSProperties = { position: "absolute", inset: 0, opacity: alpha, pointerEvents: "none" };
  if (!url || !status || status.state !== "ok") {
    return (
      <div style={{ ...base, display: "grid", placeItems: "center", background: `repeating-conic-gradient(${rgba(tint, 0.18)} 0% 25%, ${rgba(tint, 0.08)} 0% 50%) 50% / 16px 16px`, borderRadius: "inherit", color: rgba(tint, 0.7) }}>
        {lo.box.w > 30 && lo.box.h > 30 && <Icon name="image" size={Math.min(28, lo.box.w / 3, lo.box.h / 3)} />}
      </div>
    );
  }
  const scale = n.scaleType ?? "Stretch";
  if (scale === "Slice" && n.slice) {
    const [x0, y0, x1, y1] = n.slice;
    const [t, r, b, l] = [y0, status.w - x1, status.h - y1, x0].map((v) => Math.max(0, v));
    return <div style={{ ...base, borderStyle: "solid", borderWidth: `${t}px ${r}px ${b}px ${l}px`, borderImage: `url(${url}) ${t} ${r} ${b} ${l} fill / ${t}px ${r}px ${b}px ${l}px stretch` }} />;
  }
  const size = scale === "Fit" ? "contain" : scale === "Crop" ? "cover" : scale === "Tile" ? "auto" : "100% 100%";
  const repeat = scale === "Tile" ? "repeat" : "no-repeat";
  const tinted = tint.toLowerCase() !== "#ffffff";
  return (
    <div
      style={{
        ...base,
        backgroundImage: `url(${url})`,
        backgroundSize: size,
        backgroundRepeat: repeat,
        backgroundPosition: "center",
        ...(tinted
          ? {
              backgroundColor: tint,
              backgroundBlendMode: "multiply",
              maskImage: `url(${url})`,
              WebkitMaskImage: `url(${url})`,
              maskSize: size,
              WebkitMaskSize: size,
              maskRepeat: repeat,
              WebkitMaskRepeat: repeat,
              maskPosition: "center",
              WebkitMaskPosition: "center",
            }
          : {}),
      }}
    />
  );
}

function NodeView({ lo, hover, selected, setHover, setSelected }: ViewProps) {
  const { r, node, box } = lo;
  const minSide = Math.min(box.w, box.h);
  const corner = cornerOf(node);
  const radius = corner ? Math.min(corner[0] * minSide + corner[1], minSide / 2) : 0;
  const bgAlpha = 1 - r.bgT;
  const gradient = gradientCss(lo, r.bg, bgAlpha);
  const textGradient = gradient && bgAlpha === 0 && r.isText ? gradientCss(lo, r.textColor, 1 - r.textT) : null;

  const style: CSSProperties = {
    position: "absolute",
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
    zIndex: r.z,
    borderRadius: radius,
    transform: r.rotation ? `rotate(${r.rotation}deg)` : undefined,
    background: gradient && bgAlpha > 0 ? gradient : bgAlpha > 0 ? rgba(r.bg, bgAlpha) : undefined,
    overflow: r.type === "ScrollingFrame" ? "auto" : r.clip ? "hidden" : "visible",
  };
  if (node.stroke) {
    const s = node.stroke;
    style.boxShadow = `0 0 0 ${s.thickness ?? 1}px ${rgba(s.color ?? "#000000", 1 - (s.transparency ?? 0))}`;
  }
  const classes = [
    r.type === "TextButton" || r.type === "ImageButton" ? "ui-btn" : "",
    hover === node.name ? "ui-node-hover" : "",
    selected === node.name ? "ui-node-selected" : "",
    r.type === "ScrollingFrame" ? "ui-scroll" : "",
  ].join(" ");
  if (r.type === "ScrollingFrame") {
    (style as Record<string, unknown>)["--sb"] = `${node.scrollBar ?? 6}px`;
    (style as Record<string, unknown>)["--sbc"] = node.scrollColor ?? "#ffffff";
  }

  let text: ReactNode = null;
  if (r.isText) {
    const showPlaceholder = r.type === "TextBox" && !r.text && node.placeholder;
    const content = showPlaceholder ? node.placeholder! : r.text;
    const color = showPlaceholder ? rgba(node.placeholderColor ?? "#b2b2b2", 1 - r.textT) : rgba(r.textColor, 1 - r.textT);
    const align = r.xAlign === "left" ? "flex-start" : r.xAlign === "right" ? "flex-end" : "center";
    const stroke = node.textStroke && (node.textStroke.transparency ?? 0) < 1
      ? (() => {
          const c = rgba(node.textStroke!.color ?? "#000000", 1 - (node.textStroke!.transparency ?? 0));
          return `1px 0 ${c}, -1px 0 ${c}, 0 1px ${c}, 0 -1px ${c}, 1px 1px ${c}, -1px -1px ${c}`;
        })()
      : undefined;
    const wrap = r.textWrapped || r.textScaled;
    text = (
      <div
        style={{
          position: "absolute",
          left: lo.content.x,
          top: lo.content.y,
          width: lo.content.w,
          height: lo.content.h,
          display: "flex",
          flexDirection: "column",
          justifyContent: r.yAlign === "top" ? "flex-start" : r.yAlign === "bottom" ? "flex-end" : "center",
          alignItems: align,
          pointerEvents: "none",
        }}
      >
        <span
          style={{
            font: fontCss(r, lo.fontSize),
            lineHeight: LINE_HEIGHT,
            color: textGradient ? "transparent" : color,
            background: textGradient ?? undefined,
            WebkitBackgroundClip: textGradient ? "text" : undefined,
            backgroundClip: textGradient ? "text" : undefined,
            textAlign: r.xAlign,
            whiteSpace: node.truncate ? "nowrap" : wrap ? "pre-wrap" : "pre",
            overflowWrap: wrap ? "break-word" : undefined,
            overflow: node.truncate ? "hidden" : undefined,
            textOverflow: node.truncate ? "ellipsis" : undefined,
            width: wrap || node.truncate ? "100%" : "max-content",
            textShadow: stroke,
          }}
        >
          {r.rich && !showPlaceholder ? renderRich(content) : content}
        </span>
      </div>
    );
  }

  const children = lo.children.map((c, i) => (
    <NodeView key={`${c.node.name}-${i}`} lo={c} hover={hover} selected={selected} setHover={setHover} setSelected={setSelected} />
  ));

  return (
    <div
      className={classes}
      style={style}
      onMouseOver={(e) => {
        e.stopPropagation();
        setHover(node.name);
      }}
      onClick={(e) => {
        e.stopPropagation();
        setSelected(node.name);
      }}
    >
      {r.isImage && <ImageFill lo={lo} />}
      {text}
      {lo.canvas ? <div style={{ position: "relative", width: lo.canvas.w, height: lo.canvas.h }}>{children}</div> : children}
    </div>
  );
}

function findNode(list: LaidOut[], name: string): LaidOut | null {
  for (const l of list) {
    if (l.node.name === name) return l;
    const f = findNode(l.children, name);
    if (f) return f;
  }
  return null;
}

// --------------------------------------------------------------- component

type Device = { key: string; label: string; w: number; h: number };
type Bg = "scene" | "dark" | "checker";

function devicesFor(spec: UiSpec): Device[] {
  const list: Device[] = (Object.keys(DEVICES) as DeviceKey[]).map((k) => ({ key: k, ...DEVICES[k] }));
  if (spec.autoScale) list.unshift({ key: "design", label: "Design", w: spec.autoScale.width, h: spec.autoScale.height });
  return list;
}

/** The Roblox screen itself (top bar + GUI), unscaled. */
export function UiScreen({ spec, w, h, bg, hover = null, selected = null, setHover = () => {}, setSelected = () => {} }: {
  spec: UiSpec;
  w: number;
  h: number;
  bg: Bg;
  hover?: string | null;
  selected?: string | null;
  setHover?: (n: string | null) => void;
  setSelected?: (n: string | null) => void;
}) {
  const [fontTick, setFontTick] = useState(0);
  useWebFonts(spec, () => setFontTick((t) => t + 1));
  const layout = useMemo(() => layoutScreen(spec, w, h, TOPBAR_INSET), [spec, w, h, fontTick]);
  return (
    <div className={`ui-screen bg-${bg}`} style={{ width: w, height: h }} data-forge-screen>
      {!spec.ignoreInset && (
        <div className="ui-topbar" style={{ height: TOPBAR_INSET }}>
          <span />
          <span />
        </div>
      )}
      <div
        style={{
          position: "absolute",
          left: layout.root.x,
          top: layout.root.y,
          width: layout.root.w,
          height: layout.root.h,
          transform: layout.scale !== 1 ? `scale(${layout.scale})` : undefined,
          transformOrigin: "center center",
        }}
      >
        {layout.roots.map((lo, i) => (
          <NodeView key={`${lo.node.name}-${i}`} lo={lo} hover={hover} selected={selected} setHover={setHover} setSelected={setSelected} />
        ))}
      </div>
    </div>
  );
}

export function UiPreview({ spec, onReference }: { spec: UiSpec; onReference?: (name: string) => void }) {
  const devices = useMemo(() => devicesFor(spec), [spec]);
  const [deviceKey, setDeviceKey] = useState<string>(() => (spec.autoScale ? "design" : localStorageGet("forge.device") || "laptop"));
  const [bg, setBg] = useState<Bg>("scene");
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dev = devices.find((d) => d.key === deviceKey) ?? devices.find((d) => d.key === "laptop")!;

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const pad = 24;
      const top = 54;
      setScale(Math.min((el.clientWidth - pad * 2) / dev.w, (el.clientHeight - top - pad) / dev.h, 1.5));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, [dev.w, dev.h]);

  useEffect(() => setSelected(null), [spec.name]);
  const layout = useMemo(() => layoutScreen(spec, dev.w, dev.h, TOPBAR_INSET), [spec, dev.w, dev.h]);
  const sel = selected ? findNode(layout.roots, selected) : null;

  return (
    <div className="ui-stage" ref={stageRef} onMouseLeave={() => setHover(null)} onClick={() => setSelected(null)}>
      <div className="ui-toolbar">
        <div className="seg">
          {devices.map((d) => (
            <button
              key={d.key}
              className={dev.key === d.key ? "active" : ""}
              onClick={(e) => {
                e.stopPropagation();
                setDeviceKey(d.key);
                if (d.key !== "design") localStorageSet("forge.device", d.key);
              }}
              title={`${d.w}×${d.h}`}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="seg">
          {(["scene", "dark", "checker"] as const).map((b) => (
            <button key={b} className={bg === b ? "active" : ""} onClick={(e) => (e.stopPropagation(), setBg(b))}>
              {b === "scene" ? "Game" : b === "dark" ? "Dark" : "Grid"}
            </button>
          ))}
        </div>
      </div>
      <div style={{ width: dev.w * scale, height: dev.h * scale, marginTop: 30 }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: dev.w, height: dev.h }}>
          <UiScreen spec={spec} w={dev.w} h={dev.h} bg={bg} hover={hover} selected={selected} setHover={setHover} setSelected={setSelected} />
        </div>
      </div>
      {sel && (
        <div className="ui-inspect" onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <b>{sel.node.name}</b>
            <span className="badge">{sel.node.type}</span>
          </div>
          <div className="muted">
            {Math.round(sel.box.w)} × {Math.round(sel.box.h)} px at {dev.label.toLowerCase()} size
          </div>
          {onReference && (
            <button className="btn small" onClick={() => onReference(sel.node.name)}>
              <Icon name="message" size={13} /> Ask Claude to change it
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    // ignore (private mode)
  }
}
