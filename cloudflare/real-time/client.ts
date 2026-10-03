// Browser real-time connection manager: authenticated WebSocket to the user's
// relay hub, automatic reconnect with backoff, sequence tracking, gap recovery,
// duplicate/stale filtering. The server remains the source of truth.
import type { SyncEvent } from "./events";

export type ConnState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

type Options = {
  getTicket: () => Promise<{ url: string; token: string }>;
  fetchSince: (seq: number) => Promise<{ events: SyncEvent[]; truncated: boolean }>;
  resync: () => Promise<number>; // full snapshot reload, returns new seq
  onEvent: (ev: SyncEvent) => void;
  onSeq?: (seq: number) => void;
  onState?: (s: ConnState) => void;
};

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private catchingUp: Promise<void> | null = null;
  private buffered: SyncEvent[] = [];
  state: ConnState = "idle";

  constructor(private seq: number, private o: Options) {}

  get lastSeq() { return this.seq; }
  setSeq(s: number) { this.seq = s; }

  start() {
    this.stopped = false;
    window.addEventListener("online", this.wake);
    document.addEventListener("visibilitychange", this.onVisible);
    void this.connect();
  }

  stop() {
    this.stopped = true;
    window.removeEventListener("online", this.wake);
    document.removeEventListener("visibilitychange", this.onVisible);
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close(1000, "stop");
    this.ws = null;
    this.set("closed");
  }

  private set(s: ConnState) { this.state = s; this.o.onState?.(s); }
  private wake = () => { if (!this.ws || this.ws.readyState > 1) { this.attempt = 0; void this.connect(); } };
  private onVisible = () => { if (document.visibilityState === "visible") this.wake(); };

  private async connect() {
    if (this.stopped) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.set(this.attempt ? "reconnecting" : "connecting");
    let ticket: { url: string; token: string };
    try { ticket = await this.o.getTicket(); } catch { return this.retry(); }
    if (this.stopped) return;
    const ws = new WebSocket(`${ticket.url.replace(/^http/, "ws")}/connect?token=${encodeURIComponent(ticket.token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.set("open");
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => { if (ws.readyState === 1) ws.send("ping"); }, 30000);
      void this.catchUp(); // pick up anything missed while disconnected
    };
    ws.onmessage = (m) => {
      if (typeof m.data !== "string" || m.data === "pong") return;
      try {
        const msg = JSON.parse(m.data) as { type: string; events?: SyncEvent[] };
        if (msg.type === "events" && msg.events) for (const ev of msg.events) this.receive(ev);
      } catch { /* ignore malformed frame */ }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (this.ping) clearInterval(this.ping);
      this.ws = null;
      this.retry();
    };
    ws.onerror = () => ws.close();
  }

  private retry() {
    if (this.stopped) return;
    this.set("reconnecting");
    const delay = Math.min(30000, 500 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private receive(ev: SyncEvent) {
    if (this.catchingUp) { this.buffered.push(ev); return; }
    if (ev.seq <= this.seq) return; // duplicate
    if (ev.seq > this.seq + 1) { this.buffered.push(ev); void this.catchUp(); return; } // gap
    this.commit(ev);
  }

  private commit(ev: SyncEvent) {
    this.seq = ev.seq;
    this.o.onEvent(ev);
    this.o.onSeq?.(this.seq);
  }

  private catchUp() {
    if (this.catchingUp) return this.catchingUp;
    this.catchingUp = (async () => {
      try {
        for (;;) {
          const { events, truncated } = await this.o.fetchSince(this.seq);
          if (truncated) { this.seq = await this.o.resync(); this.o.onSeq?.(this.seq); break; }
          for (const ev of events) if (ev.seq > this.seq) this.commit(ev);
          if (events.length === 0) break;
        }
      } catch { /* next reconnect will retry */ }
      this.catchingUp = null;
      const pending = this.buffered.sort((a, b) => a.seq - b.seq);
      this.buffered = [];
      for (const ev of pending) this.receive(ev);
    })();
    return this.catchingUp;
  }
}
