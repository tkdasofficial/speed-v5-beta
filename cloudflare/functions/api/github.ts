// GitHub repository RPCs: authenticate → authorize project → GitHub client (tokens stay server-side).
import { z } from "zod";

async function base() {
  const { requireUser, assertOwnsProject, AuthError } = await import("@security/authorize.server");
  const gh = await import("../github/client.server");
  const { d1 } = await import("@backend/d1");
  const me = await requireUser();
  const wrap = async <T>(f: () => Promise<T>) => {
    try { return await f(); }
    catch (e) { if (e instanceof gh.GithubError) throw new AuthError(e.code === "reconnect" ? 401 : e.code === "not_found" ? 404 : 403, e.message); throw e; }
  };
  return { me, assertOwnsProject, gh, d1, wrap };
}

export async function githubRepos() {
  const { me, gh, wrap } = await base();
  return wrap(() => gh.listRepos(me.id));
}

type LinkRow = { github_repo_id: number; owner: string; name: string; full_name: string; default_branch: string; private: number; verified_at: string | null };
const toLink = (r: LinkRow) => ({ id: r.github_repo_id, owner: r.owner, name: r.name, fullName: r.full_name, defaultBranch: r.default_branch, private: !!r.private, verifiedAt: r.verified_at });

export async function getProjectRepo(raw: unknown) {
  const { projectId } = z.object({ projectId: z.string().min(1) }).parse(raw);
  const { me, assertOwnsProject, d1 } = await base();
  await assertOwnsProject(me.id, projectId);
  const r = (await d1<LinkRow>("SELECT * FROM project_repos WHERE project_id = ?", [projectId]))[0];
  return r ? toLink(r) : null;
}

export async function linkProjectRepo(raw: unknown) {
  const { projectId, repoId } = z.object({ projectId: z.string().min(1), repoId: z.number().int().positive() }).parse(raw);
  const { me, assertOwnsProject, gh, d1, wrap } = await base();
  await assertOwnsProject(me.id, projectId);
  const repo = gh.toRepo(await wrap(() => gh.gh<import("../github/client.server").RawRepo>(me.id, `/repositories/${repoId}`)));
  await d1(
    `INSERT INTO project_repos (project_id, user_id, github_repo_id, owner, name, full_name, default_branch, private, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(project_id) DO UPDATE SET user_id=excluded.user_id, github_repo_id=excluded.github_repo_id, owner=excluded.owner, name=excluded.name,
       full_name=excluded.full_name, default_branch=excluded.default_branch, private=excluded.private, verified_at=excluded.verified_at`,
    [projectId, me.id, repo.id, repo.owner, repo.name, repo.fullName, repo.defaultBranch, repo.private ? 1 : 0],
  );
  return getProjectRepo({ projectId });
}

export async function unlinkProjectRepo(raw: unknown) {
  const { projectId } = z.object({ projectId: z.string().min(1) }).parse(raw);
  const { me, assertOwnsProject, d1 } = await base();
  await assertOwnsProject(me.id, projectId);
  await d1("DELETE FROM project_repos WHERE project_id = ?", [projectId]);
  return { ok: true };
}

/** Confirms the linked repository is still reachable with the user's current GitHub authorization. */
export async function verifyProjectRepo(raw: unknown) {
  const { projectId } = z.object({ projectId: z.string().min(1) }).parse(raw);
  const { me, assertOwnsProject, gh, d1 } = await base();
  await assertOwnsProject(me.id, projectId);
  const link = (await d1<LinkRow>("SELECT * FROM project_repos WHERE project_id = ?", [projectId]))[0];
  if (!link) return { ok: false as const, error: "No repository connected" };
  try {
    const repo = gh.toRepo(await gh.gh<import("../github/client.server").RawRepo>(me.id, `/repositories/${link.github_repo_id}`));
    await d1("UPDATE project_repos SET full_name = ?, owner = ?, name = ?, default_branch = ?, private = ?, verified_at = datetime('now') WHERE project_id = ?",
      [repo.fullName, repo.owner, repo.name, repo.defaultBranch, repo.private ? 1 : 0, projectId]);
    return { ok: true as const, canPush: repo.canPush, fullName: repo.fullName };
  } catch (e) {
    if (e instanceof gh.GithubError) return { ok: false as const, code: e.code, error: e.message };
    throw e;
  }
}

// ---- Repository read layer (tree + single file). Repo comes from project_repos, never from the client. ----
const treeCache = new Map<string, { at: number; data: unknown }>();
const TREE_TTL = 60_000;

async function linkedRepo(projectId: string) {
  const { me, assertOwnsProject, gh, d1, wrap } = await base();
  await assertOwnsProject(me.id, projectId);
  const link = (await d1<LinkRow>("SELECT * FROM project_repos WHERE project_id = ? AND user_id = ?", [projectId, me.id]))[0];
  if (!link) {
    const { AuthError } = await import("@security/authorize.server");
    throw new AuthError(404, "No GitHub repository is connected to this project");
  }
  return { me, gh, wrap, link };
}

export async function githubTree(raw: unknown) {
  const { projectId } = z.object({ projectId: z.string().min(1) }).parse(raw);
  const { me, gh, wrap, link } = await linkedRepo(projectId);
  const { normalizeTree } = await import("../github/fs");
  // Resolve the live default branch (it may have changed since linking).
  const repo = gh.toRepo(await wrap(() => gh.gh<import("../github/client.server").RawRepo>(me.id, `/repositories/${link.github_repo_id}`)));
  const key = `${me.id}:${link.github_repo_id}:${repo.defaultBranch}`;
  const hit = treeCache.get(key);
  if (hit && Date.now() - hit.at < TREE_TTL) return hit.data as ReturnType<typeof result>;
  const t = await wrap(() => gh.gh<{ sha: string; truncated: boolean; tree: import("../github/fs").RawTreeItem[] }>(me.id, `/repositories/${link.github_repo_id}/git/trees/${encodeURIComponent(repo.defaultBranch)}?recursive=1`));
  const result = () => ({ repo: repo.fullName, branch: repo.defaultBranch, sha: t.sha, truncated: t.truncated, entries: normalizeTree(t.tree) });
  const data = result();
  treeCache.set(key, { at: Date.now(), data });
  if (treeCache.size > 50) treeCache.delete(treeCache.keys().next().value!);
  return data;
}

type RawContent = { type: string; path: string; name: string; size: number; sha: string; encoding?: string; content?: string };

export async function githubFile(raw: unknown) {
  const { projectId, path } = z.object({ projectId: z.string().min(1), path: z.string().min(1).max(1024) }).parse(raw);
  const { safeRepoPath, decodeText, MAX_TEXT_BYTES } = await import("../github/fs");
  const { AuthError } = await import("@security/authorize.server");
  const safe = safeRepoPath(path);
  if (!safe) throw new AuthError(403, "Invalid file path");
  const { me, gh, wrap, link } = await linkedRepo(projectId);
  const repo = gh.toRepo(await wrap(() => gh.gh<import("../github/client.server").RawRepo>(me.id, `/repositories/${link.github_repo_id}`)));
  let c: RawContent | RawContent[];
  try { c = await gh.gh<RawContent | RawContent[]>(me.id, `/repositories/${link.github_repo_id}/contents/${safe}?ref=${encodeURIComponent(repo.defaultBranch)}`); }
  catch (e) {
    if (e instanceof gh.GithubError && e.code === "not_found") throw new AuthError(404, "File not found");
    return wrap(() => Promise.reject(e));
  }
  if (Array.isArray(c) || c.type === "dir") throw new AuthError(403, "This path is a folder, not a file");
  const meta = { path: c.path, name: c.name, size: c.size, sha: c.sha, branch: repo.defaultBranch };
  if (c.type !== "file") return { ...meta, kind: "unsupported" as const, content: null };
  if (c.size > MAX_TEXT_BYTES || c.encoding !== "base64" || !c.content) return { ...meta, kind: "too_large" as const, content: null };
  const text = decodeText(c.path, c.content);
  return text === null ? { ...meta, kind: "binary" as const, content: null } : { ...meta, kind: "text" as const, content: text };
}
