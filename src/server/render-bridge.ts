// Frames for Claude to look at are drawn by an open Studio Forge tab (the preview engine needs
// WebGL), so the server hands the request over and waits for the PNG.

import type { WebSocket } from "ws";
import { shortId } from "./store.ts";
import type { FramesRequest, ServerEvent } from "../shared/protocol.ts";

interface Pending {
  resolve: (png: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class RenderBridge {
  private pending = new Map<string, Pending>();
  /** Browser tabs that can draw frames, with their last activity time. */
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

  get available(): boolean {
    return [...this.lastActive.keys()].some((ws) => ws.readyState === ws.OPEN);
  }

  /** A frame sheet as base64 PNG, from the most recently active tab. */
  frames(request: FramesRequest, timeoutMs = 30_000): Promise<string> {
    const clients = [...this.lastActive.entries()].filter(([ws]) => ws.readyState === ws.OPEN).sort((a, b) => b[1] - a[1]);
    if (!clients.length) return Promise.reject(new Error("Frames are drawn by the Studio Forge page in your browser — open http://localhost:4317 and try again."));
    const id = shortId("fr_");
    const event: ServerEvent = { type: "render.frames", id, request };
    clients[0][0].send(JSON.stringify(event));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The browser did not finish drawing the frames in time."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  settle(id: string, result: { image?: string; error?: string }) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (result.error || !result.image) p.reject(new Error(result.error ?? "Drawing the frames failed."));
    else p.resolve(result.image);
  }
}
