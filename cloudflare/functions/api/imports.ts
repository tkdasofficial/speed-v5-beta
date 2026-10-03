// Project import RPCs. Every source ends in the same normalized ProjectFile list
// (import/normalize.ts) and is persisted to the `files` table of a new project.
import { z } from "zod";
import type { ProjectFile, ProjectTree, ImportSource } from "../import/normalize";

async function base() {
  const { requireUser, assertOwnsProject, AuthError } = await import("@security/authorize.server");
  const { d1, d1Batch } = await import("@backend/d1");
  const me = await requireUser();
  return { me, assertOwnsProject, AuthError, d1, d1Batch };
}

/** Converts import/GitHub errors into the API's standard status errors. */
async function guard<T>(f: () => Promise<T>): Promise<T> {
  const { AuthError } = await import("@security/authorize.server");
  const { ImportError } = await import("../import/zip");
  const { GithubError } = await import("../github/client.server");
  try { return await f(); }
  catch (e) {
    if (e instanceof ImportError) throw new AuthError(e.status, e.message);
    if (e instanceof GithubError) throw new AuthError(e.code === "reconnect" ? 401 : e.code === "not_found" ? 404 : e.code === "rate_limited" ? 429 : 403, e.message);
    throw e;
  }
}

async function saveFiles(projectId: string, files: ProjectFile[]) {
  const { d1Batch } = await import("@backend/d1");
  const sql = `INSERT INTO files (id, project_id, path, content, size, kind, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, path) DO UPDATE SET content = excluded.content, size = excluded.size, kind = excluded.kind, source = excluded.source, updated_at = excluded.updated_at`;
  let batch: { sql: string; params: unknown[] }[] = [];
  let bytes = 0;
  for (const f of files) {
    batch.push({ sql, params: [crypto.randomUUID(), projectId, f.path, f.content, f.size, f.kind, f.source] });
    bytes += f.content?.length ?? 0;
    if (batch.length >= 40 || bytes > 3_000_000) { await d1Batch(batch); batch = []; bytes = 0; }
  }
  await d1Batch(batch);
}

const countFiles = async (projectId: string) => {
  const { d1 } = await import("@backend/d1");
  return (await d1<{ n: number }>("SELECT COUNT(*) AS n FROM files WHERE project_id = ?", [projectId]))[0]?.n ?? 0;
};

const summary = (t: ProjectTree) => ({ files: t.files.length, dirs: t.dirs.length, bytes: t.totalBytes, skipped: t.skipped.slice(0, 50) });

/** Creates the project, stores the tree, verifies the stored count; rolls back on any failure. */
async function persist(userId: string, name: string, settings: Record<string, string | number | boolean>, tree: ProjectTree, afterCreate?: (projectId: string) => Promise<void>) {
  const { AuthError } = await import("@security/authorize.server");
  if (!tree.files.length) throw new AuthError(400, "Nothing to import — the project has no files");
  const { insertProject, patchProjectSettings, removeProject } = await import("@backend/projects.server");
  const p = await insertProject(userId, name, { ...settings, importStatus: "importing" });
  try {
    await afterCreate?.(p.id);
    await saveFiles(p.id, tree.files);
    const n = await countFiles(p.id);
    if (n !== tree.files.length) throw new Error(`Only ${n} of ${tree.files.length} files were saved`);
    const project = await patchProjectSettings(userId, p.id, { importStatus: "ready", importedFiles: n });
    return { project, ...summary(tree) };
  } catch (e) {
    await removeProject(userId, p.id).catch(() => undefined);
    throw e;
  }
}

const urlInput = z.object({ url: z.string().min(1).max(500), provider: z.enum(["github", "gitlab", "bitbucket"]) });

/** Checks a public repository URL (validity + public access) without importing. */
export async function importInspectUrl(raw: unknown) {
  const { url, provider } = urlInput.parse(raw);
  await base();
  return guard(async () => {
    const { parseRepoUrl, publicMeta } = await import("../import/providers.server");
    const m = await publicMeta(parseRepoUrl(url, provider));
    return { provider: m.provider, fullName: m.fullName, defaultBranch: m.defaultBranch, url: m.url, empty: m.empty };
  });
}

/** Imports a public GitHub / GitLab / Bitbucket repository by URL (no OAuth). */
export async function importFromUrl(raw: unknown) {
  const { url, provider } = urlInput.parse(raw);
  const { me, AuthError } = await base();
  return guard(async () => {
    const { parseRepoUrl, publicMeta, publicArchive } = await import("../import/providers.server");
    const { unzipEntries } = await import("../import/zip");
    const { buildTree } = await import("../import/normalize");
    const m = await publicMeta(parseRepoUrl(url, provider));
    if (m.empty) throw new AuthError(400, "This repository is empty");
    const tree = buildTree(unzipEntries(await publicArchive(m)), m.provider as ImportSource);
    return persist(me.id, m.name, { source: m.provider, sourceUrl: m.url.slice(0, 200), sourceRepo: m.fullName.slice(0, 200), sourceBranch: m.defaultBranch, sourceAuth: "public" }, tree);
  });
}

/** Imports a repository the user can access through their GitHub authorization (private repos included). */
export async function importGithubRepo(raw: unknown) {
  const { repoId } = z.object({ repoId: z.number().int().positive() }).parse(raw);
  const { me, AuthError, d1 } = await base();
  return guard(async () => {
    const gh = await import("../github/client.server");
    const { githubArchive } = await import("../import/providers.server");
    const { unzipEntries } = await import("../import/zip");
    const { buildTree } = await import("../import/normalize");
    const repo = gh.toRepo(await gh.gh<import("../github/client.server").RawRepo>(me.id, `/repositories/${repoId}`));
    let bytes: Uint8Array;
    try { bytes = await githubArchive(me.id, repo.id, repo.defaultBranch); }
    catch (e) { if (e instanceof gh.GithubError && e.code === "not_found") throw new AuthError(400, "This repository is empty"); throw e; }
    const tree = buildTree(unzipEntries(bytes), "github");
    return persist(me.id, repo.name, { source: "github", sourceUrl: repo.url.slice(0, 200), sourceRepo: repo.fullName.slice(0, 200), sourceBranch: repo.defaultBranch, sourceAuth: "oauth" }, tree, async (projectId) => {
      await d1(`INSERT INTO project_repos (project_id, user_id, github_repo_id, owner, name, full_name, default_branch, private, verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`, [projectId, me.id, repo.id, repo.owner, repo.name, repo.fullName, repo.defaultBranch, repo.private ? 1 : 0]);
    });
  });
}

// ---- Local ZIP / directory: the browser extracts with the same normalizer, then uploads in batches. ----
const localStart = z.object({ name: z.string().trim().min(1).max(80), source: z.enum(["zip", "directory"]), files: z.number().int().min(1).max(3000) });

export async function importLocalStart(raw: unknown) {
  const d = localStart.parse(raw);
  const { me } = await base();
  const { insertProject } = await import("@backend/projects.server");
  return insertProject(me.id, d.name, { source: d.source, importStatus: "importing", importExpected: d.files });
}

const fileIn = z.object({
  path: z.string().min(1).max(1024),
  size: z.number().int().min(0),
  kind: z.enum(["text", "binary", "too_large"]),
  content: z.string().nullable(),
});

export async function importLocalBatch(raw: unknown) {
  const d = z.object({ projectId: z.string().min(1), source: z.enum(["zip", "directory"]), files: z.array(fileIn).min(1).max(200) }).parse(raw);
  const { me, assertOwnsProject, AuthError, d1 } = await base();
  await assertOwnsProject(me.id, d.projectId);
  const [p] = await d1<{ settings: string }>("SELECT settings FROM projects WHERE id = ?", [d.projectId]);
  if (JSON.parse(p?.settings || "{}").importStatus !== "importing") throw new AuthError(409, "This import is no longer in progress");
  const { cleanPath, LIMITS } = await import("../import/normalize");
  let bytes = 0;
  const files: ProjectFile[] = d.files.map((f) => {
    const path = cleanPath(f.path);
    if (!path) throw new AuthError(400, `Invalid file path: ${f.path.slice(0, 100)}`);
    const c = f.kind === "too_large" ? null : f.content;
    if (f.kind !== "too_large" && c === null) throw new AuthError(400, `Missing content for ${path}`);
    if (f.kind === "text" && c!.length > LIMITS.maxTextBytes * 2) throw new AuthError(413, `${path} is too large`);
    if (f.kind === "binary" && (c!.length > LIMITS.maxBinaryBytes * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(c!))) throw new AuthError(400, `Invalid binary content for ${path}`);
    bytes += c?.length ?? 0;
    return { path, name: path.split("/").pop()!, type: "file", size: f.size, kind: f.kind, content: c, source: d.source };
  });
  if (bytes > 6_000_000) throw new AuthError(413, "Upload batch too large");
  await saveFiles(d.projectId, files);
  return { saved: files.length };
}

export async function importLocalFinish(raw: unknown) {
  const d = z.object({ projectId: z.string().min(1), expected: z.number().int().min(1) }).parse(raw);
  const { me, assertOwnsProject, AuthError } = await base();
  await assertOwnsProject(me.id, d.projectId);
  const n = await countFiles(d.projectId);
  if (n !== d.expected) throw new AuthError(409, `Only ${n} of ${d.expected} files were saved`);
  const { patchProjectSettings } = await import("@backend/projects.server");
  return { project: await patchProjectSettings(me.id, d.projectId, { importStatus: "ready", importedFiles: n }), files: n };
}

/** Removes a project whose local import was cancelled or failed. Only unfinished imports can be removed here. */
export async function importLocalAbort(raw: unknown) {
  const d = z.object({ projectId: z.string().min(1) }).parse(raw);
  const { me, assertOwnsProject, d1 } = await base();
  await assertOwnsProject(me.id, d.projectId);
  const [p] = await d1<{ settings: string }>("SELECT settings FROM projects WHERE id = ?", [d.projectId]);
  if (JSON.parse(p?.settings || "{}").importStatus !== "importing") return { ok: false };
  const { removeProject } = await import("@backend/projects.server");
  await removeProject(me.id, d.projectId);
  return { ok: true };
}

// ---- Reading imported files back ----
export async function listProjectFiles(raw: unknown) {
  const { projectId } = z.object({ projectId: z.string().min(1) }).parse(raw);
  const { me, assertOwnsProject, d1 } = await base();
  await assertOwnsProject(me.id, projectId);
  const rows = await d1<{ path: string; size: number; kind: string }>("SELECT path, size, kind FROM files WHERE project_id = ? ORDER BY path LIMIT 5000", [projectId]);
  return rows.map((r) => ({ path: r.path, name: r.path.split("/").pop()!, size: r.size, kind: r.kind as ProjectFile["kind"] }));
}

export async function getProjectFile(raw: unknown) {
  const { projectId, path } = z.object({ projectId: z.string().min(1), path: z.string().min(1).max(1024) }).parse(raw);
  const { me, assertOwnsProject, AuthError, d1 } = await base();
  await assertOwnsProject(me.id, projectId);
  const [r] = await d1<{ path: string; size: number; kind: string; content: string | null }>("SELECT path, size, kind, content FROM files WHERE project_id = ? AND path = ?", [projectId, path]);
  if (!r) throw new AuthError(404, "File not found");
  return { path: r.path, size: r.size, kind: r.kind as ProjectFile["kind"], content: r.kind === "text" ? r.content : null };
}
