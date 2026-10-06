// Agent Core API: start/run, status, steps, messages, tool calls, resume, cancel, final result, tool registry.
// Owner-authenticated; every run read is checked against the signed-in user.
import { z } from "zod";
import * as v from "@security/validation";

async function me() { const { requireUser } = await import("@security/authorize.server"); return requireUser(); }
async function owned(runId: string) {
  const user = await me();
  const { agentStore } = await import("../../agent/db.server");
  const store = agentStore();
  const run = await store.getRun(runId) as { user_id: string; project_id: string; status: string; task_text: string } | null;
  if (!run || run.user_id !== user.id) throw new Error("Run not found");
  return { user, store, run };
}
const runId = z.object({ runId: v.id });
const mode = z.object({ model: z.enum(["speed", "flash", "heavy"]).default("speed"), depth: z.enum(["quick", "balanced", "deep"]).default("balanced") });

/** Starts an Agent run (one ai_agent background task; run_id = task id). */
export async function agentStart(raw: unknown) {
  const d = z.object({ projectId: v.id, prompt: z.string().min(1).max(20000), idempotencyKey: z.string().min(1).max(120).optional() }).merge(mode).parse(raw);
  const user = await me();
  const { createTaskFor } = await import("./tasks");
  const t = await createTaskFor(user.id, { type: "ai_agent", projectId: d.projectId, idempotencyKey: d.idempotencyKey, payload: { prompt: d.prompt, model: d.model, depth: d.depth, plan: true } });
  return { runId: (t as { id: string }).id, task: t };
}
export async function agentRun(raw: unknown) { const { runId: id } = runId.parse(raw); const { run, store } = await owned(id); return { run, checkpoint: await store.latestCheckpoint(id) }; }
export async function agentRuns(raw: unknown) { const { projectId } = z.object({ projectId: v.id }).parse(raw); const user = await me(); const { agentStore } = await import("../../agent/db.server"); return agentStore().listRuns(user.id, projectId); }
export async function agentSteps(raw: unknown) { const { runId: id } = runId.parse(raw); const { store } = await owned(id); return store.steps(id); }
export async function agentMessages(raw: unknown) { const { runId: id, since } = runId.extend({ since: z.number().int().min(0).default(0) }).parse(raw); const { store } = await owned(id); return store.messages(id, since); }
export async function agentToolCalls(raw: unknown) { const { runId: id } = runId.parse(raw); const { store } = await owned(id); return store.toolCalls(id); }
export async function agentResult(raw: unknown) {
  const { runId: id } = runId.parse(raw);
  const { store, run } = await owned(id);
  const msgs = (await store.messages(id)) as { message_type: string; content: string }[];
  const final = [...msgs].reverse().find((m) => m.message_type === "final_summary" || m.message_type === "error");
  return { status: run.status, finalSummaryStatus: (run as unknown as { final_summary_status: string }).final_summary_status, summary: final?.content ?? null, usage: await store.usage(id) };
}
export async function agentCancel(raw: unknown) {
  const { runId: id } = runId.parse(raw);
  const { user } = await owned(id);
  const { cancelTaskFor } = await import("./tasks");
  return cancelTaskFor(user.id, id);
}
/** Recovers a failed/cancelled run: starts a child run on the current (already-saved) project files, linked by parent_run_id. */
export async function agentResume(raw: unknown) {
  const { runId: id } = runId.parse(raw);
  const { user, run, store } = await owned(id);
  if (!["failed", "cancelled"].includes(run.status)) throw new Error(`Run is ${run.status}; only failed or stopped runs can be resumed`);
  const cp = await store.latestCheckpoint(id);
  const { createTaskFor } = await import("./tasks");
  const t = await createTaskFor(user.id, { type: "ai_agent", projectId: run.project_id, idempotencyKey: `resume-${id}`, payload: { prompt: run.task_text, model: "speed", depth: "balanced", plan: true, parentRunId: id, resumeCheckpoint: (cp as { checkpoint_id?: string } | null)?.checkpoint_id ?? null } });
  return { runId: (t as { id: string }).id, parentRunId: id };
}
/** Agent Tool Registry (metadata only; no secrets). */
export async function agentTools() {
  await me();
  const { buildRegistry, validateRegistry } = await import("../../agent/registry");
  const entries = buildRegistry();
  return { validation: validateRegistry(entries), tools: entries };
}
