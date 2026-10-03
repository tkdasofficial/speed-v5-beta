// State/history, snapshots, planning and agent-knowledge tools — all persisted in D1 (main + sandbox revisions).
import { defineTool, group } from "../registry";
import { z, ToolFailure, detect } from "./util";

const SAFE_META = ["description", "title", "icon", "language", "notes", "framework", "gitBranch"] as const;
const st = group({ category: "state" });

export const stateTools = [
  st({
    name: "get_change_history", description: "Per-file change history from saved revisions (newest first).", capabilities: ["history", "what changed", "changelog"],
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50), path: z.string().max(400).optional() }),
    handler: async (a, env) => { const { revisionChanges } = await import("../../sandbox/fs.server"); return { data: { changes: await revisionChanges(env.projectId, { limit: a.limit, ...(a.path ? { path: a.path } : {}) }) } }; },
  }),
  st({
    name: "get_build_state", description: "Last build: status, source hash, error, timestamps, preview availability.", capabilities: ["last build", "build state"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const s = await env.settings();
      const pick = (k: string) => s[k] ?? null;
      return { data: { status: pick("buildStatus"), buildId: pick("buildId"), sourceHash: pick("sourceHash"), pendingSourceHash: pick("pendingSourceHash"), error: pick("buildError") || null, updatedAt: pick("buildUpdatedAt"), projectType: pick("projectType"), hasPreview: !!s["staticFileId"] } };
    },
  }),
  st({
    name: "get_project_metadata", description: "Project name, slug, created/updated time, detected stack and editable metadata.", capabilities: ["project info"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const { d1 } = await import("@backend/d1");
      const [p] = await d1<{ name: string; slug: string; created_at: string; updated_at: string }>("SELECT name, slug, created_at, updated_at FROM projects WHERE id = ? AND user_id = ?", [env.projectId, env.userId]);
      if (!p) throw new ToolFailure("PROJECT_NOT_FOUND", "Project not found");
      const s = await env.settings(); const d = detect(await env.files());
      return { data: { ...p, revision: await env.revision(), framework: d.framework, language: d.language, files: d.paths.length, metadata: Object.fromEntries(SAFE_META.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])) } };
    },
  }),
  st({
    name: "update_project_metadata", description: `Update editable project metadata (${SAFE_META.join(", ")}).`, readOnly: false,
    inputSchema: z.object({ description: z.string().max(500).optional(), title: z.string().max(120).optional(), icon: z.string().max(200).optional(), language: z.string().max(40).optional(), notes: z.string().max(2000).optional() }),
    handler: async (a, env) => {
      const p = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as Record<string, string>;
      if (!Object.keys(p).length) throw new ToolFailure("INVALID_ARGUMENT", "Nothing to update");
      await env.patchSettings(p);
      return { data: { updated: Object.keys(p) }, stateChanges: [{ kind: "settings", target: "metadata" }] };
    },
  }),
  defineTool({
    name: "delete_snapshot", category: "snapshots", description: "Delete a saved snapshot bookmark (files are not changed).", destructive: true, requiredPermissions: ["project:write"],
    inputSchema: z.object({ id: z.string().regex(/^snap_[\w-]+$/) }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      const r = await d1("DELETE FROM tool_snapshots WHERE id = ? AND project_id = ? AND user_id = ? RETURNING id", [a.id, env.projectId, env.userId]);
      if (!r.length) throw new ToolFailure("FILE_NOT_FOUND", "Snapshot not found");
      return { data: { deleted: a.id }, stateChanges: [{ kind: "snapshot", target: a.id, detail: "deleted" }] };
    },
  }),
  defineTool({
    name: "compare_snapshots", category: "snapshots", description: "Files changed between two snapshots or revisions (or a snapshot and now).",
    inputSchema: z.object({ from: z.union([z.string().regex(/^snap_[\w-]+$/), z.number().int().min(0)]), to: z.union([z.string().regex(/^snap_[\w-]+$/), z.number().int().min(0)]).optional() }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      const rev = async (x: string | number) => { if (typeof x === "number") return x; const [s] = await d1<{ revision: number }>("SELECT revision FROM tool_snapshots WHERE id = ? AND project_id = ? AND user_id = ?", [x, env.projectId, env.userId]); if (!s) throw new ToolFailure("FILE_NOT_FOUND", `Snapshot ${x} not found`); return s.revision; };
      let from = await rev(a.from), to = a.to === undefined ? await env.revision() : await rev(a.to);
      if (from > to) [from, to] = [to, from];
      const { revisionChanges } = await import("../../sandbox/fs.server");
      const rows = await revisionChanges(env.projectId, { from, to, limit: 2000 });
      const files = new Map<string, Set<string>>();
      for (const r of rows) files.set(r.path, (files.get(r.path) ?? new Set()).add(r.op));
      return { data: { from, to, revisions: new Set(rows.map((r) => r.revision)).size, files: [...files].map(([path, ops]) => ({ path, ops: [...ops] })) } };
    },
  }),
];

// ---------------- planning ----------------
type PlanStep = { title: string; status: "pending" | "in_progress" | "done" | "skipped" | "failed"; note?: string };
const STEP_STATUS = z.enum(["pending", "in_progress", "done", "skipped", "failed"]);
async function activePlan(env: import("../types").ToolEnv, id?: string) {
  const { d1 } = await import("@backend/d1");
  const [p] = id
    ? await d1<{ id: string; title: string; steps: string; status: string; updated_at: string }>("SELECT id, title, steps, status, updated_at FROM agent_plans WHERE id = ? AND project_id = ? AND user_id = ?", [id, env.projectId, env.userId])
    : await d1<{ id: string; title: string; steps: string; status: string; updated_at: string }>("SELECT id, title, steps, status, updated_at FROM agent_plans WHERE project_id = ? AND user_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1", [env.projectId, env.userId]);
  if (!p) throw new ToolFailure("PREREQUISITE_FAILED", "No active plan", false, undefined, "create_plan");
  return { ...p, steps: JSON.parse(p.steps) as PlanStep[] };
}
async function savePlan(id: string, steps: PlanStep[], status?: string) {
  const { d1 } = await import("@backend/d1");
  const done = steps.every((s) => s.status === "done" || s.status === "skipped");
  await d1("UPDATE agent_plans SET steps = ?, status = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(steps), status ?? (done ? "completed" : "active"), id]);
  return done;
}
const progress = (steps: PlanStep[]) => ({ total: steps.length, done: steps.filter((s) => s.status === "done").length, next: steps.findIndex((s) => s.status === "pending" || s.status === "in_progress") });
const plan = group({ category: "planning", requiredPermissions: ["task:manage"] });

export const planningTools = [
  plan({
    name: "create_plan", description: "Create the working plan (ordered steps) for the current task; replaces the active plan.", readOnly: false, capabilities: ["plan", "todo list"],
    inputSchema: z.object({ title: z.string().min(1).max(200), steps: z.array(z.string().min(1).max(300)).min(1).max(40) }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      await d1("UPDATE agent_plans SET status = 'abandoned', updated_at = datetime('now') WHERE project_id = ? AND user_id = ? AND status = 'active'", [env.projectId, env.userId]);
      const id = `plan_${crypto.randomUUID()}`;
      const steps: PlanStep[] = a.steps.map((t) => ({ title: t, status: "pending" }));
      await d1("INSERT INTO agent_plans (id, project_id, user_id, task_id, title, steps) VALUES (?, ?, ?, ?, ?, ?)", [id, env.projectId, env.userId, env.taskId, a.title, JSON.stringify(steps)]);
      return { data: { id, title: a.title, steps }, stateChanges: [{ kind: "task", target: id, detail: "plan created" }] };
    },
  }),
  plan({
    name: "get_plan", description: "The active plan with step statuses and progress.", requiredPermissions: ["project:read"],
    inputSchema: z.object({ id: z.string().regex(/^plan_[\w-]+$/).optional() }),
    handler: async (a, env) => { const p = await activePlan(env, a.id); return { data: { id: p.id, title: p.title, status: p.status, steps: p.steps.map((s, i) => ({ index: i, ...s })), progress: progress(p.steps) } }; },
  }),
  plan({
    name: "update_plan_step", description: "Set a plan step's status (pending/in_progress/done/skipped/failed) and note.", readOnly: false, capabilities: ["mark step", "mark task complete"],
    inputSchema: z.object({ index: z.number().int().min(0), status: STEP_STATUS, note: z.string().max(500).optional() }),
    handler: async (a, env) => {
      const p = await activePlan(env);
      const s = p.steps[a.index]; if (!s) throw new ToolFailure("INVALID_ARGUMENT", `Plan has ${p.steps.length} steps`);
      s.status = a.status; if (a.note) s.note = a.note;
      const done = await savePlan(p.id, p.steps);
      return { data: { index: a.index, status: a.status, planCompleted: done, progress: progress(p.steps) }, stateChanges: [{ kind: "task", target: p.id, detail: `step ${a.index} ${a.status}` }] };
    },
  }),
  plan({
    name: "add_plan_step", description: "Insert a step into the active plan (at the end or at an index).", readOnly: false,
    inputSchema: z.object({ title: z.string().min(1).max(300), at: z.number().int().min(0).optional() }),
    handler: async (a, env) => {
      const p = await activePlan(env);
      if (p.steps.length >= 60) throw new ToolFailure("RESOURCE_LIMIT", "Plan already has 60 steps");
      p.steps.splice(a.at ?? p.steps.length, 0, { title: a.title, status: "pending" });
      await savePlan(p.id, p.steps);
      return { data: { steps: p.steps.length }, stateChanges: [{ kind: "task", target: p.id, detail: "step added" }] };
    },
  }),
  plan({
    name: "complete_plan", description: "Mark the active plan completed (remaining steps become skipped).", readOnly: false,
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const p = await activePlan(env);
      for (const s of p.steps) if (s.status === "pending" || s.status === "in_progress") s.status = "skipped";
      await savePlan(p.id, p.steps, "completed");
      return { data: { id: p.id, progress: progress(p.steps) }, stateChanges: [{ kind: "task", target: p.id, detail: "completed" }] };
    },
  }),
  plan({
    name: "get_task_progress", description: "Status of the current background task and recent tasks for this project.", requiredPermissions: ["project:read"], capabilities: ["task status"],
    inputSchema: z.object({ taskId: z.string().regex(/^[\w-]{3,80}$/).optional() }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      if (a.taskId) {
        const [t] = await d1<{ id: string; type: string; status: string; progress: number | null; error: string | null; created_at: string; updated_at: string }>("SELECT id, type, status, progress, error, created_at, updated_at FROM tasks WHERE id = ? AND project_id = ? AND user_id = ?", [a.taskId, env.projectId, env.userId]);
        if (!t) throw new ToolFailure("INVALID_ARGUMENT", "Task not found in this project");
        const events = await d1("SELECT seq, kind, substr(data, 1, 300) AS data, created_at FROM task_events WHERE task_id = ? ORDER BY seq DESC LIMIT 10", [t.id]);
        return { data: { task: t, recentEvents: events } };
      }
      const rows = await d1<{ id: string; type: string; status: string; progress: number | null; created_at: string }>("SELECT id, type, status, progress, created_at FROM tasks WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 10", [env.projectId, env.userId]);
      return { data: { current: rows.find((r) => r.id === env.taskId) ?? null, recent: rows } };
    },
  }),
];

// ---------------- knowledge ----------------
const kn = group({ category: "knowledge" });
const KIND = z.enum(["decision", "learning", "context"]);
export const knowledgeTools = [
  kn({
    name: "record_knowledge", description: "Remember a decision, learning or context fact about this project for later turns.", readOnly: false, requiredPermissions: ["project:write"], capabilities: ["remember", "record decision", "note"],
    inputSchema: z.object({ kind: KIND, content: z.string().min(3).max(2000) }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      const id = `kn_${crypto.randomUUID()}`;
      await d1("INSERT INTO agent_knowledge (id, project_id, kind, content) VALUES (?, ?, ?, ?)", [id, env.projectId, a.kind, a.content]);
      return { data: { id }, stateChanges: [{ kind: "knowledge", target: id, detail: a.kind }] };
    },
  }),
  kn({
    name: "search_knowledge", description: "Recall recorded decisions/learnings/context (optionally matching text).", capabilities: ["recall", "previous decisions"],
    inputSchema: z.object({ query: z.string().max(200).optional(), kind: KIND.optional(), limit: z.number().int().min(1).max(50).default(20) }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      const rows = await d1<{ id: string; kind: string; content: string; created_at: string }>(`SELECT id, kind, content, created_at FROM agent_knowledge WHERE project_id = ?${a.kind ? " AND kind = ?" : ""}${a.query ? " AND content LIKE ?" : ""} ORDER BY created_at DESC LIMIT ?`, [env.projectId, ...(a.kind ? [a.kind] : []), ...(a.query ? [`%${a.query.replace(/[%_]/g, "")}%`] : []), a.limit]);
      return { data: { items: rows } };
    },
  }),
  kn({
    name: "forget_knowledge", description: "Delete one recorded knowledge item.", destructive: true, requiredPermissions: ["project:write"],
    inputSchema: z.object({ id: z.string().regex(/^kn_[\w-]+$/) }),
    handler: async (a, env) => { const { d1 } = await import("@backend/d1"); const r = await d1("DELETE FROM agent_knowledge WHERE id = ? AND project_id = ? RETURNING id", [a.id, env.projectId]); if (!r.length) throw new ToolFailure("INVALID_ARGUMENT", "Not found"); return { data: { deleted: a.id } }; },
  }),
  kn({
    name: "get_previous_actions", description: "What tools the agent ran recently on this project, with outcomes.", requiredPermissions: ["logs:read"], capabilities: ["what did I do"],
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(30) }),
    handler: async (a, env) => { const { d1 } = await import("@backend/d1"); return { data: { actions: await d1("SELECT tool_name, status, error_code, task_id, created_at FROM tool_operations WHERE project_id = ? AND user_id = ? AND id != ? ORDER BY created_at DESC LIMIT ?", [env.projectId, env.userId, env.operationId, a.limit]) } }; },
  }),
  kn({
    name: "get_project_context", description: "One-call summary: stack, entry points, recent decisions and the active plan.", capabilities: ["context", "overview"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const { d1 } = await import("@backend/d1");
      const d = detect(await env.files());
      const know = await d1<{ kind: string; content: string }>("SELECT kind, content FROM agent_knowledge WHERE project_id = ? ORDER BY created_at DESC LIMIT 10", [env.projectId]);
      const [p] = await d1<{ title: string; steps: string }>("SELECT title, steps FROM agent_plans WHERE project_id = ? AND user_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1", [env.projectId, env.userId]);
      return { data: { framework: d.framework, language: d.language, buildSystem: d.buildSystem, entries: d.entries, files: d.paths.length, knowledge: know, plan: p ? { title: p.title, steps: JSON.parse(p.steps) } : null } };
    },
  }),
];
