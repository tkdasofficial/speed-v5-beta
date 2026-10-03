// Internal tool API (spec §21). Owner-authenticated; every call goes through the orchestrator (policy, audit, limits).
import { z } from "zod";
import * as v from "@security/validation";

const call = z.object({ tool: z.string().min(2).max(200), args: z.record(z.string(), z.unknown()).default({}) });

async function session(projectId: string, confirmed = false) {
  const { requireUser, assertOwnsProject } = await import("@security/authorize.server");
  const user = await requireUser();
  await assertOwnsProject(user.id, projectId);
  const { openToolSession } = await import("../../tools/session.server");
  return { user, s: openToolSession({ userId: user.id, projectId, confirmed }) };
}

export async function toolList(raw: unknown) {
  const { projectId, capability } = z.object({ projectId: v.id, capability: z.string().max(200).optional() }).parse(raw);
  const { s } = await session(projectId);
  return s.execute(capability ? "find_tools" : "list_tool_categories", capability ? { capability } : {});
}
export async function toolExecute(raw: unknown) {
  const { projectId, confirm, ...c } = call.extend({ projectId: v.id, confirm: z.boolean().default(false) }).parse(raw);
  const { s } = await session(projectId, confirm);
  const r = await s.execute(c.tool, c.args);
  if (r.success) await s.commit(`Tool: ${c.tool}`);
  return r;
}
export async function toolParallel(raw: unknown) {
  const { projectId, calls } = z.object({ projectId: v.id, calls: z.array(call).min(1).max(20) }).parse(raw);
  const { s } = await session(projectId);
  const r = await s.parallel(calls);
  await s.commit("Tool batch");
  return r;
}
export async function toolSequence(raw: unknown) {
  const { projectId, calls, stopOnError } = z.object({ projectId: v.id, calls: z.array(call).min(1).max(30), stopOnError: z.boolean().default(true) }).parse(raw);
  const { s } = await session(projectId);
  const r = await s.sequence(calls, { stopOnError });
  if (r.every((x) => x.success)) await s.commit("Tool sequence");
  return r;
}
export async function toolOperation(raw: unknown) {
  const { projectId, operationId } = z.object({ projectId: v.id, operationId: z.string().regex(/^op_[\w-]+$/) }).parse(raw);
  const { user } = await session(projectId);
  const { d1 } = await import("../d1");
  const [r] = await d1("SELECT id, parent_id, tool_name, status, result, error_code, error_message, attempts, duration_ms, created_at, completed_at FROM tool_operations WHERE id = ? AND project_id = ? AND user_id = ?", [operationId, projectId, user.id]);
  return r ?? null;
}
export async function toolCancel(raw: unknown) {
  const { projectId, operationId } = z.object({ projectId: v.id, operationId: z.string().regex(/^op_[\w-]+$/) }).parse(raw);
  const { user } = await session(projectId);
  const { d1 } = await import("../d1");
  await d1("UPDATE tool_operations SET cancel_requested = 1 WHERE id = ? AND project_id = ? AND user_id = ? AND status = 'running'", [operationId, projectId, user.id]);
  return { ok: true };
}
