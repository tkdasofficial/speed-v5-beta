// ai_agent tasks: the full agent workflow, running entirely on the server as one durable task.
// Phases (persisted in state, mirrored as `phase` events):
//   planning (Thinking → analyze → Creating Plan) → awaiting_approval (task parked, no alarm)
//   → building (Thinking → Action → … rounds) → validating → testing → completed
// Exits: denied (user denied the plan), cancelled (Stop), failed (errors / repair limit).
// Every action emits `action.started` before it runs and `action` (completed/failed) after, so the UI
// shows Processing only while the server is really doing the work, and rebuilds it from events on reload.
import type { Json, Message } from "@realtime/events";
import type { TaskHandler, TaskContext, StepResult } from "../registry";
import { FatalError } from "../registry";
import type { AgentPlan } from "../../functions/ai/orchestrator.server";
import type { MemoryFileStore } from "../../../sandbox/workspace/workspace";
import { AgentRun } from "../../agent/run.server";
import type { Batch, SubTask } from "../../agent/grouping";

const MAX_ROUNDS = 12;
const MAX_REPAIRS = 3; // failed checks inside the build loop before giving up
const MAX_FIX_ATTEMPTS = 3; // validation/test → fix → retest cycles
type Step = { kind: "read" | "create" | "edit" | "delete" | "think" | "check" | "tool"; path?: string; content?: string; find?: string; replace?: string; note?: string; name?: string; args?: Record<string, unknown> };
type Phase = "planning" | "awaiting" | "building" | "validating";
type State = {
  phase?: Phase; changed?: string[]; created?: string[]; lastCheck?: boolean | null; round?: number; results?: string; failedBuilds?: number;
  failedIds?: string[]; baseRevision?: number; mutated?: boolean; plan?: AgentPlan; planVersion?: number; decisionSeq?: number;
  feedback?: string; snippets?: string; fixAttempts?: number; validation?: string; test?: string; n?: number;
  /** Agent Core: analyzed sub-tasks, batches (with their agent_steps ids), relevant files and summary status. */
  ag?: { tasks: SubTask[]; batches: Batch[]; batchSteps: Record<string, string>; relevant?: string[] };
  finalSummaryStatus?: string;
};
type P = { prompt?: string; model?: "speed" | "flash" | "heavy"; depth?: "quick" | "balanced" | "deep"; plan?: boolean; clientMessageId?: string; parentRunId?: string };

/** Running / completed labels for one action ("Creating styles.css" → "Created styles.css"). */
function labels(name: string, target: string | null): { kind: string; running: string; done: string; failed: string } {
  const t = target ?? "";
  const v = (kind: string, ing: string, ed: string) => ({ kind, running: `${ing}${t ? ` ${t}` : ""}`, done: `${ed}${t ? ` ${t}` : ""}`, failed: `Couldn't ${ing.toLowerCase().replace(/ing$/, "")}${t ? ` ${t}` : ""}` });
  if (name === "create_file" || name === "create_directory" || /^generate_/.test(name)) return v("create", "Creating", "Created");
  if (/^(update_file|write_file|apply_patch|format_file|refactor_code|replace_in_file)$/.test(name)) return v("edit", "Editing", "Edited");
  if (/^delete_/.test(name)) return v("delete", "Deleting", "Deleted");
  if (name === "rename_file" || name === "move_file") return v("edit", "Moving", "Moved");
  if (/^(read|get_file|get_project_structure)/.test(name)) return v("read", "Reading", "Read");
  if (/(search|find)/.test(name)) return v("search", "Searching", "Searched");
  if (/^list_/.test(name)) return v("read", "Exploring", "Explored");
  if (/^(verify_|run_|check_|detect_|scan_)/.test(name)) return { kind: "check", running: "Checking project", done: "Check passed", failed: "Check failed" };
  if (/^(add|remove|update|install)_dependenc/.test(name)) return v("edit", "Updating dependencies", "Updated dependencies");
  if (/^git_/.test(name)) return v("inspect", `Git ${name.slice(4).replace(/_/g, " ")}`, `Git ${name.slice(4).replace(/_/g, " ")} done`);
  if (/(rollback|restore|recover)/.test(name)) return v("fix", "Undoing change", "Undid change");
  return v("inspect", "Inspecting", "Inspected");
}
/** Legacy/shorthand names the model may still use → the orchestrated tool that does the same work. */
const ALIASES: Record<string, string> = { edit_file: "update_file", search_text: "search_files", search_filename: "search_files", build_project: "verify_project", build_static: "verify_project", validate_project: "verify_project", get_errors: "detect_errors", get_file_tree: "get_project_structure" };
function toTool(s: Step): { name: string; args: Record<string, unknown> } {
  switch (s.kind) {
    case "read": return { name: "read_file", args: { path: s.path } };
    case "create": return { name: "write_file", args: { path: s.path, content: s.content ?? "" } };
    case "edit": return s.find === undefined && s.content !== undefined ? { name: "write_file", args: { path: s.path, content: s.content } } : { name: "update_file", args: { path: s.path, find: s.find, replace: s.replace ?? "" } };
    case "delete": return { name: "delete_file", args: { path: s.path, confirm: true } };
    case "check": return { name: "verify_project", args: {} };
    case "tool": {
      const raw = s.name ?? ""; const args = { ...(s.args ?? {}) };
      if (raw === "edit_file" && typeof args["content"] === "string" && args["find"] === undefined) return { name: "write_file", args };
      if (raw === "patch_file") return { name: "apply_patch", args: { path: args["path"], edits: args["edits"] } };
      return { name: ALIASES[raw] ?? raw, args };
    }
    default: return { name: "", args: {} };
  }
}
const VERIFY = new Set(["verify_project"]);

/** Compact, machine-readable result for the model (success/error code/next action). */
function fmt(r: import("../../tools/types").ToolResult, max = 6000): string {
  if (!r.success) return `${r.toolName} [${r.operationId}]: ERROR ${r.error?.code} — ${r.error?.message}${r.nextRecommendedAction ? ` (next: ${r.nextRecommendedAction})` : ""}`;
  const d = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
  return `${r.toolName} [${r.operationId}]: ok${r.warnings.length ? ` (warnings: ${r.warnings.join("; ").slice(0, 300)})` : ""}${r.nextRecommendedAction ? ` (next: ${r.nextRecommendedAction})` : ""}\n${(d ?? "").slice(0, max)}`;
}
const verifyOk = (r: import("../../tools/types").ToolResult) => r.success && (r.data as { ok?: boolean } | null)?.ok !== false;

async function session(c: TaskContext, readOnly = false) {
  const { openToolSession } = await import("../../tools/session.server");
  return openToolSession({ userId: c.task.user_id, projectId: c.task.project_id!, taskId: c.task.id, confirmed: true, readOnly });
}

async function saveMessage(c: TaskContext, role: "user" | "assistant", content: string): Promise<Message> {
  const { d1 } = await import("@backend/d1");
  const { publish } = await import("@realtime/publish.server");
  const pid = c.task.project_id!;
  await d1("INSERT OR IGNORE INTO conversations (id, project_id) VALUES (?, ?)", [pid, pid]);
  const [row] = await d1<{ id: string; created_at: string }>("INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?) RETURNING id, created_at", [crypto.randomUUID(), pid, role, content]);
  const m: Message = { id: row!.id, projectId: pid, role, content, createdAt: row!.created_at, version: 1 };
  await publish(c.task.user_id, "message", "upsert", m.id, 1, m);
  return m;
}
async function say(c: TaskContext, st: State, text: string, role: "user" | "assistant" = "assistant") {
  const m = await saveMessage(c, role, text);
  await c.emit("message", { messageId: m.id, round: st.round ?? 0 });
}
const phase = (c: TaskContext, name: string) => c.emit("phase", { phase: name });
/** Locally generated progress (no AI), shown in chat and recorded in Agent D1. */
async function tell(c: TaskContext, st: State, e: import("../../agent/messages").ProgressEvent, stepId?: string | null) {
  const text = await (await AgentRun.for(c)).progress(e, stepId);
  await say(c, st, text);
}
const batchOf = (st: State) => (st.ag?.batches.length === 1 ? st.ag.batches[0]!.id : null);

/** Emits action.started, runs the work, then emits the completed/failed action with its real result. */
async function act<T>(c: TaskContext, st: State, a: { kind: string; running: string; done: string; failed?: string; round?: number }, work: () => Promise<{ ok: boolean; result?: T; error?: string; done?: string }> | { ok: boolean; result?: T; error?: string; done?: string }) {
  const id = `${c.task.id}-a${(st.n = (st.n ?? 0) + 1)}`;
  const round = a.round ?? st.round ?? 0;
  await c.emit("action.started", { id, round, kind: a.kind, title: a.running, target: null });
  let r: { ok: boolean; result?: T; error?: string; done?: string };
  try { r = await work(); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  await c.emit("action", { id, round, kind: a.kind, title: r.ok ? (r.done ?? a.done) : (a.failed ?? a.running), target: null, ok: r.ok, error: r.ok ? null : (r.error ?? "Failed").slice(0, 600) });
  return { id, ...r };
}

/** Stop takes effect while the model is still answering: poll the persisted cancel flag alongside the call. */
async function withCancel<T>(c: TaskContext, p: Promise<T>): Promise<T | null> {
  let poll: ReturnType<typeof setTimeout> | undefined;
  const watch = new Promise<null>((resolve) => { const tick = async () => { if (await c.cancelled().catch(() => false)) resolve(null); else poll = setTimeout(() => void tick(), 2000); }; poll = setTimeout(() => void tick(), 2000); });
  return Promise.race([p, watch]).finally(() => clearTimeout(poll));
}

async function end(c: TaskContext, st: State, status: "done" | "failed" | "denied", text: string, error?: string): Promise<StepResult> {
  await say(c, st, text);
  const ar = await AgentRun.for(c);
  await ar.store.addMessage(ar.runId, { role: "agent", type: status === "done" ? "final_summary" : "error", content: text }).catch((e) => console.error("[agent-d1]", (e as Error).message));
  for (const [, sid] of Object.entries(st.ag?.batchSteps ?? {})) await ar.finishStep(sid, { status: status === "done" ? "succeeded" : status === "denied" ? "cancelled" : "failed", ...(status === "failed" ? { error: error ?? null } : {}) });
  await ar.progress({ type: "complete", changed: st.changed?.length ?? 0, ok: status === "done" });
  await ar.checkpoint({ type: "stage", state: { phase: status, revision: st.baseRevision ?? 0 }, completed: st.changed ?? [], pending: [], next: null });
  await ar.finish(status === "done" ? "completed" : status === "denied" ? "cancelled" : "failed", { failureReason: status === "done" ? null : (error ?? (status === "denied" ? "Plan denied" : text.slice(0, 500))), finalSummaryStatus: st.finalSummaryStatus ?? "skipped", metadata: { changed: (st.changed ?? []).slice(0, 100), created: (st.created ?? []).slice(0, 100), validation: st.validation ?? null, test: st.test ?? null } });
  await phase(c, status === "done" ? "completed" : status);
  await c.emit("run.end", { status, ...(error ? { error } : {}), mutated: !!st.mutated, revision: st.baseRevision ?? 0 });
  // Successful builds of React + Vite projects start a runtime preview build (unchanged sources are skipped).
  if (status === "done" && c.task.project_id) {
    const { startBuild } = await import("@backend/build/pipeline.server");
    await startBuild(c.task.user_id, c.task.project_id).catch((e) => console.warn(`[build] auto preview skipped: ${(e as Error).message}`));
  }
  return { done: true, result: { status, mutated: !!st.mutated } };
}

// ---------------- planning ----------------
async function planStep(c: TaskContext, st: State, p: P): Promise<StepResult> {
  const pid = c.task.project_id!;
  const fs = await import("../../sandbox/fs.server");
  const { d1 } = await import("@backend/d1");
  await phase(c, "thinking");
  await c.progress(0.02, "Thinking");
  const { store } = await fs.loadStore(pid);
  const files = store.list().map((f) => f.path).sort();
  const ar = await AgentRun.for(c);
  if (st.snippets === undefined) {
    const { buildContext, contextSnippets } = await import("../../agent/context");
    const actx = buildContext({ request: p.prompt ?? "", projectId: pid, projectName: "", files: store.list(), tasks: st.ag?.tasks ?? [], stage: "planning" });
    await ar.progress({ type: "inspect", fileCount: files.length });
    // Inspect only the files that matter for a plan: small text sources, entry page first, capped context.
    const r = await act(c, st, { kind: "inspect", running: "Analyzing existing project", done: "Project analyzed" }, () => {
      const text = store.list().filter((f) => f.encoding === "utf8" && /\.(html?|css|js|mjs|json|md|txt|svg)$/i.test(f.path) && f.content.length < 60000)
        .sort((a, b) => (a.path === "index.html" ? -1 : b.path === "index.html" ? 1 : a.content.length - b.content.length)).slice(0, 8);
      let budget = 16000; const parts: string[] = [];
      for (const f of text) { if (budget <= 0) break; const s = f.content.slice(0, Math.min(4000, budget)); budget -= s.length; parts.push(`--- ${f.path}${f.content.length > s.length ? " (truncated)" : ""}\n${s}`); }
      const rel = contextSnippets(actx);
      return { ok: true, result: rel ? `${rel}\n${parts.filter((x) => !actx.relevantFiles.some((f) => x.startsWith(`--- ${f.path}`))).join("\n")}`.slice(0, 20000) : parts.join("\n"), done: files.length ? `Project analyzed · ${files.length} file${files.length === 1 ? "" : "s"}` : "Project analyzed · empty project" };
    });
    st.snippets = (r.result as string | undefined) ?? "";
    if (st.ag) st.ag.relevant = actx.relevantFiles.map((f) => f.path);
    await ar.progress({ type: "identify", files: st.ag?.relevant ?? [], taskCount: st.ag?.tasks.length ?? 1 });
  }
  if (await c.cancelled()) return { done: false, delayMs: 10 };
  await phase(c, "planning");
  await c.progress(0.08, "Creating Plan");
  const [proj] = await d1<{ name: string }>("SELECT name FROM projects WHERE id = ?", [pid]);
  const { createPlan } = await import("../../functions/ai/orchestrator.server");
  const planT0 = Date.now();
  const out = await withCancel(c, createPlan({ model: p.model ?? "speed", depth: p.depth ?? "balanced", projectName: proj?.name ?? "project", prompt: p.prompt ?? "", files, snippets: st.snippets, previous: st.plan, feedback: st.feedback }));
  if (!out) return { done: false, delayMs: 10 };
  if (out.usedModel) await c.emit("model", { stage: "plan", model: out.usedModel, fallbacks: (out.fallbacks ?? []) as unknown as Json });
  // Real execution call (planning), recorded honestly; progress text never creates usage rows.
  await ar.usage({ provider: (out.usedModel ?? "unknown").split("/")[0]!, model: out.usedModel ?? "unknown", requestType: "plan", latencyMs: Date.now() - planT0, status: "succeeded" });
  if ("answer" in out) return end(c, st, "done", out.answer);
  st.plan = out.plan; st.planVersion = (st.planVersion ?? 0) + 1; delete st.feedback;
  await ar.checkpoint({ type: "stage", state: { phase: "awaiting", planVersion: st.planVersion, baseRevision: st.baseRevision }, completed: ["analyze", "plan"], pending: (st.ag?.batches ?? []).map((b) => b.id), next: "awaiting_approval" });
  await ar.stage("awaiting_approval");
  await c.emit("plan", { version: st.planVersion, plan: out.plan as unknown as Json });
  await phase(c, "awaiting_approval");
  st.phase = "awaiting";
  return { done: false, wait: true };
}

async function decisionStep(c: TaskContext, st: State): Promise<StepResult> {
  const { d1 } = await import("@backend/d1");
  const [row] = await d1<{ seq: number; data: string }>("SELECT seq, data FROM task_events WHERE task_id = ? AND kind = 'plan.decision' AND seq > ? ORDER BY seq DESC LIMIT 1", [c.task.id, st.decisionSeq ?? 0]);
  if (!row) return { done: false, wait: true };
  st.decisionSeq = row.seq;
  const d = JSON.parse(row.data) as { decision: "approve" | "deny" | "edit"; feedback?: string | null };
  if (d.decision === "deny") return end(c, st, "denied", "Plan denied. No files were changed.");
  if (d.decision === "edit") {
    st.feedback = d.feedback ?? ""; st.phase = "planning";
    await say(c, st, st.feedback, "user");
    return { done: false, delayMs: 10 };
  }
  await c.emit("plan.approved", { version: st.planVersion ?? 1 });
  await phase(c, "thinking");
  await c.progress(0.12, "Thinking");
  await say(c, st, "I'll start building the project now.");
  await phase(c, "building");
  st.phase = "building"; st.round = 0;
  {
    const ar = await AgentRun.for(c);
    await ar.stage("building", "running");
    for (const sid of Object.values(st.ag?.batchSteps ?? {})) await ar.finishStep(sid, { status: "running" });
    const { batchPrompt } = await import("../../agent/grouping");
    st.results = st.ag ? `TASK BATCHES (do each batch's related edits together, in as few rounds as possible):\n${batchPrompt(st.ag.tasks, st.ag.batches)}${st.ag.relevant?.length ? `\nMost relevant files: ${st.ag.relevant.join(", ")}` : ""}` : "";
  }
  return { done: false, delayMs: 10 };
}

// ---------------- building ----------------
async function buildStep(c: TaskContext, st: State, p: P): Promise<StepResult> {
  const pid = c.task.project_id!;
  const round = st.round ?? 0;
  if (round >= MAX_ROUNDS) { st.phase = "validating"; return { done: false, delayMs: 10 }; }
  const fs = await import("../../sandbox/fs.server");
  const { d1 } = await import("@backend/d1");
  const prog = (label: string, frac = 0) => c.progress(0.15 + 0.6 * Math.min(1, (round + frac) / MAX_ROUNDS), label);
  await c.emit("step", { label: "Thinking", round });
  await prog("Thinking");

  const { store } = await fs.loadStore(pid);
  const existing = new Set(store.list().map((f) => f.path));
  const hist = await d1<{ role: "user" | "assistant"; content: string }>(
    "SELECT role, content FROM (SELECT role, content, created_at, rowid AS r FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY created_at DESC, r DESC LIMIT 12) ORDER BY created_at, r", [pid]);
  const [proj] = await d1<{ name: string }>("SELECT name FROM projects WHERE id = ?", [pid]);
  const { runAgentRound, planText } = await import("../../functions/ai/orchestrator.server");
  const { loadTools } = await import("../../tools/index");
  const { catalogText } = await import("../../tools/exposure");
  loadTools();
  const ar = await AgentRun.for(c);
  const batchId = batchOf(st);
  const roundT0 = Date.now();
  const step = await withCancel(c, runAgentRound({ model: p.model ?? "speed", depth: p.depth ?? "balanced", plan: false, projectName: proj?.name ?? "project", round, files: store.list().map((f) => f.path).sort(), results: st.results ?? "", history: hist, tools: catalogText("building"), ...(st.plan ? { approvedPlan: planText(st.plan) } : {}) }));
  if (!step) return { done: false, delayMs: 10 };
  await c.emit("model", { stage: "build", round, model: step.usedModel, fallbacks: step.fallbacks as unknown as Json });
  const rid = await ar.step({ type: "edit", name: `Build round ${round + 1}`, batchId, description: step.message.slice(0, 500), metadata: { actions: (step.actions as Step[]).length } });
  await ar.usage({ stepId: rid, provider: String(step.usedModel ?? "unknown").split("/")[0]!, model: String(step.usedModel ?? "unknown"), requestType: "build_round", latencyMs: Date.now() - roundT0, status: "succeeded" });
  if (await c.cancelled()) return { done: false, delayMs: 10 };
  {
    const acts = step.actions as Step[];
    const writes = [...new Set(acts.filter((a) => a.kind === "create" || a.kind === "edit" || a.kind === "delete" || (a.kind === "tool" && /^(write|update|create|delete|apply|replace)_/.test(a.name ?? ""))).map((a) => a.path ?? (a.args?.["path"] as string | undefined)).filter((x): x is string => !!x))];
    const reads = [...new Set(acts.filter((a) => a.kind === "read").map((a) => a.path!).filter(Boolean))];
    if (writes.length) await tell(c, st, { type: "apply", files: writes, batchLabel: st.ag?.batches.find((b) => b.id === batchId)?.label }, rid);
    else if (reads.length) await ar.progress({ type: "read", files: reads }, rid);
    else if (step.message && !step.done) await say(c, st, step.message);
  }

  // Every action goes through the ToolOrchestrator: policy → args → prerequisites → execute → audit (tool_operations).
  const sess = await session(c);
  await c.emit("step", { label: "Working", round });
  const log: string[] = [];
  let built: boolean | null = null, stopped = false;
  const failedIds = st.failedIds ?? [];
  const created = new Set(st.created ?? []);
  for (const s of step.actions as Step[]) {
    // Cancellation is honoured between actions: no new file change starts after Stop.
    if (await c.cancelled()) { stopped = true; sess.cancel(); break; }
    if (s.kind === "think") { await act(c, st, { kind: "think", running: "Thinking", done: s.note ? `Planned: ${s.note.slice(0, 120)}` : "Planned next step", round }, () => ({ ok: true })); log.push("think: noted"); continue; }
    const { name, args } = toTool(s);
    if (!name) continue;
    const target = typeof args["path"] === "string" ? (args["path"] as string) : typeof args["query"] === "string" ? `"${args["query"] as string}"` : typeof args["name"] === "string" ? (args["name"] as string) : null;
    const L = VERIFY.has(name) ? labels("verify_project", null) : labels(name, target);
    const r = await act(c, st, { kind: L.kind, running: L.running, done: L.done, failed: L.failed, round }, async () => {
      const res = await ar.tool(sess, name, args, { stepId: rid, batchId });
      log.push(fmt(res));
      const ok = VERIFY.has(res.toolName) ? verifyOk(res) : res.success;
      return ok ? { ok: true } : { ok: false, error: (res.error?.message ?? fmt(res)).slice(0, 600) };
    });
    if (VERIFY.has(name)) built = r.ok;
    if (!r.ok) failedIds.push(r.id);
    if (r.ok && target && (name === "write_file" || name === "create_file") && !existing.has(target)) created.add(target);
  }
  st.created = [...created].slice(0, 200);
  const wrote = sess.pendingChanges.length > 0;
  if (wrote && built === null && !stopped) {
    const r = await act(c, st, { kind: "check", running: "Checking project", done: "Check passed", failed: "Check failed", round }, async () => {
      const res = await ar.tool(sess, "verify_project", {}, { stepId: rid, batchId });
      log.push(`(automatic) ${fmt(res)}`);
      return verifyOk(res) ? { ok: true } : { ok: false, error: fmt(res).slice(0, 600) };
    });
    built = r.ok; if (!r.ok) failedIds.push(r.id);
  }
  // Persist the round's changes as one revision through the session (conflicts surface as CONFLICT results).
  if (wrote) {
    await prog("Saving changes", 0.9);
    const r = await sess.commit(step.message.slice(0, 80) || "Agent changes");
    if (r.changed.length) {
      st.mutated = true;
      st.changed = [...new Set([...(st.changed ?? []), ...r.changed])].slice(0, 200);
      const { publish } = await import("@realtime/publish.server");
      await publish(c.task.user_id, "filerev", "upsert", `${pid}:${r.revision}`, r.revision, { id: `${pid}:${r.revision}`, projectId: pid, revision: r.revision, changed: r.changed.slice(0, 200), version: r.revision });
      await c.emit("files", { revision: r.revision, changed: r.changed.slice(0, 50) });
      await ar.files(r.changed, r.revision, { stepId: rid, batchId });
      await ar.progress({ type: "applied", files: r.changed, ok: true }, rid);
    }
  }
  await ar.finishStep(rid, { status: stopped ? "cancelled" : failedIds.length && built !== true ? "failed" : "succeeded", outputRef: `rev:${st.baseRevision ?? 0}`, ...(built === false ? { error: log.filter((l) => /error/i.test(l)).slice(-1)[0]?.slice(0, 600) ?? "Check failed" } : {}) });
  await ar.checkpoint({ stepId: rid, type: "batch", state: { phase: "building", round: round + 1, lastCheck: built, failedBuilds: st.failedBuilds ?? 0 }, completed: st.changed ?? [], pending: (st.ag?.batches ?? []).map((b) => b.id), next: step.done ? "validating" : "building" });
  if (stopped) return { done: false, delayMs: 10 };
  if (built !== null) st.lastCheck = built;
  if (built === false) {
    const err = log.filter((l) => /error/i.test(l)).slice(-1)[0] ?? "Check failed";
    await ar.progress({ type: "build", ok: false, error: err }, rid);
    if ((st.failedBuilds ?? 0) + 1 < MAX_REPAIRS) { await ar.step({ type: "recover", name: `Repair after failed check (${(st.failedBuilds ?? 0) + 1}/${MAX_REPAIRS})`, parentStepId: rid, status: "succeeded" }); await ar.progress({ type: "retry", what: "the failed check", attempt: (st.failedBuilds ?? 0) + 2, max: MAX_REPAIRS }); }
  } else if (built === true) await ar.progress({ type: "build", ok: true }, rid);
  if (built === true) { if (failedIds.length) await c.emit("fixed", { ids: failedIds }); st.failedIds = []; st.failedBuilds = 0; }
  else st.failedIds = failedIds.slice(-50);
  if (built === false && (st.failedBuilds = (st.failedBuilds ?? 0) + 1) >= MAX_REPAIRS) {
    return end(c, st, "failed", `Not finished. The project check still fails after ${MAX_REPAIRS} repair attempts:\n\n${log.filter((l) => /error/i.test(l)).slice(-1)[0]?.slice(0, 800) ?? "see the failed steps above."}`, `Stopped after ${MAX_REPAIRS} failed repair attempts.`);
  }
  st.results = log.join("\n").slice(0, 40000);
  st.round = round + 1;
  if (step.done && built !== false) {
    // A pure answer with no file work and nothing changed ends here; real builds go through validation.
    if (!st.mutated && !st.changed?.length) return end(c, st, "done", step.message || "Done. No files were changed.");
    st.phase = "validating";
    return { done: false, delayMs: 10 };
  }
  if (step.done && built === false) st.results += "\nYou said done, but the check failed — fix the errors above with targeted edits.";
  return { done: false, delayMs: 50 };
}

// ---------------- validating + testing ----------------
async function validateStep(c: TaskContext, st: State): Promise<StepResult> {
  const pid = c.task.project_id!;
  const fs = await import("../../sandbox/fs.server");
  const { store } = await fs.loadStore(pid);
  const { validateProject, validateReferences } = await import("../../../sandbox/intelligence/validate");
  const sess = await session(c);
  await phase(c, "validating");
  await c.progress(0.8, "Validating");
  const ar = await AgentRun.for(c);
  await ar.stage("verifying", "verifying");
  const vid = await ar.step({ type: "verify", name: "Validate requirements", batchId: batchOf(st) });
  await ar.progress({ type: "verify" }, vid);
  const plan = st.plan;
  const changed = new Set(st.changed ?? []);
  const v = await act(c, st, { kind: "check", running: "Validating requirements", done: "Requirements verified", failed: "Validation failed" }, async () => {
    const issues: string[] = [];
    // Vite keeps index.html at the root, so a planned CRA-style public/index.html is satisfied by it.
    const exists = (f: string) => !!store.get(f) || (f === "public/index.html" && !!store.get("index.html"));
    for (const f of plan?.create ?? []) if (!exists(f)) issues.push(`Planned file ${f} was not created.`);
    for (const f of plan?.modify ?? []) if (!store.get(f)) issues.push(`Planned file ${f} is missing.`); else if (!changed.has(f)) issues.push(`Planned change to ${f} was not made.`);
    if (!store.get("index.html") && store.list().some((f) => /\.html?$/.test(f.path))) issues.push("index.html is missing at the project root.");
    // Every stylesheet / script must be linked from some page, otherwise the requested design/behaviour never shows.
    const pages = store.list().filter((f) => /\.html?$/.test(f.path)).map((f) => f.content).join("\n");
    for (const f of store.list()) {
      if (!/\.(css|js)$/.test(f.path) || !changed.has(f.path)) continue;
      const base = f.path.split("/").pop()!;
      const usedByOther = store.list().some((o) => o.path !== f.path && o.content.includes(base));
      if (!pages.includes(base) && !usedByOther) issues.push(`${f.path} is not linked from any page.`);
    }
    const proj = validateProject(store);
    for (const e of proj.errors.slice(0, 10)) { const d = e as unknown as { path?: string; line?: number; message?: string }; issues.push(`${d.path ? `${d.path}${d.line ? `:${d.line}` : ""}: ` : ""}${d.message ?? JSON.stringify(e).slice(0, 300)}`); };
    for (const d of validateReferences(store).filter((x) => x.severity === "error").slice(0, 10)) issues.push(`${d.file}${d.line ? `:${d.line}` : ""}: ${d.message}`);
    const sec = await ar.tool(sess, "scan_secrets", {}, { stepId: vid });
    if (sec.success && ((sec.data as { findings?: unknown[] })?.findings?.length ?? 0) > 0) issues.push(`Secrets found in source files — move them to environment variables: ${JSON.stringify((sec.data as { findings: unknown[] }).findings.slice(0, 5))}`);
    return issues.length ? { ok: false, result: issues, error: issues.slice(0, 6).join("\n") } : { ok: true, result: [] };
  });
  let issues = (v.result as string[] | undefined) ?? [];
  st.validation = v.ok ? "Passed" : "Failed";
  await ar.finishStep(vid, { status: v.ok ? "succeeded" : "failed", error: v.ok ? null : issues.slice(0, 6).join("\n") });
  await ar.progress({ type: "verify", ok: v.ok, issues }, vid);
  if (v.ok) {
    // Testing: the Sandbox-only architecture has no terminal/browser runtime yet, so the test is the transactional
    // static build (validate → stage → verify). Speed Runtime can replace this step with a real build + run later.
    await phase(c, "testing");
    await c.progress(0.9, "Testing");
    const tid = await ar.step({ type: "test", name: "Build and test project", batchId: batchOf(st) });
    await ar.progress({ type: "test" }, tid);
    const t = await act(c, st, { kind: "check", running: "Building and testing project", done: "Build test passed", failed: "Build test failed" }, async () => {
      const res = await ar.tool(sess, "verify_project", {}, { stepId: tid });
      return verifyOk(res) ? { ok: true } : { ok: false, error: fmt(res).slice(0, 800) };
    });
    st.test = t.ok ? "Passed" : "Failed";
    await ar.finishStep(tid, { status: t.ok ? "succeeded" : "failed", error: t.ok ? null : (t.error ?? null) });
    await ar.progress({ type: "test", ok: t.ok, ...(t.ok ? {} : { error: t.error ?? "" }) }, tid);
    if (!t.ok) issues = [t.error ?? "Build test failed"];
  }
  if (!issues.length) {
    const created = (st.created ?? []).filter((f) => store.get(f));
    const modified = (st.changed ?? []).filter((f) => !created.includes(f) && store.get(f));
    const deleted = (st.changed ?? []).filter((f) => !store.get(f));
    const feats = [...(plan?.pages ?? []), ...(plan?.functional ?? []), ...(plan?.design ?? [])].slice(0, 8);
    const list = (h: string, l: string[]) => (l.length ? `${h}:\n${l.slice(0, 20).map((x) => `- ${x}`).join("\n")}` : "");
    const text = ["Build Complete", plan?.summary || plan?.title || "", list("Implemented", feats), list("Files created", created), list("Files modified", modified), list("Files deleted", deleted), `Validation: ${st.validation}\nBuild/Test: ${st.test ?? "Passed"}`].filter(Boolean).join("\n\n");
    // The run's single final-summary AI call, over the structured, verified result. Falls back to the factual text.
    const sid = await ar.step({ type: "summary", name: "Final summary" });
    let finalText = text; const t0 = Date.now();
    try {
      const { finalSummary } = await import("../../functions/ai/orchestrator.server");
      const r = await finalSummary({ model: (c.payload as P).model ?? "speed", result: {
        request: (c.payload as P).prompt ?? "", tasks: (st.ag?.tasks ?? []).map((t) => t.text), batches: (st.ag?.batches ?? []).map((b) => ({ id: b.id, kind: b.kind, tasks: b.taskIds.length })),
        filesCreated: created, filesModified: modified, filesDeleted: deleted, planned: feats, validation: st.validation, buildTest: st.test ?? "Passed",
      } });
      finalText = r.text; st.finalSummaryStatus = "generated";
      await ar.usage({ stepId: sid, provider: r.provider, model: r.model, requestType: "final_summary", latencyMs: r.latencyMs, status: "succeeded", metadata: { fallbacks: r.fallbacks } });
      await ar.finishStep(sid, { status: "succeeded" });
    } catch (e) {
      st.finalSummaryStatus = "failed";
      await ar.usage({ stepId: sid, provider: "unknown", model: "unknown", requestType: "final_summary", latencyMs: Date.now() - t0, status: "failed", metadata: { error: (e as Error).message.slice(0, 300) } });
      await ar.finishStep(sid, { status: "failed", error: (e as Error).message });
    }
    return end(c, st, "done", finalText);
  }
  st.fixAttempts = (st.fixAttempts ?? 0) + 1;
  if (st.fixAttempts <= MAX_FIX_ATTEMPTS) {
    await ar.step({ type: "recover", name: `Automatic fix ${st.fixAttempts}/${MAX_FIX_ATTEMPTS}`, status: "succeeded", metadata: { issues: issues.slice(0, 6) } });
    await tell(c, st, { type: "fix", attempt: st.fixAttempts, max: MAX_FIX_ATTEMPTS, issues });
    await ar.checkpoint({ type: "recovery", state: { phase: "building", fixAttempts: st.fixAttempts }, completed: st.changed ?? [], pending: issues.slice(0, 20), next: "building" });
  }
  if (st.fixAttempts > MAX_FIX_ATTEMPTS) {
    return end(c, st, "failed", `Not finished. Validation still fails after ${MAX_FIX_ATTEMPTS} automatic fixes:\n\n${issues.slice(0, 6).map((i) => `- ${i}`).join("\n")}`, "Validation failed after automatic fixes.");
  }
  // Automatic fix: back to Thinking → Action with the real failures, then validate again.
  st.phase = "building";
  st.results = `VALIDATION FAILED (fix attempt ${st.fixAttempts}/${MAX_FIX_ATTEMPTS}). Fix exactly these problems with targeted edits, then set done:\n${issues.map((i) => `- ${i}`).join("\n")}`;
  st.round = Math.min(st.round ?? 0, MAX_ROUNDS - 2);
  await phase(c, "building");
  return { done: false, delayMs: 10 };
}

export const agentHandler: TaskHandler = {
  maxRetries: 3,
  async step(c) {
    const pid = c.task.project_id;
    if (!pid) throw new FatalError("A project is required");
    const p = c.payload as P;
    const st = c.state as State;
    if (!st.phase) {
      if (!p.prompt) throw new FatalError("A prompt is required");
      const fs = await import("../../sandbox/fs.server");
      st.baseRevision = await fs.ensureProject(c.task.user_id, pid);
      const um = await saveMessage(c, "user", p.prompt);
      await c.emit("run.start", { prompt: p.prompt.slice(0, 500), messageId: um.id, clientMessageId: p.clientMessageId ?? null, revision: st.baseRevision });
      st.phase = "planning";
      const ar = await AgentRun.for(c);
      await ar.start({ projectId: pid, userId: c.task.user_id, taskText: p.prompt, parentRunId: p.parentRunId ?? null, metadata: { model: p.model ?? "speed", depth: p.depth ?? "balanced" } });
      const { analyzeTask, groupTasks } = await import("../../agent/grouping");
      const tasks = analyzeTask(p.prompt); const batches = groupTasks(tasks);
      const aid = await ar.step({ type: "analyze", name: "Analyze and group task", metadata: { tasks, batches } });
      const batchSteps: Record<string, string> = {};
      for (const b of batches) batchSteps[b.id] = (await ar.step({ type: "batch", name: b.label || b.id, batchId: b.id, status: "pending", parentStepId: aid, metadata: { taskIds: b.taskIds, kind: b.kind, risk: b.risk } })) ?? "";
      await ar.finishStep(aid, { status: "succeeded" });
      st.ag = { tasks, batches, batchSteps };
      await ar.progress({ type: "plan", batches: batches.length, tasks: tasks.length }, aid);
      await ar.checkpoint({ stepId: aid, type: "stage", state: { phase: "planning", baseRevision: st.baseRevision }, completed: ["analyze"], pending: batches.map((b) => b.id), next: "planning" });
      await ar.stage("planning", "running");
    }
    switch (st.phase) {
      case "planning": return planStep(c, st, p);
      case "awaiting": return decisionStep(c, st);
      case "building": return buildStep(c, st, p);
      case "validating": return validateStep(c, st);
    }
  },
  async onCancel(c) {
    const st = c.state as State;
    await c.emit("phase", { phase: "cancelled" }).catch(() => undefined);
    await c.emit("run.end", { status: "stopped", mutated: !!st.mutated, revision: st.baseRevision ?? 0 });
    const ar = await AgentRun.for(c);
    for (const sid of Object.values(st.ag?.batchSteps ?? {})) await ar.finishStep(sid, { status: "cancelled" });
    await ar.checkpoint({ type: "stage", state: { phase: st.phase ?? "planning", round: st.round ?? 0, revision: st.baseRevision ?? 0 }, completed: st.changed ?? [], pending: (st.ag?.batches ?? []).map((b) => b.id), next: st.phase ?? "planning" });
    await ar.finish("cancelled", { failureReason: "Stopped by user" });
  },
};
