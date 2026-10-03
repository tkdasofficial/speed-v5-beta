// Git / version control tools: real GitHub Git Data API calls on the repository linked to this project,
// using the owner's own GitHub connection. The working copy is the project's revisioned file store.
import { defineTool, group } from "../registry";
import { z, ToolFailure, gh, linkedRepo, blobSha, unifiedDiff, visible, write, remove, ASSET_EXT } from "./util";
import type { ToolEnv } from "../types";

type Tree = { sha: string; truncated?: boolean; tree: { path: string; type: "blob" | "tree"; sha: string; mode: string }[] };
const BRANCH = /^[\w./-]{1,100}$/;

async function branchOf(env: ToolEnv, override?: string) {
  const repo = await linkedRepo(env);
  const st = await env.settings();
  const b = override ?? (typeof st["gitBranch"] === "string" && st["gitBranch"] ? (st["gitBranch"] as string) : repo.default_branch || "main");
  if (!BRANCH.test(b) || b.includes("..")) throw new ToolFailure("INVALID_ARGUMENT", `Invalid branch ${b}`);
  return { repo, branch: b };
}
async function remoteTree(env: ToolEnv, full: string, branch: string) {
  const t = await gh<Tree>(env, "GET", `/repos/${full}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (t.truncated) throw new ToolFailure("RESOURCE_LIMIT", "Repository tree is too large to compare");
  return new Map(t.tree.filter((x) => x.type === "blob").map((x) => [x.path, x.sha]));
}
/** Local vs remote: added / modified / deleted (local view). Secret and generated files are excluded. */
async function status(env: ToolEnv, full: string, branch: string) {
  const s = await env.files();
  const remote = await remoteTree(env, full, branch);
  const added: string[] = [], modified: string[] = [], deleted: string[] = [];
  const local = new Set<string>();
  for (const f of visible(s)) {
    local.add(f.path);
    const r = remote.get(f.path);
    if (!r) added.push(f.path);
    else if (r !== (await blobSha(f.content, f.encoding))) modified.push(f.path);
  }
  for (const p of remote.keys()) if (!local.has(p) && !/(^|\/)(\.env|node_modules\/|\.git\/)/.test(p)) deleted.push(p);
  return { added, modified, deleted, remote };
}
async function remoteText(env: ToolEnv, full: string, branch: string, path: string) {
  const r = await gh<{ content?: string; encoding?: string }>(env, "GET", `/repos/${full}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`);
  return r.content ? decodeURIComponent(escape(atob(r.content.replace(/\n/g, "")))) : "";
}

const git = group({ category: "git", requiredPermissions: ["git:read"], prerequisites: ["repo_linked", "github_auth"], timeoutMs: 30_000 });

export const gitTools = [
  git({
    name: "git_status", description: "Compare the project files with the linked GitHub branch (added / modified / deleted).", capabilities: ["git status", "uncommitted changes"],
    inputSchema: z.object({ branch: z.string().max(100).optional() }),
    handler: async (a, env) => { const { repo, branch } = await branchOf(env, a.branch); const r = await status(env, repo.full_name, branch); return { data: { repo: repo.full_name, branch, added: r.added, modified: r.modified, deleted: r.deleted, clean: !r.added.length && !r.modified.length && !r.deleted.length } }; },
  }),
  git({
    name: "git_diff", description: "Unified diff of project files against the linked GitHub branch.", capabilities: ["git diff", "changes"],
    inputSchema: z.object({ path: z.string().max(400).optional(), branch: z.string().max(100).optional() }),
    handler: async (a, env) => {
      const { repo, branch } = await branchOf(env, a.branch);
      const r = await status(env, repo.full_name, branch);
      const s = await env.files();
      const paths = [...r.modified, ...r.added, ...r.deleted].filter((p) => !a.path || p === a.path).filter((p) => !ASSET_EXT.test(p) || p.endsWith(".svg")).slice(0, 15);
      const diffs: string[] = [];
      for (const p of paths) diffs.push(unifiedDiff(r.added.includes(p) ? "" : await remoteText(env, repo.full_name, branch, p), s.get(p)?.content ?? "", p));
      return { data: { branch, files: paths.length, diff: diffs.join("\n\n").slice(0, 60_000) } };
    },
  }),
  git({
    name: "git_log", description: "Recent commits on the linked branch.", capabilities: ["git log", "commit history"],
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(15), branch: z.string().max(100).optional(), path: z.string().max(400).optional() }),
    handler: async (a, env) => {
      const { repo, branch } = await branchOf(env, a.branch);
      const c = await gh<{ sha: string; commit: { message: string; author: { name: string; date: string } } }[]>(env, "GET", `/repos/${repo.full_name}/commits?sha=${encodeURIComponent(branch)}&per_page=${a.limit}${a.path ? `&path=${encodeURIComponent(a.path)}` : ""}`);
      return { data: { branch, commits: c.map((x) => ({ sha: x.sha.slice(0, 12), message: x.commit.message.split("\n")[0], author: x.commit.author.name, date: x.commit.author.date })) } };
    },
  }),
  git({
    name: "git_list_branches", description: "Branches of the linked repository.", capabilities: ["git branch", "branches"],
    inputSchema: z.object({}),
    handler: async (_a, env) => { const { repo, branch } = await branchOf(env); const b = await gh<{ name: string; protected: boolean }[]>(env, "GET", `/repos/${repo.full_name}/branches?per_page=100`); return { data: { current: branch, default: repo.default_branch, branches: b.map((x) => ({ name: x.name, protected: x.protected })) } }; },
  }),
  git({
    name: "git_create_branch", description: "Create a branch on GitHub from the current (or given) branch and switch to it.", readOnly: false, requiredPermissions: ["git:write"], capabilities: ["new branch"],
    inputSchema: z.object({ name: z.string().regex(BRANCH), from: z.string().max(100).optional() }),
    handler: async (a, env) => {
      const { repo, branch } = await branchOf(env, a.from);
      const ref = await gh<{ object: { sha: string } }>(env, "GET", `/repos/${repo.full_name}/git/ref/heads/${encodeURIComponent(branch)}`);
      await gh(env, "POST", `/repos/${repo.full_name}/git/refs`, { ref: `refs/heads/${a.name}`, sha: ref.object.sha });
      await env.patchSettings({ gitBranch: a.name });
      return { data: { branch: a.name, from: branch, sha: ref.object.sha.slice(0, 12) }, stateChanges: [{ kind: "git", target: a.name, detail: "branch created" }] };
    },
  }),
  git({
    name: "git_switch_branch", description: "Use another existing branch for future git operations (does not change files; use git_pull to load it).", readOnly: false, requiredPermissions: ["git:write"], capabilities: ["checkout", "switch branch"],
    inputSchema: z.object({ name: z.string().regex(BRANCH) }),
    handler: async (a, env) => {
      const { repo } = await branchOf(env);
      await gh(env, "GET", `/repos/${repo.full_name}/git/ref/heads/${encodeURIComponent(a.name)}`);
      await env.patchSettings({ gitBranch: a.name });
      return { data: { branch: a.name }, stateChanges: [{ kind: "git", target: a.name, detail: "switched" }], next: "git_status" };
    },
  }),
  git({
    name: "git_commit_and_push", description: "Commit all project changes (or the given paths) to the linked branch on GitHub in one commit.", readOnly: false, requiredPermissions: ["git:write"], timeoutMs: 60_000, capabilities: ["git commit", "git push", "publish to github"],
    inputSchema: z.object({ message: z.string().min(1).max(500), paths: z.array(z.string().max(400)).max(500).optional(), branch: z.string().max(100).optional() }),
    handler: async (a, env) => {
      await env.commit("Before git commit");
      const { repo, branch } = await branchOf(env, a.branch);
      const r = await status(env, repo.full_name, branch);
      const pick = (l: string[]) => (a.paths ? l.filter((p) => a.paths!.includes(p)) : l);
      const up = [...pick(r.added), ...pick(r.modified)], del = pick(r.deleted);
      if (!up.length && !del.length) return { data: { committed: false, reason: "Nothing to commit — the branch already matches the project" } };
      if (up.length + del.length > 500) throw new ToolFailure("RESOURCE_LIMIT", "More than 500 changed files — commit in smaller batches using paths");
      const s = await env.files();
      const ref = await gh<{ object: { sha: string } }>(env, "GET", `/repos/${repo.full_name}/git/ref/heads/${encodeURIComponent(branch)}`);
      const base = await gh<{ tree: { sha: string } }>(env, "GET", `/repos/${repo.full_name}/git/commits/${ref.object.sha}`);
      const tree: { path: string; mode: string; type: string; sha: string | null }[] = [];
      for (const p of up) {
        const f = s.get(p)!;
        const b = await gh<{ sha: string }>(env, "POST", `/repos/${repo.full_name}/git/blobs`, f.encoding === "base64" ? { content: f.content, encoding: "base64" } : { content: f.content, encoding: "utf-8" });
        tree.push({ path: p, mode: "100644", type: "blob", sha: b.sha });
      }
      for (const p of del) tree.push({ path: p, mode: "100644", type: "blob", sha: null });
      const t = await gh<{ sha: string }>(env, "POST", `/repos/${repo.full_name}/git/trees`, { base_tree: base.tree.sha, tree });
      const c = await gh<{ sha: string; html_url: string }>(env, "POST", `/repos/${repo.full_name}/git/commits`, { message: a.message, tree: t.sha, parents: [ref.object.sha] });
      await gh(env, "PATCH", `/repos/${repo.full_name}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: c.sha, force: false });
      return { data: { committed: true, sha: c.sha.slice(0, 12), url: c.html_url, branch, changed: up.length, deleted: del.length }, stateChanges: [{ kind: "git", target: branch, detail: `commit ${c.sha.slice(0, 12)}` }] };
    },
  }),
  git({
    name: "git_pull", description: "Load the linked branch's files into the project (overwrites changed files; files only in the project are kept unless prune=true).", readOnly: false, destructive: true, requiredPermissions: ["git:read", "project:write"], timeoutMs: 90_000, capabilities: ["git pull", "sync from github", "fetch"],
    inputSchema: z.object({ branch: z.string().max(100).optional(), prune: z.boolean().default(false) }),
    handler: async (a, env) => {
      const { repo, branch } = await branchOf(env, a.branch);
      const r = await status(env, repo.full_name, branch);
      const s = await env.files();
      const fetch = [...r.modified, ...r.deleted].filter((p) => !/(^|\/)(\.env|node_modules\/)/.test(p)).slice(0, 400);
      for (const p of fetch) {
        const sha = r.remote.get(p)!;
        const b = await gh<{ content: string }>(env, "GET", `/repos/${repo.full_name}/git/blobs/${sha}`);
        const raw = b.content.replace(/\n/g, "");
        if (ASSET_EXT.test(p) && !p.endsWith(".svg")) write(env, s, p, raw, "base64");
        else write(env, s, p, decodeURIComponent(escape(atob(raw))));
      }
      if (a.prune) for (const p of r.added) remove(env, s, p);
      return { data: { branch, updated: fetch.length, removed: a.prune ? r.added.length : 0 }, stateChanges: [{ kind: "git", target: branch, detail: "pulled" }], next: "save_changes" };
    },
  }),
  git({
    name: "git_show_commit", description: "Files changed by one commit.", capabilities: ["git show"],
    inputSchema: z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/) }),
    handler: async (a, env) => {
      const { repo } = await branchOf(env);
      const c = await gh<{ commit: { message: string }; files?: { filename: string; status: string; additions: number; deletions: number; patch?: string }[] }>(env, "GET", `/repos/${repo.full_name}/commits/${a.sha}`);
      return { data: { message: c.commit.message, files: (c.files ?? []).slice(0, 50).map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch?.slice(0, 3000) })) } };
    },
  }),
  git({
    name: "git_revert_file", description: "Restore one file to its content on the linked branch.", readOnly: false, requiredPermissions: ["git:read", "project:write"], capabilities: ["discard changes", "git checkout file"],
    inputSchema: z.object({ path: z.string().min(1).max(400), branch: z.string().max(100).optional() }),
    handler: async (a, env) => {
      const { repo, branch } = await branchOf(env, a.branch);
      const s = await env.files();
      write(env, s, a.path, await remoteText(env, repo.full_name, branch, a.path));
      return { data: { path: a.path, branch }, stateChanges: [{ kind: "file", target: a.path, detail: "reverted from git" }] };
    },
  }),
  git({
    name: "git_create_pull_request", description: "Open a pull request from the current branch into the default branch.", readOnly: false, requiredPermissions: ["git:write"], capabilities: ["pull request", "pr"],
    inputSchema: z.object({ title: z.string().min(1).max(200), body: z.string().max(5000).default(""), base: z.string().max(100).optional() }),
    handler: async (a, env) => {
      const { repo, branch } = await branchOf(env);
      const base = a.base ?? repo.default_branch;
      if (base === branch) throw new ToolFailure("INVALID_ARGUMENT", "Current branch is the base branch — create a branch first", false, undefined, "git_create_branch");
      const pr = await gh<{ number: number; html_url: string }>(env, "POST", `/repos/${repo.full_name}/pulls`, { title: a.title, body: a.body, head: branch, base });
      return { data: { number: pr.number, url: pr.html_url }, stateChanges: [{ kind: "git", target: `#${pr.number}`, detail: "pull request" }] };
    },
  }),
];
