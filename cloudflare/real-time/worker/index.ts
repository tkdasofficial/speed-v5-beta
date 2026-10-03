// Speed real-time relay: Cloudflare Worker + one Durable Object hub per user.
// Clients connect with a short-lived HMAC token minted by the app server.
// Only the app server (holding REALTIME_SECRET) may publish events.

interface Env {
  HUB: DurableObjectNamespace;
  REALTIME_SECRET: { get(): Promise<string> };
}
type DurableObjectNamespace = { idFromName(n: string): unknown; get(id: unknown): { fetch(r: Request): Promise<Response> } };
type DOState = {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
};

const enc = new TextEncoder();
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function verifyToken(token: string, secret: string): Promise<string | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = b64u(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  if (want.length !== sig.length) return null;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (d !== 0) return null;
  try {
    const p = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as { uid?: string; exp?: number };
    if (!p.uid || !p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p.uid;
  } catch {
    return null;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const SECRET = await env.REALTIME_SECRET.get();
    const url = new URL(req.url);
    if (url.pathname === "/connect") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
      const uid = await verifyToken(url.searchParams.get("token") ?? "", SECRET);
      if (!uid) return new Response("Unauthorized", { status: 401 });
      return env.HUB.get(env.HUB.idFromName(uid)).fetch(new Request("https://hub/connect", req));
    }
    if (url.pathname === "/publish" && req.method === "POST") {
      if (req.headers.get("Authorization") !== `Bearer ${SECRET}`) return new Response("Unauthorized", { status: 401 });
      const body = (await req.json()) as { userId?: string; events?: unknown[] };
      if (!body.userId || !Array.isArray(body.events)) return new Response("Bad request", { status: 400 });
      return env.HUB.get(env.HUB.idFromName(body.userId)).fetch(
        new Request("https://hub/broadcast", { method: "POST", body: JSON.stringify(body.events) }),
      );
    }
    if (url.pathname === "/health") return new Response("ok");
    return new Response("Not found", { status: 404 });
  },
};

export class UserHub {
  constructor(private state: DOState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/connect") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.state.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "hello" }));
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }
    if (url.pathname === "/broadcast") {
      const msg = JSON.stringify({ type: "events", events: await req.json() });
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(msg); } catch { /* socket closing */ }
      }
      return new Response("ok");
    }
    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (msg === "ping") ws.send("pong");
  }

  webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code, "closed"); } catch { /* already closed */ }
  }
}

declare const WebSocketPair: { new (): Record<string, WebSocket> };
