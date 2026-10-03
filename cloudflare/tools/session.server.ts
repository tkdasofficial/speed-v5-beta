// Production bindings: D1 audit log (tool_operations) + the existing revisioned project file store.
import { d1 } from "@backend/d1";
import { scrub } from "./guard";
import { loadTools, ToolSession } from "./index";
import type { OperationStore, ProjectIO } from "./orchestrator";

export const d1Operations: OperationStore = {
  async start(o) {
    await d1("INSERT INTO tool_operations (id, parent_id, user_id, project_id, task_id, tool_name, args, revision_before) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [o.id, o.parentId, o.userId, o.projectId, o.taskId, o.toolName, JSON.stringify(scrub(o.args)).slice(0, 20_000), o.revisionBefore]);
  },
  async finish(id, r, revisionAfter) {
    await d1("UPDATE tool_operations SET status = ?, result = ?, error_code = ?, error_message = ?, attempts = ?, duration_ms = ?, revision_after = ?, completed_at = datetime('now') WHERE id = ?",
      [r.success ? "completed" : r.error?.code === "CANCELLED" ? "cancelled" : "failed", JSON.stringify(scrub(r.data)).slice(0, 40_000), r.error?.code ?? null, r.error?.message?.slice(0, 2000) ?? null, r.metadata.attempts ?? 0, r.metadata.durationMs ?? 0, revisionAfter, id]);
  },
  async cancelRequested(id) {
    const [r] = await d1<{ c: number }>("SELECT cancel_requested AS c FROM tool_operations WHERE id = ?", [id]);
    return !!r?.c;
  },
};

export const sandboxIO: ProjectIO = {
  async load(projectId) { const { loadStore } = await import("../sandbox/fs.server"); const l = await loadStore(projectId); return { store: l.store, revision: l.revision }; },
  snapshot(store) { return { files: new Map(store.list().map((f) => [f.path, { ...f }])), folders: new Set(store.folders()) }; },
  async commit(projectId, base, before, store, meta) {
    const { commit, ConflictError } = await import("../sandbox/fs.server");
    const { ToolFailure } = await import("./types");
    try { return await commit(projectId, base, before as never, store, meta); }
    catch (e) { if (e instanceof ConflictError) throw new ToolFailure("CONFLICT", "The project changed meanwhile — re-read and retry", true); throw e; }
  },
  async revision(projectId) { const { getRevision } = await import("../sandbox/fs.server"); return getRevision(projectId); },
  async settings(projectId) { const [r] = await d1<{ settings: string }>("SELECT settings FROM projects WHERE id = ?", [projectId]); return JSON.parse(r?.settings || "{}"); },
  async patchSettings(userId, projectId, p) { const { patchProjectSettings } = await import("@backend/projects.server"); await patchProjectSettings(userId, projectId, p); },
};

/** Opens a session for an already-authorized owner (callers must run assertOwnsProject first). */
export function openToolSession(o: { userId: string; projectId: string; taskId?: string | null; readOnly?: boolean; confirmed?: boolean; signal?: AbortSignal }) {
  loadTools();
  return new ToolSession({ ...o, ops: d1Operations, io: sandboxIO });
}
