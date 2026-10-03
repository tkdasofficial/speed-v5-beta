// Runtime command jobs: install / build / typecheck / lint / test / format / script, executed for real in a throwaway
// GitHub Actions workspace (tkdasofficial/speed-runtime, workflow run.yml). The Worker never runs a shell.
//   startJob → runtime_jobs row (single-use token hash) → workflow_dispatch
//   runtime GETs /runtime/job/{id}/source → runs one fixed command → POSTs /runtime/job/{id}/result
//   acceptJob stores exit code, output, diagnostics; formatter output is applied as one project revision.
import { envStr } from "../context";
import { d1 } from "../d1";
import { apiOrigin, RUNTIME_REPO } from "./pipeline.server";
import { IGNORED } from "./hash";

export const JOB_KINDS = ["install", "build", "typecheck", "lint", "test", "format", "script"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
const WORKFLOW = "run.yml";
const TTL_MS = 20 * 60_000;

export class JobError extends Error { constructor(msg: string, public status = 400) { super(msg); } }
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const token = () => [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");

export type JobRow = { id: string; project_id: string; user_id: string; kind: JobKind; script: string | null; status: string; exit_code: number | null; output: string | null; diagnostics: string | null; files: string | null; created_at: string; completed_at: string | null; expires_at: number; token_hash: string };

export async function startJob(userId: string, projectId: string, kind: JobKind, o: { script?: string; operationId?: string | null } = {}) {
  if (!JOB_KINDS.includes(kind)) throw new JobError(`Unknown job ${kind}`);
  if (kind === "script" && !/^[a-z0-9:_-]{1,60}$/i.test(o.script ?? "")) throw new JobError("Invalid script name");
  const [busy] = await d1<{ id: string }>("SELECT id FROM runtime_jobs WHERE project_id = ? AND status IN ('queued','running') AND expires_at > ? LIMIT 1", [projectId, Date.now()]);
  if (busy) throw new JobError(`Another command (${busy.id}) is still running for this project`, 409);
  const pat = envStr("GITHUB_PAT");
  if (!pat) throw new JobError("Command runtime is not configured", 503);
  const id = `job_${Date.now().toString(36)}${token().slice(0, 10)}`;
  const t = token();
  await d1("INSERT INTO runtime_jobs (id, project_id, user_id, operation_id, kind, script, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, projectId, userId, o.operationId ?? null, kind, o.script ?? null, await sha256(t), Date.now() + TTL_MS]);
  const res = await fetch(`https://api.github.com/repos/${RUNTIME_REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "speed-api", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { job_id: id, project_id: projectId, api_url: apiOrigin(), token: t } }),
  });
  if (!res.ok) {
    const msg = `Could not start the command runtime (${res.status})`;
    console.error(`[jobs] dispatch ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await d1("UPDATE runtime_jobs SET status = 'failed', output = ?, token_hash = '', completed_at = datetime('now') WHERE id = ?", [msg, id]);
    throw new JobError(msg, 502);
  }
  return { jobId: id, status: "queued" as const, kind };
}

export async function getJob(userId: string, projectId: string, id: string) {
  const [r] = await d1<JobRow>("SELECT * FROM runtime_jobs WHERE id = ? AND project_id = ? AND user_id = ?", [id, projectId, userId]);
  if (!r) return null;
  if ((r.status === "queued" || r.status === "running") && r.expires_at < Date.now()) {
    await d1("UPDATE runtime_jobs SET status = 'expired', token_hash = '', completed_at = datetime('now') WHERE id = ? AND status IN ('queued','running')", [id]);
    r.status = "expired";
  }
  return { id: r.id, kind: r.kind, script: r.script, status: r.status, exitCode: r.exit_code, output: r.output, diagnostics: r.diagnostics ? (JSON.parse(r.diagnostics) as unknown[]) : [], changedFiles: r.files ? (JSON.parse(r.files) as string[]) : [], createdAt: r.created_at, completedAt: r.completed_at };
}

async function authorize(req: Request, id: string) {
  const [r] = await d1<JobRow>("SELECT * FROM runtime_jobs WHERE id = ?", [id]);
  const t = /^Bearer\s+(\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!r || !t || !r.token_hash || r.expires_at < Date.now() || (await sha256(t)) !== r.token_hash) throw new JobError("Unauthorized", 401);
  return r;
}

/** Runtime fetches the project files (+ decrypted env for build/test) for exactly this job. */
export async function serveJob(req: Request, id: string): Promise<Response> {
  const r = await authorize(req, id);
  if (r.status !== "queued") throw new JobError("Job already started", 409);
  const fs = await import("../../sandbox/fs.server");
  const tree = await fs.readTree(r.project_id);
  if (tree.unchanged) throw new JobError("Project files unavailable", 500);
  const files = tree.files.filter((f) => !IGNORED.test(f.path)).map((f) => ({ path: f.path, content: f.content, encoding: f.encoding }));
  const env: Record<string, string> = {};
  if (r.kind === "build" || r.kind === "test" || r.kind === "script") {
    const { openEnv } = await import("../../tools/catalog/deps");
    for (const e of await d1<{ name: string; value_enc: string }>("SELECT name, value_enc FROM project_env WHERE project_id = ?", [r.project_id])) env[e.name] = await openEnv(r.project_id, e.value_enc);
  }
  await d1("UPDATE runtime_jobs SET status = 'running' WHERE id = ?", [id]);
  return Response.json({ kind: r.kind, script: r.script, revision: tree.revision, files, env }, { headers: { "Cache-Control": "no-store" } });
}

type Result = { ok?: boolean; exitCode?: number; output?: string; diagnostics?: unknown[]; files?: { path: string; content: string }[] };
/** Runtime reports the real exit code/output. Single-use: the token is cleared on the first report. */
export async function acceptJob(req: Request, id: string): Promise<Response> {
  const r = await authorize(req, id);
  await d1("UPDATE runtime_jobs SET token_hash = '' WHERE id = ?", [id]);
  const b = (await req.json().catch(() => null)) as Result | null;
  if (!b) { await d1("UPDATE runtime_jobs SET status = 'failed', output = 'Unreadable result', completed_at = datetime('now') WHERE id = ?", [id]); return Response.json({ ok: false }, { status: 400 }); }
  let changed: string[] = [];
  // Formatter / install output (lockfile) comes back as files: applied as one revision on top of the current files.
  if (b.ok && Array.isArray(b.files) && b.files.length && (r.kind === "format" || r.kind === "install")) {
    const fs = await import("../../sandbox/fs.server");
    const { store, revision } = await fs.loadStore(r.project_id);
    const before = fs.snapshotStore(store);
    for (const f of b.files.slice(0, 2000)) {
      if (typeof f.path !== "string" || typeof f.content !== "string") continue;
      const p = fs.safePath(f.path);
      if (r.kind === "format" && !store.get(p)) continue;
      store.set({ path: p, content: f.content, encoding: "utf8", updatedAt: Date.now() });
    }
    try {
      const c = await fs.commit(r.project_id, revision, before, store, { label: r.kind === "format" ? "Format (prettier)" : "Install (lockfile)" });
      changed = c.changed;
      if (c.changed.length) {
        const { publish } = await import("@realtime/publish.server");
        await publish(r.user_id, "filerev", "upsert", `${r.project_id}:${c.revision}`, c.revision, { id: `${r.project_id}:${c.revision}`, projectId: r.project_id, revision: c.revision, changed: c.changed.slice(0, 200), version: c.revision });
      }
    } catch (e) { b.output = `${b.output ?? ""}\nCould not apply returned files: ${(e as Error).message}`; }
  }
  const { redact } = await import("../../tools/policy");
  await d1("UPDATE runtime_jobs SET status = ?, exit_code = ?, output = ?, diagnostics = ?, files = ?, completed_at = datetime('now') WHERE id = ?",
    [b.ok ? "succeeded" : "failed", typeof b.exitCode === "number" ? b.exitCode : b.ok ? 0 : 1, redact(String(b.output ?? "")).slice(-60_000), JSON.stringify((b.diagnostics ?? []).slice(0, 300)), JSON.stringify(changed), id]);
  return Response.json({ ok: true, applied: changed.length });
}
