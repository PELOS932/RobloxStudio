import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { Icon } from "../lib/icons.tsx";
import { convertHtmlToUi, prepareHtml } from "../lib/html-to-ui.ts";
import { openAsset, toast, useStore } from "../store.ts";
import type { Asset } from "../../shared/assets.ts";

export const DESIGN_SIZES = [
  { label: "1280 × 720 (16:9, recommended)", w: 1280, h: 720 },
  { label: "1920 × 1080 (Full HD)", w: 1920, h: 1080 },
  { label: "1366 × 768 (laptop)", w: 1366, h: 768 },
  { label: "844 × 390 (phone landscape)", w: 844, h: 390 },
  { label: "390 × 844 (phone portrait)", w: 390, h: 844 },
];

const SAMPLE = `<!-- Paste any HTML/CSS UI. Scripts are ignored; the page is rendered and translated element by element. -->
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  body { font-family: Inter, sans-serif; background: #4b7d4a; }
  .toast { position: absolute; top: 24px; left: 50%; transform: translateX(-50%); padding: 14px 22px;
           border-radius: 14px; background: rgba(15, 17, 26, .9); color: #fff; border: 1px solid #ffffff22;
           box-shadow: 0 10px 30px rgba(0,0,0,.35); font-weight: 600; }
  .toast b { color: #ffd166; }
</style>
<div class="toast" id="RewardToast">You found <b>250 coins</b>!</div>`;

/** Paste or upload HTML and translate it into a Roblox UI asset. */
export function HtmlImportDialog() {
  const open = useStore((s) => s.htmlImportOpen);
  const [html, setHtml] = useState(SAMPLE);
  const [name, setName] = useState("HtmlUI");
  const [size, setSize] = useState(0);
  const [autoScale, setAutoScale] = useState(true);
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const close = () => useStore.setState({ htmlImportOpen: false });

  useEffect(() => {
    if (!open) return;
    setWarnings([]);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const translate = async () => {
    setBusy(true);
    setWarnings([]);
    try {
      const d = DESIGN_SIZES[size];
      const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
      const finalName = (name.trim() || title || "HtmlUI").replace(/[^\w ]+/g, "").slice(0, 60) || "HtmlUI";
      const r = await convertHtmlToUi(html, { name: finalName, width: d.w, height: d.h, autoScale });
      const asset = await api<Asset>("/assets", { body: { kind: "ui", spec: r.spec, html: { source: html, width: d.w, height: d.h, autoScale } } });
      // The page-background note is expected for most pages; only keep the dialog open for real issues.
      const important = r.warnings.filter((w) => !w.startsWith("The page background"));
      if (important.length) {
        setWarnings(important);
        toast(`Translated with ${important.length} note${important.length > 1 ? "s" : ""}`, "info");
      } else {
        toast(`Translated ${r.spec.nodes.length} elements`, "success");
        close();
      }
      openAsset(asset.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <Icon name="code" />
          <h2>Translate HTML to a Roblox UI</h2>
          <button className="icon-btn" onClick={close} title="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>HTML</label>
            <textarea className="console-input" style={{ minHeight: 240 }} spellCheck={false} value={html} onChange={(e) => setHtml(e.target.value)} />
            <div className="row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label className="btn small" style={{ cursor: "pointer" }}>
                <Icon name="upload" size={13} /> Open .html file
                <input type="file" accept=".html,.htm,text/html" hidden onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setHtml(await f.text());
                  setName(f.name.replace(/\.html?$/i, "").replace(/[^\w ]+/g, "") || "HtmlUI");
                }} />
              </label>
              <span className="hint muted">The page background isn't exported — the game shows behind the UI.</span>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field">
              <label>ScreenGui name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label>Design size</label>
              <select className="select" value={size} onChange={(e) => setSize(Number(e.target.value))}>
                {DESIGN_SIZES.map((d, i) => (
                  <option key={d.label} value={i}>{d.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="toggle-row">
            <div className="text">
              <b>Scale with the screen</b>
              <span>Adds a UIScale + tiny LocalScript so the layout keeps its proportions on phones, tablets and 4K screens.</span>
            </div>
            <button className={`switch ${autoScale ? "on" : ""}`} role="switch" aria-checked={autoScale} aria-label="Scale with the screen" onClick={() => setAutoScale((v) => !v)} />
          </div>
          {warnings.length > 0 && (
            <div className="card">
              <h3>Translation notes</h3>
              <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-dim)", fontSize: 13, display: "grid", gap: 4 }}>
                {warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={close}>{warnings.length ? "Done" : "Cancel"}</button>
          <button className="btn primary" disabled={busy || !html.trim()} onClick={() => void translate()}>
            <Icon name={busy ? "refresh" : "zap"} /> {busy ? "Translating…" : "Translate"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The original HTML rendered at its design size (scripts disabled), scaled to fit. */
export function HtmlSourceView({ asset }: { asset: Extract<Asset, { kind: "ui" }> }) {
  const html = asset.html!;
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min((el.clientWidth - 48) / html.width, (el.clientHeight - 84) / html.height, 1.5));
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, [html.width, html.height]);
  return (
    <div className="ui-stage" ref={stageRef}>
      <div className="ui-toolbar">
        <span className="seg"><button className="active">{html.width} × {html.height} · original HTML</button></span>
      </div>
      <div style={{ width: html.width * scale, height: html.height * scale, marginTop: 30 }}>
        <iframe
          title="HTML source"
          sandbox="allow-same-origin"
          srcDoc={prepareHtml(html.source)}
          className="ui-screen"
          style={{ width: html.width, height: html.height, border: 0, transform: `scale(${scale})`, transformOrigin: "top left", background: "#fff" }}
        />
      </div>
    </div>
  );
}

/** Re-run the translator on the stored HTML (e.g. after changing the design size). */
export async function retranslate(asset: Extract<Asset, { kind: "ui" }>) {
  const h = asset.html!;
  const r = await convertHtmlToUi(h.source, { name: asset.spec.name, width: h.width, height: h.height, autoScale: h.autoScale });
  await api("/assets", { body: { kind: "ui", spec: r.spec, html: h, replaceId: asset.id } });
  toast(`Re-translated: ${r.spec.nodes.length} elements${r.warnings.length ? ` · ${r.warnings.length} notes` : ""}`, "success");
}
