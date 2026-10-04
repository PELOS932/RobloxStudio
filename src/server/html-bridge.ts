// HTML → Roblox translation needs a real browser engine (computed CSS layout), so the
// server hands the HTML to an open Studio Forge tab and waits for the translated spec.

import type { WebSocket } from "ws";
import { shortId } from "./store.ts";
import { sanitizeUiSpec, UiSpecSchema, type UiSpec } from "../shared/ui.ts";
import type { HtmlConvertRequest, ServerEvent } from "../shared/protocol.ts";

interface Pending {
  resolve: (r: { spec: UiSpec; warnings: string[] }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class HtmlBridge {
  private pending = new Map<string, Pending>();
  /** Browser tabs that announced they can translate HTML, with their last activity time. */
  private lastActive = new Map<WebSocket, number>();

  register(ws: WebSocket) {
    this.lastActive.set(ws, Date.now());
  }

  touch(ws: WebSocket) {
    if (this.lastActive.has(ws)) this.lastActive.set(ws, Date.now());
  }

  forget(ws: WebSocket) {
    this.lastActive.delete(ws);
  }

  convert(request: HtmlConvertRequest, timeoutMs = 45_000): Promise<{ spec: UiSpec; warnings: string[] }> {
    const clients = [...this.lastActive.entries()].filter(([ws]) => ws.readyState === ws.OPEN).sort((a, b) => b[1] - a[1]);
    if (!clients.length) {
      return Promise.reject(new Error("HTML is translated by the Studio Forge page in your browser — open http://localhost:4317 and try again."));
    }
    const id = shortId("cv_");
    const event: ServerEvent = { type: "convert.html", id, request };
    clients[0][0].send(JSON.stringify(event));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The browser did not finish translating the HTML in time."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  settle(id: string, result: { spec?: unknown; warnings?: string[]; error?: string }) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (result.error || !result.spec) return p.reject(new Error(result.error ?? "Translation failed."));
    try {
      const { spec, warnings } = sanitizeUiSpec(UiSpecSchema.parse(result.spec));
      p.resolve({ spec, warnings: [...(result.warnings ?? []), ...warnings] });
    } catch (err) {
      p.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
