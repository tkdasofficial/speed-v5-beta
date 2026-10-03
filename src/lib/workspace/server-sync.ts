// Connects a WorkspaceStore to the server codebase + background tasks. The server is the source of truth:
// the browser copy is refreshed from it, user edits are sent to it, and agent runs are replayed from task events.
import { onLiveEvent } from "@realtime/store";
import { SandboxPersistence, browserBackend } from "@sandbox/storage/persistence";
import { bgTaskEvents, listBgTasks, sbImport, sbOp, sbTree } from "@/lib/api/tasks";
import type { WorkspaceStore } from "./index";

export function attachServer(store: WorkspaceStore): () => void {
  const pid = store.projectId;
  let revision = -1;
  let disposed = false;
  let pulling: Promise<void> | null = null;
  const seen = new Map<string, number>(); // taskId → last applied seq

  const pull = (): Promise<void> => {
    if (pulling) return pulling.then(() => pull());
    pulling = (async () => {
      const t = await sbTree({ data: { projectId: pid, ...(revision >= 0 ? { since: revision } : {}) } });
      if (disposed || t.unchanged) { revision = t.revision; return; }
      if (revision < 0 && !t.files.length && !t.folders.length) {
        // One-time migration: this device's files become the server copy, then local-only storage is dropped.
        const local = store.sandbox.state.phase === "ready" ? store.sandbox.workspace.files : null;
        if (local && (local.list().length || local.folders().length)) {
          const r = await sbImport({ data: { projectId: pid, files: local.list().map((f) => ({ path: f.path, content: f.content, encoding: f.encoding })), folders: local.folders() } });
          revision = r.revision;
          new SandboxPersistence(browserBackend(), pid).clearAll();
          store.flush();
          return;
        }
      }
      revision = t.revision;
      store.applyServerTree(t.files, t.folders);
    })().catch((e) => { if (!disposed) store.reportRemoteError(`Couldn't load project files: ${e instanceof Error ? e.message : "network error"}`); }).finally(() => { pulling = null; });
    return pulling;
  };

  const replay = async (taskId: string) => {
    const evs = await bgTaskEvents({ data: { id: taskId, since: seen.get(taskId) ?? 0 } });
    for (const e of evs) { store.applyJobEvent(e); seen.set(taskId, Math.max(seen.get(taskId) ?? 0, e.seq)); }
  };
  const recover = async () => {
    const tasks = await listBgTasks({ data: { projectId: pid, limit: 10 } });
    for (const t of tasks.filter((x) => x.type === "ai_agent").reverse()) await replay(t.id).catch(() => undefined);
  };

  store.remote = (op) => {
    void sbOp({ data: { projectId: pid, op } })
      .then((r) => { if (r.changed.length && r.revision === revision + 1) revision = r.revision; else void pull(); })
      .catch((e) => { store.reportRemoteError(`Not saved to your account: ${e instanceof Error ? e.message : "network error"}`); void pull(); });
  };

  const off = onLiveEvent((ev) => {
    if (ev.entity === "filerev" && ev.data?.projectId === pid && ev.data.revision > revision) void pull();
    if (ev.entity === "jobevent" && ev.data?.projectId === pid) {
      const d = ev.data;
      const last = seen.get(d.taskId) ?? 0;
      if (d.seq === last + 1) { store.applyJobEvent(d); seen.set(d.taskId, d.seq); }
      else if (d.seq > last) void replay(d.taskId);
    }
  });
  const online = () => { void pull(); void recover(); };
  window.addEventListener("online", online);
  void pull().then(recover);

  return () => { disposed = true; off(); window.removeEventListener("online", online); store.remote = null; };
}
