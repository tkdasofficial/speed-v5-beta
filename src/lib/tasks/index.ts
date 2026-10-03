// Global frontend task store: a cache/view of server background tasks (never the source of truth).
// Rebuilt from the API on load and kept current by live events.
import { useEffect, useSyncExternalStore } from "react";
import type { Job } from "@realtime/events";
import { onLiveEvent } from "@realtime/store";
import { listBgTasks } from "@/lib/api/tasks";

let jobs = new Map<string, Job>();
let snapshot: Job[] = [];
const subs = new Set<() => void>();
let started = false;

function set(j: Job) {
  const cur = jobs.get(j.id);
  if (cur && cur.version > j.version) return;
  jobs = new Map(jobs).set(j.id, j);
  snapshot = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  subs.forEach((f) => f());
}

export function startTaskStore() {
  if (started || typeof window === "undefined") return;
  started = true;
  onLiveEvent((ev) => { if (ev.entity === "job" && ev.data) set(ev.data); });
  const load = () => listBgTasks({ data: { limit: 30 } }).then((l) => l.forEach(set)).catch(() => undefined);
  void load();
  window.addEventListener("online", load);
}

/** Adds a task the app just created (server response) so its state shows before the first live event. */
export const trackJob = (j: Job) => set(j);

export const isActive = (j: Job) => j.status === "queued" || j.status === "running" || j.status === "retrying";

export function useTasks(): Job[] {
  useEffect(() => { startTaskStore(); }, []);
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => snapshot, () => snapshot);
}
