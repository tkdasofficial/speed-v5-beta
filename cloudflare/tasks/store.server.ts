// Persistent task records + event log in the main D1. Every state change is published live to the owner.
import { d1 } from "@backend/d1";
import { publish } from "@realtime/publish.server";
import type { Job, JobEvent, Json } from "@realtime/events";

export type TaskStatus = Job["status"];
export type TaskRow = {
  id: string; user_id: string; project_id: string | null; type: string; status: TaskStatus; payload: string; state: string;
  progress: number; current_step: string | null; result: string | null; error: string | null; retry_count: number; max_retries: number;
  cancel_requested: number; worker_id: string | null; heartbeat: string | null; version: number;
  created_at: string; started_at: string | null; updated_at: string; completed_at: string | null;
};
const COLS = "id, user_id, project_id, type, status, payload, state, progress, current_step, result, error, retry_count, max_retries, cancel_requested, worker_id, heartbeat, version, created_at, started_at, updated_at, completed_at";

export const toJob = (r: TaskRow): Job => ({
  id: r.id, projectId: r.project_id, type: r.type, status: r.status, progress: r.progress, currentStep: r.current_step,
  result: r.result ? (JSON.parse(r.result) as Json) : null, error: r.error, retryCount: r.retry_count,
  createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at, version: r.version,
});

export async function getTask(id: string): Promise<TaskRow | null> {
  return (await d1<TaskRow>(`SELECT ${COLS} FROM tasks WHERE id = ?`, [id]))[0] ?? null;
}

export async function insertTask(t: { userId: string; projectId: string | null; type: string; payload: Json; idempotencyKey?: string | undefined; maxRetries?: number }): Promise<{ row: TaskRow; created: boolean }> {
  if (t.idempotencyKey) {
    const [dup] = await d1<TaskRow>(`SELECT ${COLS} FROM tasks WHERE user_id = ? AND idempotency_key = ?`, [t.userId, t.idempotencyKey]);
    if (dup) return { row: dup, created: false };
  }
  const [row] = await d1<TaskRow>(
    `INSERT INTO tasks (id, user_id, project_id, type, payload, idempotency_key, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${COLS}`,
    [crypto.randomUUID(), t.userId, t.projectId, t.type, JSON.stringify(t.payload ?? {}), t.idempotencyKey ?? null, t.maxRetries ?? 3],
  );
  await publish(row!.user_id, "job", "upsert", row!.id, row!.version, toJob(row!));
  return { row: row!, created: true };
}

/** Patches a task row (bumping version) and publishes the new state. */
export async function patchTask(id: string, p: Partial<{ status: TaskStatus; state: Json; progress: number; current_step: string | null; result: Json; error: string | null; retry_count: number; worker_id: string | null; started: boolean; completed: boolean; heartbeat: boolean }>): Promise<TaskRow> {
  const sets: string[] = ["version = version + 1", "updated_at = datetime('now')"];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
  if (p.status !== undefined) put("status", p.status);
  if (p.state !== undefined) put("state", JSON.stringify(p.state));
  if (p.progress !== undefined) put("progress", Math.max(0, Math.min(1, p.progress)));
  if (p.current_step !== undefined) put("current_step", p.current_step);
  if (p.result !== undefined) put("result", JSON.stringify(p.result));
  if (p.error !== undefined) put("error", p.error);
  if (p.retry_count !== undefined) put("retry_count", p.retry_count);
  if (p.worker_id !== undefined) put("worker_id", p.worker_id);
  if (p.started) sets.push("started_at = COALESCE(started_at, datetime('now'))");
  if (p.completed) sets.push("completed_at = datetime('now')");
  if (p.heartbeat) sets.push("heartbeat = datetime('now')");
  const [row] = await d1<TaskRow>(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? RETURNING ${COLS}`, [...vals, id]);
  if (!row) throw new Error("Task not found");
  await publish(row.user_id, "job", "upsert", row.id, row.version, toJob(row));
  return row;
}

/** Appends an ordered, persisted event (replayable after reconnect) and publishes it. */
export async function addEvent(task: Pick<TaskRow, "id" | "user_id" | "project_id">, kind: string, data: Json = {}): Promise<JobEvent> {
  const [row] = await d1<{ seq: number; created_at: string }>(
    "INSERT INTO task_events (task_id, seq, kind, data) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM task_events WHERE task_id = ?), ?, ?) RETURNING seq, created_at",
    [task.id, task.id, kind, JSON.stringify(data)],
  );
  const ev: JobEvent = { id: `${task.id}:${row!.seq}`, taskId: task.id, projectId: task.project_id, seq: row!.seq, kind, data, at: row!.created_at, version: 1 };
  await publish(task.user_id, "jobevent", "upsert", ev.id, 1, ev);
  return ev;
}

export async function listEvents(taskId: string, since = 0): Promise<JobEvent[]> {
  const [t] = await d1<{ project_id: string | null }>("SELECT project_id FROM tasks WHERE id = ?", [taskId]);
  const rows = await d1<{ seq: number; kind: string; data: string; created_at: string }>("SELECT seq, kind, data, created_at FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT 1000", [taskId, since]);
  return rows.map((r) => ({ id: `${taskId}:${r.seq}`, taskId, projectId: t?.project_id ?? null, seq: r.seq, kind: r.kind, data: JSON.parse(r.data) as Json, at: r.created_at, version: 1 }));
}

export async function requestCancel(id: string) {
  await d1("UPDATE tasks SET cancel_requested = 1, updated_at = datetime('now') WHERE id = ?", [id]);
}
