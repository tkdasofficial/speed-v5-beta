// GitHub user tokens: encrypted at rest in D1, refreshed server-side, never returned to the browser.
import { d1 } from "@backend/d1";
import { envStr } from "@backend/context";

const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key() {
  const secret = envStr("AUTH_SECRET");
  if (!secret) throw new Error("Server is missing AUTH_SECRET");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`github-tokens:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(v: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), enc.encode(v));
  return `${b64(iv)}.${b64(ct)}`;
}
async function open(v: string) {
  const [iv, ct] = v.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv!) }, await key(), unb64(ct!));
  return new TextDecoder().decode(pt);
}

export type GithubTokens = { access_token: string; refresh_token?: string | undefined; expires_in?: number | undefined; refresh_token_expires_in?: number | undefined; scope?: string | undefined };
const now = () => Math.floor(Date.now() / 1000);

export async function saveGithubTokens(userId: string, githubUserId: string, login: string, t: GithubTokens) {
  await d1(
    `INSERT INTO github_connections (user_id, github_user_id, login, scope, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET github_user_id=excluded.github_user_id, login=excluded.login, scope=excluded.scope,
       access_token_enc=excluded.access_token_enc, refresh_token_enc=excluded.refresh_token_enc, access_expires_at=excluded.access_expires_at,
       refresh_expires_at=excluded.refresh_expires_at, status='active', updated_at=datetime('now')`,
    [userId, githubUserId, login, t.scope ?? null, await seal(t.access_token), t.refresh_token ? await seal(t.refresh_token) : null,
      t.expires_in ? now() + t.expires_in : null, t.refresh_token_expires_in ? now() + t.refresh_token_expires_in : null],
  );
}

export class GithubReconnectRequired extends Error {
  constructor() { super("GitHub connection expired — please reconnect GitHub"); }
}

type Row = { github_user_id: string; login: string; access_token_enc: string; refresh_token_enc: string | null; access_expires_at: number | null; refresh_expires_at: number | null; status: string };

/** Returns a valid GitHub access token for the user, refreshing it when within 5 minutes of expiry. */
export async function getGithubAccessToken(userId: string): Promise<string> {
  const r = (await d1<Row>("SELECT * FROM github_connections WHERE user_id = ?", [userId]))[0];
  if (!r || r.status !== "active") throw new GithubReconnectRequired();
  if (!r.access_expires_at || r.access_expires_at - 300 > now()) return open(r.access_token_enc);
  if (!r.refresh_token_enc || (r.refresh_expires_at && r.refresh_expires_at <= now())) return invalidate(userId);
  const id = envStr("GITHUB_CLIENT_ID"), secret = envStr("GITHUB_CLIENT_SECRET");
  if (!id || !secret) throw new Error("GitHub sign-in is not configured");
  let t: GithubTokens & { error?: string };
  try {
    t = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: "refresh_token", refresh_token: await open(r.refresh_token_enc) }),
    }).then((x) => x.json() as Promise<GithubTokens & { error?: string }>);
  } catch { throw new Error("GitHub is unreachable, try again"); }
  if (!t.access_token) return invalidate(userId);
  await saveGithubTokens(userId, r.github_user_id, r.login, t);
  return t.access_token;
}

async function invalidate(userId: string): Promise<never> {
  await d1("UPDATE github_connections SET status = 'reconnect_required', updated_at = datetime('now') WHERE user_id = ?", [userId]);
  throw new GithubReconnectRequired();
}

export async function githubStatus(userId: string) {
  const r = (await d1<{ login: string; status: string; scope: string | null }>("SELECT login, status, scope FROM github_connections WHERE user_id = ?", [userId]))[0];
  return r ? { connected: r.status === "active", reconnectRequired: r.status !== "active", login: r.login, scope: r.scope } : { connected: false, reconnectRequired: false, login: null, scope: null };
}
