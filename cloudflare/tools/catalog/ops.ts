// Logs, security, cleanup, recovery, integrations and orchestration-control tools. All real reads/writes on
// D1 audit tables, the project file store, or the user's own provider connections.
import { defineTool } from "../registry";
import { z, ToolFailure, visible, remove, fetchJson, ASSET_EXT, TEXT_EXT, readPkg } from "./util";
import { SECRET_PATTERNS, redact } from "../policy";
import { validateProject, validateReferences } from "../../../sandbox/intelligence/validate";
import type { ToolEnv } from "../types";

const OP = z.string().regex(/^op_[\w-]+$/);
async function op(env: ToolEnv, id: string) {
  const { d1 } = await import("@backend/d1");
  const [r] = await d1<{ id: string; tool_name: string; status: string; args: string; result: string | null; error_code: string | null; error_message: string | null; revision_before: number | null; revision_after: number | null; created_at: string; completed_at: string | null }>(
    "SELECT id, tool_name, status, args, result, error_code, error_message, revision_before, revision_after, created_at, completed_at FROM tool_operations WHERE id = ? AND project_id = ? AND user_id = ?", [id, env.projectId, env.userId]);
  if (!r) throw new ToolFailure("INVALID_ARGUMENT", `Operation ${id} not found in this project`);
  return r;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- logs ----------------
const lg = (d: Parameters<typeof defineTool>[0]) => defineTool({ category: "logs", requiredPermissions: ["logs:read"], ...d });
export const logTools = [
  lg({
    name: "search_logs", description: "Search the operation log (tool name, error code or message).", capabilities: ["grep logs"],
    inputSchema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).default(30) }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1"); const q = `%${a.query.replace(/[%_]/g, "")}%`;
      return { data: { operations: await d1("SELECT id, tool_name, status, error_code, error_message, created_at FROM tool_operations WHERE project_id = ? AND user_id = ? AND (tool_name LIKE ? OR error_code LIKE ? OR error_message LIKE ?) ORDER BY created_at DESC LIMIT ?", [env.projectId, env.userId, q, q, q, a.limit]) } };
    },
  }),
  lg({
    name: "get_error_logs", description: "Recent failed operations and failed task events.", capabilities: ["errors", "failures"],
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      const ops = await d1("SELECT id, tool_name, error_code, error_message, created_at FROM tool_operations WHERE project_id = ? AND user_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT ?", [env.projectId, env.userId, a.limit]);
      const tasks = await d1("SELECT t.id, t.type, t.error, t.updated_at FROM tasks t WHERE t.project_id = ? AND t.user_id = ? AND t.status = 'failed' ORDER BY t.updated_at DESC LIMIT 5", [env.projectId, env.userId]).catch(() => []);
      return { data: { operations: ops, tasks } };
    },
  }),
  lg({
    name: "get_build_logs", description: "Build status/error history and recent runtime command jobs with their output.", capabilities: ["build output", "build error"],
    inputSchema: z.object({ limit: z.number().int().min(1).max(20).default(5) }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1"); const s = await env.settings();
      const jobs = await d1<{ id: string; kind: string; status: string; exit_code: number | null; output: string | null; created_at: string }>("SELECT id, kind, status, exit_code, output, created_at FROM runtime_jobs WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?", [env.projectId, env.userId, a.limit]);
      return { data: { lastBuild: { status: s["buildStatus"] ?? null, error: s["buildError"] || null, updatedAt: s["buildUpdatedAt"] ?? null }, jobs: jobs.map((j) => ({ ...j, output: j.output ? redact(j.output).slice(-4000) : null })) } };
    },
  }),
  lg({
    name: "get_activity_logs", description: "Recent agent task events (phases, actions, messages) for this project.", capabilities: ["activity", "timeline"],
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      return { data: { events: await d1("SELECT e.task_id, e.seq, e.kind, substr(e.data, 1, 400) AS data, e.created_at FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ? AND t.user_id = ? ORDER BY e.created_at DESC LIMIT ?", [env.projectId, env.userId, a.limit]) } };
    },
  }),
  lg({
    name: "clear_logs", description: "Delete completed operation-log rows older than N days for this project.", destructive: true, requiredPermissions: ["logs:write"],
    inputSchema: z.object({ olderThanDays: z.number().int().min(1).max(365).default(30) }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      const r = await d1("DELETE FROM tool_operations WHERE project_id = ? AND user_id = ? AND status != 'running' AND created_at < datetime('now', ?) RETURNING id", [env.projectId, env.userId, `-${a.olderThanDays} days`]);
      return { data: { deleted: r.length }, stateChanges: [{ kind: "log", target: "tool_operations", detail: `cleared ${r.length}` }] };
    },
  }),
];

// ---------------- security ----------------
const sec = (d: Parameters<typeof defineTool>[0]) => defineTool({ category: "security", ...d });
const RISKY: { name: string; re: RegExp; severity: "high" | "medium" | "low" }[] = [
  { name: "eval / new Function", re: /\beval\s*\(|new\s+Function\s*\(/g, severity: "high" },
  { name: "dangerouslySetInnerHTML", re: /dangerouslySetInnerHTML/g, severity: "medium" },
  { name: "innerHTML assignment", re: /\.innerHTML\s*=(?!=)/g, severity: "medium" },
  { name: "document.write", re: /document\.write\s*\(/g, severity: "medium" },
  { name: "insecure http resource", re: /(?:src|href)=["']http:\/\/(?!localhost)/g, severity: "medium" },
  { name: "target=_blank without rel=noopener", re: /target=["']_blank["'](?![^>]*rel=["'][^"']*noopener)/g, severity: "low" },
  { name: "secret in localStorage", re: /localStorage\.setItem\(\s*["'][^"']*(token|secret|password|key)/gi, severity: "medium" },
];
const lineOf = (text: string, idx: number) => text.slice(0, idx).split("\n").length;
export const securityTools = [
  sec({
    name: "scan_secrets", description: "Scan project files for leaked credentials (API keys, tokens, private keys).", capabilities: ["leaked keys", "credentials"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const findings: { file: string; line: number; type: string }[] = [];
      for (const f of visible(await env.files())) {
        if (f.encoding !== "utf8" || !TEXT_EXT.test(f.path)) continue;
        for (const p of SECRET_PATTERNS) for (const m of f.content.matchAll(new RegExp(p.re.source, "g"))) { findings.push({ file: f.path, line: lineOf(f.content, m.index ?? 0), type: p.name }); if (findings.length > 100) break; }
      }
      return { data: { findings, clean: !findings.length }, next: findings.length ? "set_env_var" : null };
    },
  }),
  sec({
    name: "check_security_issues", description: "Static check for risky code patterns (eval, innerHTML, insecure resources, unsafe links).", capabilities: ["xss", "security audit"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const out: { file: string; line: number; issue: string; severity: string }[] = [];
      for (const f of visible(await env.files())) {
        if (f.encoding !== "utf8" || !/\.(html?|jsx?|tsx?|mjs|vue|svelte)$/.test(f.path)) continue;
        for (const r of RISKY) for (const m of f.content.matchAll(new RegExp(r.re.source, r.re.flags))) out.push({ file: f.path, line: lineOf(f.content, m.index ?? 0), issue: r.name, severity: r.severity });
      }
      return { data: { issues: out.slice(0, 150), high: out.filter((x) => x.severity === "high").length } };
    },
  }),
  sec({
    name: "check_config_files", description: "Check configs for unsafe settings: install scripts, missing .gitignore entries, wildcard versions.", capabilities: ["config audit"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const s = await env.files(); const issues: string[] = [];
      const pkg = readPkg(s, false);
      for (const k of ["preinstall", "install", "postinstall", "prepare"]) if (pkg?.scripts?.[k]) issues.push(`package.json has a "${k}" script — it runs on install: ${pkg.scripts[k]}`);
      for (const [n, v] of Object.entries({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) })) if (v === "*" || v === "latest" || /^(git|https?):/.test(v)) issues.push(`${n} uses an unpinned/remote version "${v}"`);
      const gi = s.get(".gitignore")?.content ?? "";
      if (pkg) for (const need of ["node_modules", ".env"]) if (!gi.includes(need)) issues.push(`.gitignore does not ignore ${need}`);
      return { data: { issues, ok: !issues.length } };
    },
  }),
  sec({
    name: "validate_paths", description: "Find broken internal references and unsafe paths in the project.", capabilities: ["broken links", "missing files"],
    inputSchema: z.object({}),
    handler: async (_a, env) => { const r = validateReferences(await env.files()); return { data: { errors: r.filter((d) => d.severity === "error").slice(0, 60), warnings: r.filter((d) => d.severity === "warning").slice(0, 30) } }; },
  }),
];

// ---------------- cleanup ----------------
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|npm-debug\.log.*|yarn-error\.log|.*\.tmp|.*\.bak|.*~)$/i;
const cl = (d: Parameters<typeof defineTool>[0]) => defineTool({ category: "cleanup", ...d });
export const cleanupTools = [
  cl({
    name: "cleanup_workspace", description: "Remove junk files (.DS_Store, *.tmp, *.bak, debug logs) and empty folders.", readOnly: false, capabilities: ["clean up", "remove temp files"],
    inputSchema: z.object({ dryRun: z.boolean().default(false) }),
    handler: async (a, env) => {
      const s = await env.files();
      const junk = s.list().filter((f) => JUNK.test(f.path)).map((f) => f.path);
      const used = new Set(s.list().flatMap((f) => { const parts = f.path.split("/"); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/")); }));
      const empty = s.folders().filter((d) => !used.has(d) && !s.folders().some((o) => o.startsWith(`${d}/`)));
      if (!a.dryRun) { for (const p of junk) remove(env, s, p); for (const d of empty) { s.removeFolder(d); env.markDirty(d); } }
      return { data: { files: junk, emptyFolders: empty, dryRun: a.dryRun }, stateChanges: a.dryRun ? [] : junk.map((p) => ({ kind: "file" as const, target: p, detail: "removed" })) };
    },
  }),
  cl({
    name: "find_unused_assets", description: "Images/fonts/media in the project that no file references.", capabilities: ["unused images"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const s = await env.files(); const text = s.list().filter((f) => f.encoding === "utf8" && !ASSET_EXT.test(f.path)).map((f) => f.content).join("\n");
      const unused = s.list().filter((f) => ASSET_EXT.test(f.path) && !/favicon|robots|manifest/i.test(f.path) && !text.includes(f.path.split("/").pop()!)).map((f) => ({ path: f.path, bytes: f.content.length }));
      return { data: { unused }, next: unused.length ? "remove_unused_assets" : null };
    },
  }),
  cl({
    name: "remove_unused_assets", description: "Delete the asset files that nothing references.", destructive: true, requiredPermissions: ["project:delete"],
    inputSchema: z.object({ paths: z.array(z.string().max(400)).max(200).optional() }),
    handler: async (a, env) => {
      const r = await env.run("find_unused_assets", {});
      const unused = ((r.data as { unused?: { path: string }[] } | null)?.unused ?? []).map((x) => x.path).filter((p) => !a.paths || a.paths.includes(p));
      const s = await env.files(); for (const p of unused) remove(env, s, p);
      return { data: { removed: unused }, stateChanges: unused.map((p) => ({ kind: "file" as const, target: p, detail: "removed" })) };
    },
  }),
];

// ---------------- recovery ----------------
const rc = (d: Parameters<typeof defineTool>[0]) => defineTool({ category: "recovery", ...d });
export const recoveryTools = [
  rc({
    name: "analyze_build_failure", description: "Explain the latest failed build: error text, likely file/line and matching project errors.", capabilities: ["why did build fail"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const { d1 } = await import("@backend/d1"); const s = await env.settings();
      const [job] = await d1<{ kind: string; output: string | null; diagnostics: string | null }>("SELECT kind, output, diagnostics FROM runtime_jobs WHERE project_id = ? AND user_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1", [env.projectId, env.userId]);
      const text = String(s["buildError"] || job?.output || "");
      const refs = [...text.matchAll(/([\w./-]+\.(?:tsx?|jsx?|css|html|json))[:(](\d+)/g)].slice(0, 10).map((m) => ({ file: m[1], line: Number(m[2]) }));
      const v = validateProject(await env.files());
      return { data: { buildStatus: s["buildStatus"] ?? null, error: redact(text).slice(-4000) || null, locations: refs, diagnostics: job?.diagnostics ? JSON.parse(job.diagnostics) : [], projectErrors: v.errors.slice(0, 15) }, next: refs.length || v.errors.length ? "read_file" : null };
    },
  }),
  rc({
    name: "retry_operation", description: "Re-run a previous (failed or cancelled) operation with the same arguments.", readOnly: false, requiredPermissions: ["orchestrate"],
    inputSchema: z.object({ operationId: OP }),
    handler: async (a, env) => {
      const o = await op(env, a.operationId);
      if (o.status === "running") throw new ToolFailure("CONFLICT", "Operation is still running", false, undefined, "wait_for_operation");
      const r = await env.run(o.tool_name, JSON.parse(o.args) as Record<string, unknown>);
      if (!r.success) throw new ToolFailure(r.error!.code, r.error!.message, r.error!.retryable);
      return { data: { retriedFrom: o.id, operationId: r.operationId, result: r.data }, stateChanges: r.stateChanges };
    },
  }),
  rc({
    name: "rollback_operation", description: "Undo a file-changing operation by restoring the revision from before it ran.", destructive: true, requiredPermissions: ["project:write"],
    inputSchema: z.object({ operationId: OP }),
    handler: async (a, env) => {
      const o = await op(env, a.operationId);
      if (o.revision_before === null) throw new ToolFailure("INVALID_ARGUMENT", "That operation did not record a revision — use list_revisions + rollback_to_revision");
      const r = await env.run("rollback_to_revision", { revision: o.revision_before, confirm: true });
      if (!r.success) throw new ToolFailure(r.error!.code, r.error!.message);
      return { data: { operationId: o.id, restoredRevision: o.revision_before }, stateChanges: r.stateChanges, next: "verify_project" };
    },
  }),
  rc({
    name: "restore_previous_version", description: "Restore the project to the revision before the latest one.", destructive: true, requiredPermissions: ["project:write"], capabilities: ["undo last change"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      await env.commit("Before restore");
      const cur = await env.revision(); if (cur <= 1) throw new ToolFailure("INVALID_ARGUMENT", "There is no previous version");
      const r = await env.run("rollback_to_revision", { revision: cur - 1, confirm: true });
      if (!r.success) throw new ToolFailure(r.error!.code, r.error!.message);
      return { data: { from: cur, to: cur - 1 }, stateChanges: r.stateChanges, next: "verify_project" };
    },
  }),
  rc({
    name: "recover_project", description: "Restore the newest revision that passes project validation, searching back up to 20 revisions.", destructive: true, requiredPermissions: ["project:write"], timeoutMs: 60_000, capabilities: ["project broken", "recover"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      if (!validateProject(await env.files()).errors.length) return { data: { recovered: false, reason: "Current version already validates" } };
      await env.commit("Before recovery");
      const { listRevisions, rollbackTo } = await import("../../sandbox/fs.server");
      const revs = (await listRevisions(env.projectId, 21)).map((r) => r.revision);
      const cur = revs[0] ?? 0;
      // rollbackTo always reconstructs the exact state at `target` (it reverts every later revision, including earlier probes).
      for (const target of revs.slice(1)) {
        const r = await rollbackTo(env.projectId, target, { taskId: env.taskId });
        env.invalidate();
        if (!validateProject(await env.files()).errors.length) return { data: { recovered: true, restoredRevision: target, newRevision: r.revision }, stateChanges: [{ kind: "revision", target: String(target), detail: "recovered" }] };
      }
      await rollbackTo(env.projectId, cur, { taskId: env.taskId }).catch(() => undefined);
      env.invalidate();
      throw new ToolFailure("UNKNOWN_ERROR", `No valid revision found in the last ${revs.length} (current ${cur})`, false, undefined, "diagnose_failure");
    },
  }),
];

// ---------------- integrations ----------------
const ig = (d: Parameters<typeof defineTool>[0]) => defineTool({ category: "integrations", requiredPermissions: ["integration:read"], projectScoped: false, ...d });
export const integrationTools = [
  ig({
    name: "list_integrations", description: "Connected accounts (GitHub, Google, Supabase…) and their status; never returns tokens.", capabilities: ["connections", "connected services"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const { listConnections } = await import("@security/connections.server");
      const { githubStatus } = await import("@security/github.server");
      const conns = (await listConnections(env.userId)).map((c) => ({ id: c.id, integration: c.integration, provider: c.provider, account: c.account_label, status: c.status, lastUsedAt: c.last_used_at }));
      const gh = await githubStatus(env.userId).catch(() => null);
      return { data: { github: gh, connections: conns } };
    },
  }),
  ig({
    name: "test_integration", description: "Make a real authenticated call to a connected service to verify the connection works.", requiredPermissions: ["integration:read", "network:fetch"], capabilities: ["check connection"],
    inputSchema: z.object({ integration: z.string().min(2).max(40), id: z.string().max(80).optional() }),
    handler: async (a, env) => {
      if (a.integration === "github") {
        const { getGithubAccessToken } = await import("@security/github.server");
        const t = await getGithubAccessToken(env.userId).catch(() => { throw new ToolFailure("INTEGRATION_FAILED", "GitHub is not connected", false, undefined, "connect_integration"); });
        const r = await fetchJson<{ login?: string }>("https://api.github.com/user", { headers: { authorization: `Bearer ${t}`, "user-agent": "speed-agent" } }, env);
        if (r.status !== 200) throw new ToolFailure("INTEGRATION_FAILED", `GitHub returned ${r.status}`);
        return { data: { integration: "github", ok: true, account: r.body.login, latencyMs: r.ms } };
      }
      const { listConnections, withToken } = await import("@security/connections.server");
      const c = (await listConnections(env.userId)).find((x) => x.integration === a.integration && (!a.id || x.id === a.id));
      if (!c) throw new ToolFailure("INTEGRATION_FAILED", `${a.integration} is not connected`, false, undefined, "connect_integration");
      const PROBE: Record<string, string> = { google: "https://www.googleapis.com/oauth2/v3/userinfo", drive: "https://www.googleapis.com/drive/v3/about?fields=user", supabase: "https://api.supabase.com/v1/projects", gitlab: "https://gitlab.com/api/v4/user", bitbucket: "https://api.bitbucket.org/2.0/user" };
      const url = PROBE[c.integration] ?? PROBE[c.provider];
      if (!url) throw new ToolFailure("INTEGRATION_FAILED", `No health probe for ${c.integration}`);
      const r = await withToken(c, (t) => fetchJson<unknown>(url, { headers: { authorization: `Bearer ${t}` } }, env));
      return { data: { integration: c.integration, ok: r.status < 400, status: r.status, latencyMs: r.ms } };
    },
  }),
];

// ---------------- orchestration control ----------------
const oc = (d: Parameters<typeof defineTool>[0]) => defineTool({ category: "orchestration", requiredPermissions: ["orchestrate"], ...d });
const CALL = z.object({ tool: z.string().min(2).max(60), args: z.record(z.string(), z.unknown()).default({}) });
export const orchestrationTools = [
  oc({
    name: "execute_parallel", description: "Run independent read-only tools in parallel (write tools are run in order automatically).", readOnly: true, timeoutMs: 120_000,
    inputSchema: z.object({ calls: z.array(CALL).min(1).max(10) }),
    handler: async (a, env) => { const out = await Promise.all(a.calls.map((c) => env.run(c.tool, c.args))); return { data: { results: out.map((r) => ({ tool: r.toolName, operationId: r.operationId, success: r.success, data: r.data, error: r.error })) } }; },
  }),
  oc({
    name: "execute_sequence", description: "Run dependent tools in order, stopping at the first failure.", readOnly: false, timeoutMs: 180_000,
    inputSchema: z.object({ calls: z.array(CALL).min(1).max(15), stopOnError: z.boolean().default(true) }),
    handler: async (a, env) => {
      const out = [];
      for (const c of a.calls) { const r = await env.run(c.tool, c.args); out.push({ tool: r.toolName, operationId: r.operationId, success: r.success, data: r.data, error: r.error }); if (!r.success && a.stopOnError) break; }
      return { data: { results: out, completed: out.every((r) => r.success) && out.length === a.calls.length } };
    },
  }),
  oc({
    name: "get_operation_status", description: "Status and result of one operation by id.",
    inputSchema: z.object({ operationId: OP }),
    handler: async (a, env) => { const o = await op(env, a.operationId); return { data: { ...o, args: undefined, result: o.result ? JSON.parse(o.result) : null } }; },
  }),
  oc({
    name: "wait_for_operation", description: "Wait (up to 25 s) until an operation or runtime job finishes; returns its status.", timeoutMs: 30_000,
    inputSchema: z.object({ operationId: OP.optional(), jobId: z.string().regex(/^job_[\w-]+$/).optional(), timeoutMs: z.number().int().min(1000).max(25_000).default(20_000) }),
    handler: async (a, env) => {
      if (!a.operationId && !a.jobId) throw new ToolFailure("INVALID_ARGUMENT", "operationId or jobId is required");
      const { d1 } = await import("@backend/d1");
      const t0 = Date.now();
      for (;;) {
        const status = a.jobId
          ? (await d1<{ status: string }>("SELECT status FROM runtime_jobs WHERE id = ? AND project_id = ? AND user_id = ?", [a.jobId, env.projectId, env.userId]))[0]?.status
          : (await op(env, a.operationId!)).status;
        if (!status) throw new ToolFailure("INVALID_ARGUMENT", "Not found");
        if (!["running", "queued"].includes(status)) return { data: { status, waitedMs: Date.now() - t0 }, next: a.jobId ? "get_command_result" : "get_operation_status" };
        if (Date.now() - t0 > a.timeoutMs || env.signal.aborted) return { data: { status, waitedMs: Date.now() - t0, stillRunning: true }, next: "wait_for_operation" };
        await sleep(2000);
      }
    },
  }),
  oc({
    name: "cancel_operation", description: "Request cancellation of a running operation.", readOnly: false,
    inputSchema: z.object({ operationId: OP }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      const r = await d1("UPDATE tool_operations SET cancel_requested = 1 WHERE id = ? AND project_id = ? AND user_id = ? AND status = 'running' RETURNING id", [a.operationId, env.projectId, env.userId]);
      return { data: { requested: r.length > 0 } };
    },
  }),
  oc({
    name: "verify_operation", description: "Check that an operation's recorded file changes are present in the current project.",
    inputSchema: z.object({ operationId: OP }),
    handler: async (a, env) => {
      const o = await op(env, a.operationId);
      const res = o.result ? (JSON.parse(o.result) as { path?: string; from?: string; to?: string } | null) : null;
      const s = await env.files();
      const path = res?.to ?? res?.path;
      const present = path ? !!s.get(path) || s.folders().includes(path) : null;
      return { data: { operationId: o.id, tool: o.tool_name, status: o.status, verified: o.status === "completed" && present !== false, path: path ?? null, present } };
    },
  }),
];
