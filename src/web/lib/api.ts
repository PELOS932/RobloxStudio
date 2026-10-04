import type { ClientEvent, ServerEvent } from "../../shared/protocol.ts";

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json" },
    body: init.body !== undefined ? JSON.stringify(init.body) : init.method && init.method !== "GET" ? "{}" : undefined,
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(typeof data === "object" && data?.error ? data.error : `HTTP ${res.status}`);
  return data as T;
}

type Listener = (e: ServerEvent) => void;

/** WebSocket with automatic reconnect. */
export class Socket {
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;
  onEvent: Listener = () => {};
  onConnection: (up: boolean) => void = () => {};

  connect() {
    // Safe to call twice (React StrictMode runs effects twice in development).
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onConnection(true);
    };
    ws.onmessage = (m) => {
      try {
        this.onEvent(JSON.parse(m.data));
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onConnection(false);
      if (this.closed) return;
      const delay = Math.min(8000, 400 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(e: ClientEvent) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(e));
    else throw new Error("Not connected to the Studio Forge server.");
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

export const socket = new Socket();
