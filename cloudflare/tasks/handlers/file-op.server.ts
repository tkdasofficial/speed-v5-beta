// file_operation tasks: rollback to a revision, or a batch of file ops, committed server-side.
import type { TaskHandler } from "../registry";
import { FatalError } from "../registry";

export const fileOpHandler: TaskHandler = {
  maxRetries: 2,
  async step(c) {
    const projectId = c.task.project_id;
    if (!projectId) throw new FatalError("A project is required");
    const fs = await import("../../sandbox/fs.server");
    await fs.ensureProject(c.task.user_id, projectId);
    const p = c.payload as { op?: string; revision?: number; ops?: import("../../sandbox/fs.server").FileOp[] };
    let r: { revision: number; changed: string[] };
    if (p.op === "rollback" && typeof p.revision === "number") {
      await c.progress(0.3, `Restoring revision ${p.revision}`);
      r = await fs.rollbackTo(projectId, p.revision, { taskId: c.task.id });
    } else if (Array.isArray(p.ops)) {
      const all: string[] = []; let rev = 0;
      for (const [i, o] of p.ops.slice(0, 200).entries()) {
        if (await c.cancelled()) break;
        const x = await fs.applyOp(projectId, o, { taskId: c.task.id }); all.push(...x.changed); rev = x.revision;
        await c.progress((i + 1) / p.ops.length);
      }
      r = { revision: rev, changed: all };
    } else throw new FatalError("Unknown file operation");
    if (r.changed.length) {
      const { publish } = await import("@realtime/publish.server");
      await publish(c.task.user_id, "filerev", "upsert", `${projectId}:${r.revision}`, r.revision, { id: `${projectId}:${r.revision}`, projectId, revision: r.revision, changed: r.changed.slice(0, 200), version: r.revision });
    }
    return { done: true, result: { revision: r.revision, changed: r.changed.length } };
  },
};
