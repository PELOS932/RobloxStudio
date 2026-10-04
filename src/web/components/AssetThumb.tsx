import { useEffect, useMemo, useState } from "react";
import { loadAsset, useStore } from "../store.ts";
import { KindIcon } from "../lib/icons.tsx";
import { modelThumbnail } from "../lib/thumbnails.ts";
import { UiScreen } from "./UiPreview.tsx";
import { highlightLuau } from "./ScriptView.tsx";
import type { AssetKind } from "../../shared/assets.ts";
import type { ModelSpec } from "../../shared/model.ts";
import type { UiSpec } from "../../shared/ui.ts";

/** A small picture of an asset: a still render for models, a scaled live render for UIs, a code minimap for scripts. */
export function AssetThumb({ id, kind, version, width, height }: { id: string; kind: AssetKind; version: number; width: number; height: number }) {
  const asset = useStore((s) => s.assetCache[id]);
  const current = asset && asset.version === version ? asset : undefined;
  useEffect(() => {
    if (!current) void loadAsset(id);
  }, [id, version, current]);

  let body = <KindIcon kind={kind} size={Math.round(Math.min(width, height) * 0.36)} />;
  if (current?.kind === "model") body = <ModelImage key={`${id}:${version}`} cacheKey={`${id}:${version}`} spec={current.spec} />;
  else if (current?.kind === "ui") body = <UiMini spec={current.spec} w={current.html?.width ?? 1280} h={current.html?.height ?? 720} box={[width, height]} />;
  else if (current?.kind === "script") body = <CodeMini source={current.spec.source} />;
  return (
    <span className={`thumb thumb-${kind}`} style={{ width, height }} aria-hidden="true">
      {body}
    </span>
  );
}

function ModelImage({ cacheKey, spec }: { cacheKey: string; spec: ModelSpec }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void modelThumbnail(cacheKey, spec).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [cacheKey, spec]);
  if (url === null) return <span className="thumb-loading" />;
  if (!url) return <KindIcon kind="model" size={18} />;
  return <img src={url} alt="" draggable={false} />;
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
