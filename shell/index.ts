// App Shell orchestrator: the single place that decides what initializes, when.
//
// Order (protected area only; runs after the server-side session check in the
// _authenticated route guard has already passed):
//   1. register Service Worker (production) so the shell is reused on next launch
//   2. open IndexedDB and hydrate the query cache from the last local snapshot
//   3. bring data current: delta since cached seq, or one full snapshot
//   4. open the authenticated real-time connection and apply deltas live
//   5. persist cache snapshots in the background (debounced)
import type { QueryClient } from "@tanstack/react-query";
import { RealtimeClient, type ConnState } from "@realtime/client";
import { applyEvent, applySnapshot, keys } from "@realtime/store";
import type { Snapshot } from "@realtime/events";
import { getChangesSince, getRealtimeTicket, getSnapshot } from "@/lib/api/sync";
import { idbClear, idbGet, idbSet } from "./idb";

type Shell = { userId: string; rt: RealtimeClient; ready: Promise<void>; unsub: () => void };
let current: Shell | null = null;
const listeners = new Set<(s: ConnState) => void>();
let connState: ConnState = "idle";

export const getConnState = () => connState;
export function onConnState(fn: (s: ConnState) => void) { listeners.add(fn); return () => listeners.delete(fn); }

let swRegistered = false;
function registerServiceWorker() {
  if (swRegistered || !import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  swRegistered = true;
  // Background registration never blocks first paint.
  const go = () => navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  if (document.readyState === "complete") go(); else window.addEventListener("load", go, { once: true });
}

const snapKey = (uid: string) => `snap:${uid}`;
type Cached = Snapshot;

function snapshotFrom(qc: QueryClient, seq: number): Cached | null {
  const projects = qc.getQueryData<Snapshot["projects"]>(keys.projects);
  const tasks = qc.getQueryData<Snapshot["tasks"]>(keys.tasks);
  const profile = qc.getQueryData<Snapshot["profile"]>(keys.profile);
  const state = qc.getQueryData<Snapshot["state"]>(keys.state);
  if (!projects || !tasks || !profile || !state) return null;
  return { seq, projects, tasks, profile, state };
}

/** Starts (or reuses) the authenticated App Shell for this user. Idempotent. */
export function bootShell(qc: QueryClient, userId: string): Promise<void> {
  if (current?.userId === userId) return current.ready;
  if (current) teardownShell(qc, false);
  registerServiceWorker();

  let seq = 0;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const persist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { const s = snapshotFrom(qc, rt.lastSeq); if (s) void idbSet(snapKey(userId), s); }, 800);
  };

  const fullSync = async () => {
    const snap = await getSnapshot();
    applySnapshot(qc, snap);
    persist();
    return snap.seq;
  };

  const rt = new RealtimeClient(0, {
    getTicket: () => getRealtimeTicket(),
    fetchSince: (s) => getChangesSince({ data: { seq: s } }),
    resync: fullSync,
    onEvent: (ev) => applyEvent(qc, ev),
    onSeq: persist,
    onState: (s) => { connState = s; listeners.forEach((l) => l(s)); },
  });

  const ready = (async () => {
    const cached = await idbGet<Cached>(snapKey(userId));
    if (cached) {
      applySnapshot(qc, cached); // instant local open
      seq = cached.seq;
    } else {
      seq = await fullSync();
    }
    rt.setSeq(seq);
    rt.start(); // on open it fetches any deltas since `seq`
  })();

  current = { userId, rt, ready, unsub: () => { if (persistTimer) clearTimeout(persistTimer); } };
  return ready;
}

/** Stops real-time and, on sign-out, wipes local user data. */
export function teardownShell(qc: QueryClient, wipe = true) {
  if (!current) return;
  current.rt.stop();
  current.unsub();
  current = null;
  qc.removeQueries({ queryKey: ["sync"] });
  if (wipe) void idbClear();
}
