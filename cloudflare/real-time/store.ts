// Applies delta events to the TanStack Query cache. Only the affected query key
// changes, so only components reading that entity re-render.
import type { QueryClient } from "@tanstack/react-query";
import type { Message, Profile, Project, Snapshot, StateEntry, SyncEvent, Task } from "./events";

export const keys = {
  projects: ["sync", "projects"] as const,
  tasks: ["sync", "tasks"] as const,
  profile: ["sync", "profile"] as const,
  state: ["sync", "state"] as const,
  messages: (projectId: string) => ["sync", "messages", projectId] as const,
};

function upsertList<T extends { id: string; version: number }>(list: T[] | undefined, ev: { op: string; id: string; version: number; data: T | null }) {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === ev.id);
  if (ev.op === "delete") return i < 0 ? list : list.filter((x) => x.id !== ev.id);
  if (!ev.data) return list;
  if (i < 0) return [...list, ev.data];
  if (list[i]!.version >= ev.version) return list; // stale or duplicate
  const next = list.slice();
  next[i] = ev.data;
  return next;
}

type Listener = (ev: SyncEvent) => void;
const listeners = new Set<Listener>();
/** Subscribe to background-task and file-revision events (not cached in Query; owners keep their own view). */
export function onLiveEvent(fn: Listener) { listeners.add(fn); return () => { listeners.delete(fn); }; }

export function applyEvent(qc: QueryClient, ev: SyncEvent) {
  switch (ev.entity) {
    case "project":
      qc.setQueryData<Project[]>(keys.projects, (l) => upsertList(l, ev));
      if (ev.op === "delete") {
        qc.setQueryData<Task[]>(keys.tasks, (l) => l?.filter((t) => t.projectId !== ev.id));
        qc.removeQueries({ queryKey: keys.messages(ev.id) });
      }
      break;
    case "task":
      qc.setQueryData<Task[]>(keys.tasks, (l) => upsertList(l, ev));
      break;
    case "message": {
      const pid = ev.data?.projectId;
      if (pid) qc.setQueryData<Message[]>(keys.messages(pid), (l) => upsertList(l, ev));
      break;
    }
    case "profile":
      qc.setQueryData<Profile>(keys.profile, (p) => (ev.data && (!p || p.version < ev.version) ? ev.data : p));
      break;
    case "job":
    case "jobevent":
    case "filerev":
      for (const fn of listeners) fn(ev);
      break;
    case "state":
      qc.setQueryData<StateEntry[]>(keys.state, (l) => {
        if (!l) return l;
        const cur = l.find((s) => s.key === ev.id);
        if (cur && cur.version >= ev.version) return l;
        const rest = l.filter((s) => s.key !== ev.id);
        return ev.op === "delete" || !ev.data ? rest : [...rest, ev.data];
      });
      break;
  }
}

export function applySnapshot(qc: QueryClient, s: Snapshot) {
  qc.setQueryData(keys.projects, s.projects);
  qc.setQueryData(keys.tasks, s.tasks);
  qc.setQueryData(keys.profile, s.profile);
  qc.setQueryData(keys.state, s.state);
}
