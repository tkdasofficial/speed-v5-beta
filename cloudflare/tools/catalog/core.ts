// Build, preview, state, recovery, snapshots, logs and orchestration tools — backed by the existing pipeline,
// revision store and audit tables (no parallel systems).
import { defineTool, allTools, findToolsByCapability, getToolMetadata } from "../registry";
import { z, ToolFailure } from "./util";
import { validateProject } from "../../../sandbox/intelligence/validate";

export const coreTools = [
  defineTool({
    name: "run_production_build", category: "build", description: "Build the project with the real build pipeline (static → Drive; React+Vite → GitHub runtime → Drive).",
    readOnly: false, requiredPermissions: ["build:run"], prerequisites: ["has_files", "build_config"], timeoutMs: 60_000, capabilities: ["build", "compile", "npm run build"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      await env.commit("Before build");
      const { startBuild } = await import("../../functions/build/pipeline.server");
      try {
        const r = await startBuild(env.userId, env.projectId);
        return { data: r, stateChanges: [{ kind: "build", target: env.projectId, detail: r.status }], next: r.status === "ready" || r.status === "unchanged" ? "open_preview" : "get_build_status" };
      } catch (e) { throw new ToolFailure("BUILD_FAILED", (e as Error).message, false, undefined, "detect_errors"); }
    },
  }),
  defineTool({
    name: "get_build_status", category: "build", description: "Current build status, preview URL and last error.", capabilities: ["build progress"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const { stateOf } = await import("../../functions/build/pipeline.server");
      const r = stateOf((await env.settings()) as never, env.userId, env.projectId);
      return { data: r, next: r.status === "failed" ? "diagnose_failure" : null };
    },
  }),
  defineTool({
    name: "open_preview", category: "preview", description: "Open a temporary private preview session for the latest successful build.", readOnly: false, requiredPermissions: ["preview:manage"], prerequisites: ["verified_build"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const { openPreviewSession } = await import("../../functions/build/pipeline.server");
      const r = await openPreviewSession(env.userId, env.projectId);
      return { data: r, stateChanges: [{ kind: "preview", target: env.projectId, detail: "opened" }] };
    },
  }),
  defineTool({
    name: "verify_project", category: "verification", description: "Validate the whole project (syntax, references, imports/exports, entry point).", capabilities: ["check", "test", "validate"],
    inputSchema: z.object({}),
    handler: async (_a, env) => { const v = validateProject(await env.files()); return { data: { ok: !v.errors.length, errors: v.errors.slice(0, 40), warnings: v.warnings.slice(0, 20) }, next: v.errors.length ? "detect_errors" : "run_production_build" }; },
  }),
  defineTool({
    name: "get_project_state", category: "state", description: "Revision, pending changes and project settings.",
    inputSchema: z.object({}),
    handler: async (_a, env) => { const st = await env.settings(); const safe = Object.fromEntries(Object.entries(st).filter(([k]) => !/token|secret|key/i.test(k))); return { data: { revision: await env.revision(), settings: safe } }; },
  }),
  defineTool({
    name: "save_changes", category: "state", description: "Commit pending file changes as one revision.", readOnly: false, capabilities: ["commit", "persist"],
    inputSchema: z.object({ label: z.string().min(1).max(80).default("Agent changes") }),
    handler: async (a, env) => { const r = await env.commit(a.label); return { data: r, stateChanges: r.changed.length ? [{ kind: "revision", target: String(r.revision) }] : [] }; },
  }),
  defineTool({
    name: "list_revisions", category: "recovery", description: "Recent saved revisions of the project.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    handler: async (a, env) => { const { listRevisions } = await import("../../sandbox/fs.server"); return { data: { revisions: await listRevisions(env.projectId, a.limit) } }; },
  }),
  defineTool({
    name: "rollback_to_revision", category: "recovery", description: "Restore the project files to an earlier revision (saved as a new revision).", destructive: true, requiredPermissions: ["project:write"], capabilities: ["undo", "revert", "restore"],
    inputSchema: z.object({ revision: z.number().int().min(0) }),
    handler: async (a, env) => {
      await env.commit("Before rollback");
      const { rollbackTo } = await import("../../sandbox/fs.server");
      const r = await rollbackTo(env.projectId, a.revision, { taskId: env.taskId });
      env.invalidate();
      return { data: r, stateChanges: [{ kind: "revision", target: String(a.revision), detail: "rolled back" }], next: "verify_project" };
    },
  }),
  defineTool({
    name: "create_snapshot", category: "snapshots", description: "Bookmark the current revision under a label.", readOnly: false,
    inputSchema: z.object({ label: z.string().min(1).max(80) }),
    handler: async (a, env) => {
      const { revision } = await env.commit(`Snapshot: ${a.label}`);
      const { d1 } = await import("@backend/d1");
      const id = `snap_${crypto.randomUUID()}`;
      await d1("INSERT INTO tool_snapshots (id, project_id, user_id, revision, label) VALUES (?, ?, ?, ?, ?)", [id, env.projectId, env.userId, revision, a.label]);
      return { data: { id, revision, label: a.label }, stateChanges: [{ kind: "snapshot", target: id }] };
    },
  }),
  defineTool({
    name: "list_snapshots", category: "snapshots", description: "List saved snapshots.",
    inputSchema: z.object({}),
    handler: async (_a, env) => { const { d1 } = await import("@backend/d1"); return { data: { snapshots: await d1("SELECT id, revision, label, created_at FROM tool_snapshots WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50", [env.projectId, env.userId]) } }; },
  }),
  defineTool({
    name: "restore_snapshot", category: "snapshots", description: "Restore the project to a saved snapshot.", destructive: true, requiredPermissions: ["project:write"],
    inputSchema: z.object({ id: z.string().regex(/^snap_[\w-]+$/) }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      const [s] = await d1<{ revision: number }>("SELECT revision FROM tool_snapshots WHERE id = ? AND project_id = ? AND user_id = ?", [a.id, env.projectId, env.userId]);
      if (!s) throw new ToolFailure("FILE_NOT_FOUND", "Snapshot not found");
      const r = await env.run("rollback_to_revision", { revision: s.revision, confirm: true });
      if (!r.success) throw new ToolFailure(r.error!.code, r.error!.message);
      return { data: r.data, stateChanges: r.stateChanges };
    },
  }),
  defineTool({
    name: "get_operation_logs", category: "logs", description: "Recent tool operations (audit log) for this project.", requiredPermissions: ["logs:read"],
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(30), failedOnly: z.boolean().default(false), includeResults: z.boolean().default(false), tool: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/).optional() }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      const p: unknown[] = [env.projectId, env.userId]; if (a.tool) p.push(a.tool); p.push(a.limit);
      const rows = await d1<Record<string, unknown> & { result?: string | null }>(`SELECT id, parent_id, tool_name, status, error_code, error_message, attempts, duration_ms, created_at${a.includeResults ? ", result" : ""} FROM tool_operations WHERE project_id = ? AND user_id = ? ${a.failedOnly ? "AND status = 'failed'" : ""} ${a.tool ? "AND tool_name = ?" : ""} ORDER BY created_at DESC LIMIT ?`, p);
      const { redact } = await import("../policy");
      return { data: { operations: a.includeResults ? rows.map((r) => ({ ...r, result: r.result ? (() => { try { return JSON.parse(redact(String(r.result)).slice(0, 4000)); } catch { return redact(String(r.result)).slice(0, 4000); } })() : null })) : rows } };
    },
  }),
  defineTool({
    name: "diagnose_failure", category: "recovery", description: "Collect evidence for the latest failure: recent failed operations, build error and current project errors.",
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const { d1 } = await import("@backend/d1");
      const failed = await d1<{ tool_name: string; error_code: string; error_message: string }>("SELECT tool_name, error_code, error_message FROM tool_operations WHERE project_id = ? AND user_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 5", [env.projectId, env.userId]);
      const v = validateProject(await env.files());
      const st = await env.settings();
      const cause = v.errors[0] ? `${v.errors[0].file}:${v.errors[0].line} ${v.errors[0].message}` : failed[0] ? `${failed[0].tool_name}: ${failed[0].error_message}` : null;
      return { data: { likelyCause: cause, projectErrors: v.errors.slice(0, 10), recentFailures: failed, lastBuildError: st["buildError"] ?? null }, next: v.errors.length ? "update_file" : null };
    },
  }),
  defineTool({
    name: "find_tools", category: "orchestration", description: "Find tools for a capability (the agent asks for what it needs).", projectScoped: false, requiredPermissions: ["orchestrate"],
    inputSchema: z.object({ capability: z.string().min(2).max(200), limit: z.number().int().min(1).max(20).default(8) }),
    handler: async (a, env) => ({ data: { tools: findToolsByCapability(a.capability, { limit: a.limit, readOnly: env.readOnly }) } }),
  }),
  defineTool({
    name: "describe_tool", category: "orchestration", description: "Full metadata and argument schema of a tool.", projectScoped: false, requiredPermissions: ["orchestrate"],
    inputSchema: z.object({ name: z.string().min(2).max(60) }),
    handler: async (a) => { const m = getToolMetadata(a.name); if (!m) throw new ToolFailure("UNKNOWN_TOOL", `No tool named ${a.name}`, false, undefined, "find_tools"); return { data: m }; },
  }),
  defineTool({
    name: "list_tool_categories", category: "orchestration", description: "Tool categories with counts.", projectScoped: false, requiredPermissions: ["orchestrate"],
    inputSchema: z.object({}),
    handler: async () => { const c: Record<string, number> = {}; for (const t of allTools()) c[t.category] = (c[t.category] ?? 0) + 1; return { data: { categories: c, total: allTools().length } }; },
  }),
];
