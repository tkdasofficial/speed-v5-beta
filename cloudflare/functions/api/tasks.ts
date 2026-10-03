// Universal task API: create (idempotent), get, list, events since seq, cancel. Ownership checked on every call.
import { z } from "zod";
import * as v from "@security/validation";
import { ctx } from "../context";
import type { Json } from "@realtime/events";

async function me() { const { requireUser } = await import("@security/authorize.server"); return requireUser(); }

const create = z.object({
  type: z.string().min(1).max(60),
  projectId: v.id.optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().min(1).max(120).optional(),
});

export async function createBgTask(raw: unknown) {
  const data = create.parse(raw);
  const user = await me();
  return createTaskFor(user.id, data);
}

/** Validated, idempotent task creation for `userId` (shared by the RPC and the agent's create_task tool). */
export async function createTaskFor(userId: string, data: { type: string; projectId?: string | undefined; payload: Record<string, unknown>; idempotencyKey?: string | undefined }) {
  const { isTaskType } = await import("../../tasks/registry");
  if (!isTaskType(data.type)) throw new Error(`Unknown task type: ${data.type}`);
  if (data.projectId) { const { assertOwnsProject } = await import("@security/authorize.server"); await assertOwnsProject(userId, data.projectId); }
  const S = await import("../../tasks/store.server");
  const { row, created } = await S.insertTask({ userId, projectId: data.projectId ?? null, type: data.type, payload: data.payload as Json, idempotencyKey: data.idempotencyKey });
  if (created) { const { kickTask } = await import("../../tasks/runner"); await kickTask(ctx().env, row.id); }
  return { ...S.toJob(row), created };
}

async function owned(id: string) {
  const user = await me();
  const S = await import("../../tasks/store.server");
  const t = await S.getTask(id);
  if (!t || t.user_id !== user.id) throw new Error("Task not found");
  return { t, S, user };
}

/** Re-kicks tasks whose worker stopped heartbeating (recovery after an eviction). */
async function recover(rows: { id: string; status: string; heartbeat: string | null; updated_at: string }[]) {
  const stale = rows.filter((r) => ["queued", "running", "retrying"].includes(r.status) && Date.now() - Date.parse(`${(r.heartbeat ?? r.updated_at).replace(" ", "T")}Z`) > 5 * 60_000);
  if (!stale.length) return;
  const { kickTask } = await import("../../tasks/runner");
  await Promise.all(stale.slice(0, 5).map((r) => kickTask(ctx().env, r.id).catch(() => undefined)));
}

export async function getBgTask(raw: unknown) {
  const { id } = z.object({ id: v.id }).parse(raw);
  const { t, S } = await owned(id);
  await recover([t]);
  return S.toJob(t);
}

export async function listBgTasks(raw: unknown) {
  const data = z.object({ projectId: v.id.optional(), limit: z.number().int().min(1).max(100).default(30) }).parse(raw ?? {});
  const user = await me();
  const { d1 } = await import("@backend/d1");
  const S = await import("../../tasks/store.server");
  const rows = await d1<Parameters<typeof S.toJob>[0]>(
    `SELECT * FROM tasks WHERE user_id = ? ${data.projectId ? "AND project_id = ?" : ""} ORDER BY created_at DESC LIMIT ?`,
    data.projectId ? [user.id, data.projectId, data.limit] : [user.id, data.limit],
  );
  await recover(rows);
  return rows.map(S.toJob);
}

export async function bgTaskEvents(raw: unknown) {
  const data = z.object({ id: v.id, since: z.number().int().min(0).default(0) }).parse(raw);
  const { S } = await owned(data.id);
  return S.listEvents(data.id, data.since);
}

export async function cancelBgTask(raw: unknown) {
  const { id } = z.object({ id: v.id }).parse(raw);
  const user = await me();
  return cancelTaskFor(user.id, id);
}

/** Requests cancellation of one of `userId`'s tasks (optionally only within `projectId`). */
export async function cancelTaskFor(userId: string, id: string, projectId?: string) {
  const S = await import("../../tasks/store.server");
  const t = await S.getTask(id);
  if (!t || t.user_id !== userId || (projectId && t.project_id !== projectId)) throw new Error("Task not found");
  if (["completed", "failed", "cancelled"].includes(t.status)) return { ...S.toJob(t), alreadyFinished: true };
  await S.requestCancel(id);
  const { kickTask } = await import("../../tasks/runner");
  await kickTask(ctx().env, id).catch(() => undefined);
  return { ...S.toJob({ ...t, cancel_requested: 1 }), alreadyFinished: false };
}

/**
 * One project-creation action: create the project (with the original prompt + extracted name metadata), then its first
 * `ai_agent` task. Idempotent on `requestId`, so retries, double clicks and remounts return the same project and task.
 */
export async function startProject(raw: unknown) {
  const data = z.object({
    requestId: z.string().uuid(),
    prompt: z.string().min(1).max(10000).refine((s) => s.trim().length > 0, "Describe what to build"),
    model: z.enum(["speed", "flash", "heavy"]).default("speed"),
    depth: z.enum(["quick", "balanced", "deep"]).default("balanced"),
    plan: z.boolean().default(false),
  }).parse(raw);
  const user = await me();
  const { d1 } = await import("@backend/d1");
  const { insertProject, toProject } = await import("@backend/projects.server");
  const S = await import("../../tasks/store.server");
  const key = `start-${data.requestId}`;
  const COLS = "id, slug, name, settings, updated_at, created_at, version";
  let [prow] = await d1<Parameters<typeof toProject>[0]>(`SELECT ${COLS} FROM projects WHERE owner_id = ? AND json_extract(settings, '$.creationRequestId') = ?`, [user.id, data.requestId]);
  let project = prow ? toProject(prow) : null;
  if (!project) {
    let meta = { projectName: null as string | null, appName: null as string | null, websiteName: null as string | null };
    try { const { extractProjectMetadata } = await import("../project-name"); meta = extractProjectMetadata(data.prompt); } catch { /* metadata never blocks creation */ }
    const fallback = data.prompt.trim().replace(/\s+/g, " ").slice(0, 40);
    const settings: Record<string, string> = { originalPrompt: data.prompt, creationRequestId: data.requestId };
    if (meta.projectName) settings["metaProjectName"] = meta.projectName;
    if (meta.appName) settings["metaAppName"] = meta.appName;
    if (meta.websiteName) settings["metaWebsiteName"] = meta.websiteName;
    project = await insertProject(user.id, meta.projectName ?? fallback, settings);
  }
  try {
    const { row, created } = await S.insertTask({ userId: user.id, projectId: project.id, type: "ai_agent", idempotencyKey: key,
      payload: { prompt: data.prompt, model: data.model, depth: data.depth, plan: data.plan, clientMessageId: key } });
    if (created) { const { kickTask } = await import("../../tasks/runner"); await kickTask(ctx().env, row.id); }
    return { project, job: S.toJob(row), error: null as string | null };
  } catch (e) {
    console.error("startProject: agent start failed", (e as Error).message);
    return { project, job: null, error: "The project was created, but the agent couldn't start. Send your message again from the project." };
  }
}

/** Records the user's decision on a plan the agent is waiting on (approve / deny / edit) and resumes the task. */
export async function decideAgentPlan(raw: unknown) {
  const data = z.object({ id: v.id, decision: z.enum(["approve", "deny", "edit"]), feedback: z.string().trim().max(4000).optional() }).parse(raw);
  const { t, S } = await owned(data.id);
  if (t.status !== "awaiting_approval") throw new Error("This plan is no longer waiting for a decision");
  if (data.decision === "edit" && !data.feedback) throw new Error("Describe what to change in the plan");
  await S.addEvent(t, "plan.decision", { decision: data.decision, feedback: data.feedback ?? null });
  const row = await S.patchTask(data.id, { status: "queued", current_step: data.decision === "approve" ? "Thinking" : data.decision === "edit" ? "Thinking" : "Denied" });
  const { kickTask } = await import("../../tasks/runner");
  await kickTask(ctx().env, data.id);
  return S.toJob(row);
}
