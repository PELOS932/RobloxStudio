import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { UiScreen } from "./UiPreview.tsx";
import { prepareHtml } from "../lib/html-to-ui.ts";
import type { Asset } from "../../shared/assets.ts";

/**
 * Full-size, chrome-free view of a UI asset: /?render=<id>[&source=html][&w=…&h=…][&bg=scene|dark|checker].
 * Opened from "Open full size"; also used for side-by-side translation checks.
 */
export function RenderOnly({ id }: { id: string }) {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Asset>(`/assets/${id}`).then(setAsset).catch((e) => setError(String(e)));
  }, [id]);
  if (error) return <div style={{ padding: 24 }}>{error}</div>;
  if (!asset) return null;
  if (asset.kind !== "ui") return <div style={{ padding: 24 }}>Full-size view is for UI assets.</div>;
  const q = new URLSearchParams(location.search);
  const w = Number(q.get("w")) || asset.html?.width || asset.spec.autoScale?.width || 1280;
  const h = Number(q.get("h")) || asset.html?.height || asset.spec.autoScale?.height || 720;
  const bg = (q.get("bg") as "scene" | "dark" | "checker") || "scene";
  document.body.style.overflow = "auto";
  if (q.get("source") === "html" && asset.html) {
    return <iframe title="HTML source" sandbox="allow-same-origin" srcDoc={prepareHtml(asset.html.source)} style={{ width: w, height: h, border: 0, display: "block" }} data-forge-screen />;
  }
  return <UiScreen spec={asset.spec} w={w} h={h} bg={bg} />;
}
