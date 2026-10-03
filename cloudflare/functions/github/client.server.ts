// Reusable server-side GitHub API client: valid (auto-refreshed) user token + normalized errors.
import { getGithubAccessToken, GithubReconnectRequired } from "@security/github.server";
import { d1 } from "@backend/d1";

export class GithubError extends Error {
  constructor(public code: "reconnect" | "not_found" | "forbidden" | "rate_limited" | "github", message: string) { super(message); }
}

export async function gh<T>(userId: string, path: string): Promise<T> {
  return (await (await ghRaw(userId, path)).json()) as T;
}

/** Authenticated GitHub request returning the raw (ok) Response — used for archive downloads. */
export async function ghRaw(userId: string, path: string): Promise<Response> {
  let token: string;
  try { token = await getGithubAccessToken(userId); }
  catch (e) { if (e instanceof GithubReconnectRequired) throw new GithubError("reconnect", e.message); throw e; }
  let res: Response;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "speed-agent", "X-GitHub-Api-Version": "2022-11-28" },
    });
  } catch { throw new GithubError("github", "GitHub is unreachable, try again"); }
  if (res.ok) return res;
  if (res.status === 401) {
    await d1("UPDATE github_connections SET status = 'reconnect_required', updated_at = datetime('now') WHERE user_id = ?", [userId]);
    throw new GithubError("reconnect", "GitHub access was revoked — please reconnect GitHub");
  }
  if (res.status === 404) throw new GithubError("not_found", "Repository not found or no longer accessible");
  if (res.status === 403 || res.status === 429) {
    const limited = res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429;
    throw limited ? new GithubError("rate_limited", "GitHub rate limit reached, try again shortly") : new GithubError("forbidden", "Your GitHub account doesn't have permission for this");
  }
  throw new GithubError("github", `GitHub request failed (${res.status})`);
}

export type RawRepo = { id: number; name: string; full_name: string; owner: { login: string }; private: boolean; default_branch: string; description: string | null; html_url: string; permissions?: { pull?: boolean; push?: boolean; admin?: boolean } };
export type Repo = { id: number; name: string; fullName: string; owner: string; private: boolean; defaultBranch: string; description: string | null; url: string; canPush: boolean };
export const toRepo = (r: RawRepo): Repo => ({ id: r.id, name: r.name, fullName: r.full_name, owner: r.owner.login, private: r.private, defaultBranch: r.default_branch, description: r.description, url: r.html_url, canPush: !!r.permissions?.push });

/** All repositories the user can access (owner, collaborator, org member), up to 500. */
export async function listRepos(userId: string): Promise<Repo[]> {
  const out: Repo[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh<RawRepo[]>(userId, `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
    out.push(...batch.map(toRepo));
    if (batch.length < 100) break;
  }
  return out;
}
