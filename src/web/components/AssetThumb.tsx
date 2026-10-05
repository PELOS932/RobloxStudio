import { useEffect, useMemo, useRef, useState } from "react";
import { loadAsset, useStore } from "../store.ts";
import { KindIcon } from "../lib/icons.tsx";
import { animationPreview, modelThumbnail, modelTurntable, uploadThumbnail, vfxPreview } from "../lib/thumbnails.ts";
import type { AnimationSpec } from "../../shared/animation.ts";
import type { VfxSpec } from "../../shared/vfx.ts";
import { UiScreen } from "./UiPreview.tsx";
import { highlightLuau } from "./ScriptView.tsx";
import type { AssetKind } from "../../shared/assets.ts";
import type { ModelSpec } from "../../shared/model.ts";
import type { UiSpec } from "../../shared/ui.ts";

/**
 * A small picture of an asset: a still render for models, a scaled live render for UIs, a code
 * minimap for scripts. Model stills are cached on the server (`thumb` = its version), so a large
 * library shows them without loading every model. With `spin`, a model turns around once a second.
 */
export function AssetThumb({ id, kind, version, width, height, thumb, spin = false }: {
  id: string; kind: AssetKind; version: number; width: number | string; height: number | string; thumb?: number; spin?: boolean;
}) {
  const cached = (kind === "model" || kind === "animation" || kind === "vfx") && thumb === version;
  const needSpec = !cached || spin;
  const asset = useStore((s) => s.assetCache[id]);
  const current = asset && asset.version === version ? asset : undefined;
  useEffect(() => {
    if (needSpec && !current) void loadAsset(id);
  }, [id, version, current, needSpec]);

  // Fluid thumbnails (library cards) measure themselves so UI previews scale to fit.
  const ref = useRef<HTMLSpanElement>(null);
  const fluid = typeof width !== "number" || typeof height !== "number";
  const [box, setBox] = useState<[number, number]>([typeof width === "number" ? width : 288, typeof height === "number" ? height : 180]);
  useEffect(() => {
    if (!fluid || !ref.current) return;
    const el = ref.current;
    const ro = new ResizeObserver(() => setBox([el.clientWidth || 288, el.clientHeight || 180]));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fluid]);
  const size = Math.min(box[0], box[1]);
  let body = <KindIcon kind={kind} size={Math.round(size * 0.36)} />;
  const still = cached ? <img src={`/api/assets/${id}/thumb?v=${version}`} alt="" draggable={false} /> : null;
  if (kind === "model") {
    if (spin && current?.kind === "model") body = <ModelSpin key={`${id}:${version}`} cacheKey={`${id}:${version}`} spec={current.spec} still={still} />;
    else if (still) body = still;
    else if (current?.kind === "model") body = <ModelImage key={`${id}:${version}`} id={id} version={version} spec={current.spec} />;
  } else if (kind === "animation") {
    if (spin && current?.kind === "animation") body = <AnimationPlay key={`${id}:${version}`} cacheKey={`${id}:${version}`} spec={current.spec} still={still} />;
    else if (still) body = still;
    else if (current?.kind === "animation") body = <AnimationStill key={`${id}:${version}`} id={id} version={version} spec={current.spec} />;
  } else if (kind === "vfx") {
    if (spin && current?.kind === "vfx") body = <FramesPlay key={`${id}:${version}`} load={() => vfxPreview(`${id}:${version}`, current.spec, 24)} fps={12} still={still} />;
    else if (still) body = still;
    else if (current?.kind === "vfx") body = <VfxStill key={`${id}:${version}`} id={id} version={version} spec={current.spec} />;
  } else if (current?.kind === "ui") {
    body = <UiMini spec={current.spec} w={current.html?.width ?? 1280} h={current.html?.height ?? 720} box={box} />;
  } else if (current?.kind === "script") body = <CodeMini source={current.spec.source} />;
  return (
    <span ref={ref} className={`thumb thumb-${kind}`} style={{ width, height }} aria-hidden="true">
      {body}
    </span>
  );
}

function ModelImage({ id, version, spec }: { id: string; version: number; spec: ModelSpec }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void modelThumbnail(`${id}:${version}`, spec).then((u) => {
      if (!alive) return;
      setUrl(u);
      uploadThumbnail(id, version, u);
    });
    return () => {
      alive = false;
    };
  }, [id, version, spec]);
  if (url === null) return <span className="thumb-loading" />;
  if (!url) return <KindIcon kind="model" size={18} />;
  return <img src={url} alt="" draggable={false} />;
}

/** The model turning around: frames are rendered once, then cycled. */
function ModelSpin({ cacheKey, spec, still }: { cacheKey: string; spec: ModelSpec; still: React.ReactNode }) {
  const [frames, setFrames] = useState<string[] | null>(null);
  const [i, setI] = useState(0);
  useEffect(() => {
    let alive = true;
    void modelTurntable(cacheKey, spec).then((f) => alive && setFrames(f));
    return () => {
      alive = false;
    };
  }, [cacheKey, spec]);
  useEffect(() => {
    if (!frames?.length) return;
    const t = setInterval(() => setI((n) => (n + 1) % frames.length), 70);
    return () => clearInterval(t);
  }, [frames]);
  if (!frames?.length) return <>{still ?? <span className="thumb-loading" />}</>;
  return <img src={frames[i % frames.length]} alt="" draggable={false} />;
}

function AnimationStill({ id, version, spec }: { id: string; version: number; spec: AnimationSpec }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void animationPreview(`${id}:${version}`, spec, 1).then(([u = ""]) => {
      if (!alive) return;
      setUrl(u);
      uploadThumbnail(id, version, u);
    });
    return () => {
      alive = false;
    };
  }, [id, version, spec]);
  if (url === null) return <span className="thumb-loading" />;
  if (!url) return <KindIcon kind="animation" size={18} />;
  return <img src={url} alt="" draggable={false} />;
}

/** The animation playing (on hover in the library). */
function AnimationPlay({ cacheKey, spec, still }: { cacheKey: string; spec: AnimationSpec; still: React.ReactNode }) {
  const [frames, setFrames] = useState<string[] | null>(null);
  const [i, setI] = useState(0);
  const length = spec.keyframes[spec.keyframes.length - 1]?.t || 1;
  const count = Math.max(8, Math.min(40, Math.round(length * 20)));
  useEffect(() => {
    let alive = true;
    void animationPreview(cacheKey, spec, count).then((f) => alive && setFrames(f));
    return () => {
      alive = false;
    };
  }, [cacheKey, spec, count]);
  useEffect(() => {
    if (!frames?.length) return;
    const t = setInterval(() => setI((n) => (n + 1) % frames.length), (length * 1000) / frames.length);
    return () => clearInterval(t);
  }, [frames, length]);
  if (!frames?.length) return <>{still ?? <span className="thumb-loading" />}</>;
  return <img src={frames[i % frames.length]} alt="" draggable={false} />;
}

function VfxStill({ id, version, spec }: { id: string; version: number; spec: VfxSpec }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void vfxPreview(`${id}:${version}`, spec, 1).then(([u = ""]) => {
      if (!alive) return;
      setUrl(u);
      uploadThumbnail(id, version, u);
    });
    return () => {
      alive = false;
    };
  }, [id, version, spec]);
  if (url === null) return <span className="thumb-loading" />;
  if (!url) return <KindIcon kind="vfx" size={18} />;
  return <img src={url} alt="" draggable={false} />;
}

/** Pre-rendered frames played in a loop (hover previews). */
function FramesPlay({ load, fps, still }: { load: () => Promise<string[]>; fps: number; still: React.ReactNode }) {
  const [frames, setFrames] = useState<string[] | null>(null);
  const [i, setI] = useState(0);
  useEffect(() => {
    let alive = true;
    void load().then((f) => alive && setFrames(f));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!frames?.length) return;
    const t = setInterval(() => setI((n) => (n + 1) % frames.length), 1000 / fps);
    return () => clearInterval(t);
  }, [frames, fps]);
  if (!frames?.length) return <>{still ?? <span className="thumb-loading" />}</>;
  return <img src={frames[i % frames.length]} alt="" draggable={false} />;
}

function UiMini({ spec, w, h, box }: { spec: UiSpec; w: number; h: number; box: [number, number] }) {
  const scale = Math.min(box[0] / w, box[1] / h);
  return (
    <span className="thumb-ui" style={{ width: w * scale, height: h * scale }}>
      <span style={{ width: w, height: h, transform: `scale(${scale})` }}>
        <UiScreen spec={spec} w={w} h={h} bg="dark" />
      </span>
    </span>
  );
}

function CodeMini({ source }: { source: string }) {
  const lines = useMemo(() => highlightLuau(source.split("\n").slice(0, 14).join("\n")), [source]);
  return (
    <span className="thumb-code">
      {lines.map((l, i) => (
        <span key={i}>{l.length ? l : " "}</span>
      ))}
    </span>
  );
}
