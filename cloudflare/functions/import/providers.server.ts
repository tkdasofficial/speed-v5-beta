// Shared server-side repository service: URL validation, public metadata lookups and
// archive downloads for GitHub, GitLab and Bitbucket. Authorized GitHub access reuses
// github/client.server.ts so tokens never leave it.
import { ImportError } from "./zip";
import { LIMITS } from "./normalize";

export type Provider = "github" | "gitlab" | "bitbucket";
export type RepoRef = { provider: Provider; path: string; owner: string; name: string };
export type RepoMeta = RepoRef & { fullName: string; defaultBranch: string; private: boolean; url: string; empty: boolean; githubId?: number };

const HOSTS: Record<string, Provider> = { "github.com": "github", "www.github.com": "github", "gitlab.com": "gitlab", "www.gitlab.com": "gitlab", "bitbucket.org": "bitbucket", "www.bitbucket.org": "bitbucket" };
const SEG = /^[A-Za-z0-9_.-]+$/;

/** Parses a public repository web URL. Throws ImportError(400) for anything else. */
export function parseRepoUrl(raw: string, expected?: Provider): RepoRef {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new ImportError(400, "Enter a valid repository URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ImportError(400, "Repository URL must start with https://");
  const provider = HOSTS[u.hostname.toLowerCase()];
  if (!provider) throw new ImportError(400, "Only github.com, gitlab.com and bitbucket.org URLs are supported");
  if (expected && provider !== expected) throw new ImportError(400, `That's not a ${expected === "github" ? "GitHub" : expected === "gitlab" ? "GitLab" : "Bitbucket"} URL`);
  let parts = u.pathname.split("/").filter(Boolean);
  const dash = parts.indexOf("-"); // gitlab: /group/repo/-/tree/main
  if (dash >= 0) parts = parts.slice(0, dash);
  else if (provider !== "gitlab") parts = parts.slice(0, 2);
  if (parts.length) parts[parts.length - 1] = parts[parts.length - 1]!.replace(/\.git$/, "");
  if (parts.length < 2 || (provider !== "gitlab" && parts.length !== 2) || parts.length > 10 || !parts.every((p) => SEG.test(p) && p !== "." && p !== ".."))
    throw new ImportError(400, "URL must point to a repository, like https://host/owner/repo");
  return { provider, path: parts.join("/"), owner: parts.slice(0, -1).join("/"), name: parts[parts.length - 1]! };
}

async function get(url: string, init?: RequestInit): Promise<Response> {
  try { return await fetch(url, { ...init, headers: { "User-Agent": "speed-agent", ...(init?.headers ?? {}) } }); }
  catch { throw new ImportError(503, "The repository host is unreachable, try again"); }
}

function fail(res: Response, label: string): never {
  if (res.status === 404 || res.status === 401) throw new ImportError(404, `${label} repository not found, or it is private`);
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) throw new ImportError(429, `${label} rate limit reached, try again shortly`);
  if (res.status === 403) throw new ImportError(403, `${label} refused access to this repository`);
  throw new ImportError(502, `${label} request failed (${res.status})`);
}

/** Public (unauthenticated) metadata — proves the repository is genuinely public. */
export async function publicMeta(ref: RepoRef): Promise<RepoMeta> {
  if (ref.provider === "github") {
    const res = await get(`https://api.github.com/repos/${ref.path}`, { headers: { Accept: "application/vnd.github+json" } });
    // The anonymous API is often rate-limited on shared server IPs; the public archive host
    // still proves public access (it returns 404 for private repos), so fall back to it.
    if (res.status === 403 || res.status === 429) {
      const head = await get(`https://codeload.github.com/${ref.path}/zip/HEAD`, { method: "HEAD" });
      if (head.status === 404) throw new ImportError(404, "GitHub repository not found, or it is private");
      if (!head.ok) fail(res, "GitHub");
      return { ...ref, fullName: ref.path, defaultBranch: "HEAD", private: false, url: `https://github.com/${ref.path}`, empty: false };
    }
    if (!res.ok) fail(res, "GitHub");
    const r = (await res.json()) as { id: number; full_name: string; default_branch: string; private: boolean; html_url: string; size: number; owner: { login: string }; name: string };
    if (r.private) throw new ImportError(403, "This repository is private — connect GitHub to import it");
    return { ...ref, owner: r.owner.login, name: r.name, fullName: r.full_name, defaultBranch: r.default_branch, private: false, url: r.html_url, empty: r.size === 0, githubId: r.id };
  }
  if (ref.provider === "gitlab") {
    const res = await get(`https://gitlab.com/api/v4/projects/${encodeURIComponent(ref.path)}`);
    if (!res.ok) fail(res, "GitLab");
    const r = (await res.json()) as { path_with_namespace: string; default_branch: string | null; visibility?: string; web_url: string; empty_repo?: boolean; path: string; namespace?: { full_path: string } };
    if (r.visibility && r.visibility !== "public") throw new ImportError(403, "This GitLab repository is not public");
    return { ...ref, fullName: r.path_with_namespace, defaultBranch: r.default_branch ?? "", private: false, url: r.web_url, empty: !!r.empty_repo || !r.default_branch };
  }
  const res = await get(`https://api.bitbucket.org/2.0/repositories/${ref.path}`);
  if (!res.ok) fail(res, "Bitbucket");
  const r = (await res.json()) as { full_name: string; is_private: boolean; mainbranch?: { name: string } | null; size?: number; links: { html: { href: string } } };
  if (r.is_private) throw new ImportError(403, "This Bitbucket repository is not public");
  return { ...ref, fullName: r.full_name, defaultBranch: r.mainbranch?.name ?? "", private: false, url: r.links.html.href, empty: !r.mainbranch };
}

/** Reads a response body with a hard size cap. */
async function readCapped(res: Response): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > LIMITS.maxArchiveBytes) throw new ImportError(413, "Repository is too large to import (over 50 MB)");
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > LIMITS.maxArchiveBytes) { await reader.cancel(); throw new ImportError(413, "Repository is too large to import (over 50 MB)"); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Downloads the default-branch ZIP of a public repository. */
export async function publicArchive(m: RepoMeta): Promise<Uint8Array> {
  const b = encodeURIComponent(m.defaultBranch);
  const url = m.provider === "github" ? `https://codeload.github.com/${m.path}/zip/${m.defaultBranch === "HEAD" ? "HEAD" : `refs/heads/${b}`}`
    : m.provider === "gitlab" ? `https://gitlab.com/api/v4/projects/${encodeURIComponent(m.path)}/repository/archive.zip?sha=${b}`
    : `https://bitbucket.org/${m.path}/get/${b}.zip`;
  const res = await get(url);
  if (!res.ok) fail(res, m.provider === "github" ? "GitHub" : m.provider === "gitlab" ? "GitLab" : "Bitbucket");
  return readCapped(res);
}

/** Downloads an authorized GitHub repository archive through the shared GitHub client. */
export async function githubArchive(userId: string, repoId: number, branch: string): Promise<Uint8Array> {
  const { ghRaw } = await import("../github/client.server");
  return readCapped(await ghRaw(userId, `/repositories/${repoId}/zipball/${encodeURIComponent(branch)}`));
}
