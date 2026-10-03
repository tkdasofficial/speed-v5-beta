// TaskRunner Durable Object: the background worker. One instance per task id; it runs the task one step per
// alarm, so work survives browser disconnects and never hits a single request's time limit. Alarms are durable:
// if the instance is evicted or a step crashes, Cloudflare re-fires the alarm and the step resumes from `state`.
import { als, resolveSecrets, type Env } from "@backend/context";
import type { Json } from "@realtime/events";

interface DOState { storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; setAlarm(t: number): Promise<void>; deleteAll(): Promise<void> }; id: { toString(): string } }

const BACKOFF = [2_000, 10_000, 30_000, 120_000];

export class TaskRunner {
  constructor(private state: DOState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const { taskId } = (await req.json()) as { taskId: string };
    await this.state.storage.put("taskId", taskId);
    await this.state.storage.setAlarm(Date.now() + 50);
    return new Response("ok");
  }

  async alarm(): Promise<void> {
    const taskId = await this.state.storage.get<string>("taskId");
    if (!taskId) return;
    const env = await resolveSecrets(this.env);
    const req = new Request("https://worker.internal/task");
    const next = await als.run({ req, env }, () => this.step(taskId, this.state.id.toString()));
    if (next === null) await this.state.storage.deleteAll();
    else await this.state.storage.setAlarm(Date.now() + next);
  }

  /** Runs one step. Returns the delay before the next step, or null when the task is finished. */
  private async step(taskId: string, workerId: string): Promise<number | null> {
    const S = await import("./store.server");
    const { handlerFor, RetryableError, FatalError } = await import("./registry");
    let task = await S.getTask(taskId);
    if (!task || ["completed", "failed", "cancelled"].includes(task.status)) return null;
    const handler = await handlerFor(task.type);
    if (!handler) { await S.patchTask(taskId, { status: "failed", error: `Unknown task type: ${task.type}`, completed: true }); return null; }

    const state = JSON.parse(task.state || "{}") as Record<string, unknown> & Json;
    const c = {
      task, payload: JSON.parse(task.payload || "{}") as Record<string, unknown>, state,
      emit: async (kind: string, data: never = {} as never) => { await S.addEvent(task!, kind, data); },
      progress: async (v: number, s?: string) => { task = await S.patchTask(taskId, { progress: v, ...(s !== undefined ? { current_step: s } : {}), heartbeat: true }); },
      cancelled: async () => !!(await S.getTask(taskId))?.cancel_requested,
    };
    if (task.cancel_requested) {
      await handler.onCancel?.(c).catch(() => undefined);
      await S.addEvent(task, "cancelled", {});
      await S.patchTask(taskId, { status: "cancelled", state, completed: true, current_step: "Cancelled" });
      return null;
    }
    // Parked for a user decision: only a decision (status back to queued) or a cancel resumes it.
    if (task.status === "awaiting_approval") return null;
    task = await S.patchTask(taskId, { status: "running", worker_id: workerId, started: true, heartbeat: true });
    c.task = task;
    try {
      const r = await handler.step(c);
      if (r.done) {
        await S.patchTask(taskId, { status: "completed", state, progress: 1, result: r.result ?? null, error: null, completed: true });
        return null;
      }
      if (r.wait) { await S.patchTask(taskId, { status: "awaiting_approval", state, current_step: "Awaiting approval", heartbeat: true }); return null; }
      await S.patchTask(taskId, { state, heartbeat: true });
      return r.delayMs ?? 100;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const transient = e instanceof RetryableError || (!(e instanceof FatalError) && /timeout|timed out|overloaded|429|5\d\d|network|fetch failed|ConflictError|changed while/i.test(msg));
      const max = handler.maxRetries ?? task.max_retries;
      if (transient && task.retry_count < max) {
        const delay = BACKOFF[Math.min(task.retry_count, BACKOFF.length - 1)]! + Math.floor(Math.random() * 1000);
        await S.addEvent(task, "retry", { attempt: task.retry_count + 1, error: msg.slice(0, 300) });
        await S.patchTask(taskId, { status: "retrying", state, retry_count: task.retry_count + 1, error: msg.slice(0, 500) });
        return delay;
      }
      await S.addEvent(task, "failed", { error: msg.slice(0, 500) });
      await S.patchTask(taskId, { status: "failed", state, error: msg.slice(0, 500), completed: true });
      return null;
    }
  }
}

/** Hands a task to its worker (idempotent: re-kicking just reschedules the alarm). */
export async function kickTask(env: Env, taskId: string) {
  const ns = env["TASKS"] as { idFromName(n: string): unknown; get(id: unknown): { fetch(u: string, i: RequestInit): Promise<Response> } } | undefined;
  if (!ns) throw new Error("Background workers are not configured");
  await ns.get(ns.idFromName(taskId)).fetch("https://worker.internal/start", { method: "POST", body: JSON.stringify({ taskId }) });
}
