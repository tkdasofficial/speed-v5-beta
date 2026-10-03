// Integrations RPCs. Every call authenticates the user and only touches that user's connections.
// The browser receives safe metadata and authorize URLs — never tokens.
import { z } from "zod";

const IntegrationId = z.enum(["supabase", "google_drive", "google_gmail", "google_sheets", "google_docs", "google_calendar"]);
const Target = z.union([z.object({ integration: z.literal("github") }), z.object({ connectionId: z.string().uuid() })]);

type SafeConnection = { id: string; integration: string; account: string; status: "connected" | "reconnect_required"; scopes: string[]; connectedAt: string; lastUsedAt: string | null; metadata: unknown };

async function base(withUser = true) {
  const { requireUser, AuthError } = await import("@security/authorize.server");
  const store = await import("@security/connections.server");
  const reg = await import("../connect/providers");
  return { me: withUser ? await requireUser() : (null as never), AuthError, store, reg };
}

async function githubConnection(userId: string): Promise<SafeConnection | null> {
  const { d1 } = await import("../d1");
  const r = (await d1<{ login: string; status: string; scope: string | null; updated_at: string }>("SELECT login, status, scope, updated_at FROM github_connections WHERE user_id = ?", [userId]))[0];
  if (!r) return null;
  return { id: "github", integration: "github", account: r.login, status: r.status === "active" ? "connected" : "reconnect_required", scopes: (r.scope ?? "").split(/[ ,]+/).filter(Boolean), connectedAt: r.updated_at, lastUsedAt: null, metadata: null };
}

export async function listIntegrations() {
  const { me, store } = await base();
  const rows = await store.listConnections(me.id);
  const gh = await githubConnection(me.id);
  const list: SafeConnection[] = rows.map((r) => ({
    id: r.id, integration: r.integration, account: r.account_label ?? r.external_account_id,
    status: r.status === "active" ? "connected" : "reconnect_required",
    scopes: (r.scope ?? "").split(" ").filter(Boolean), connectedAt: r.created_at, lastUsedAt: r.last_used_at,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
  }));
  return gh ? [gh, ...list] : list;
}

export async function integrationConnect(raw: unknown) {
  const { integration, origin } = z.object({ integration: IntegrationId, origin: z.string().url() }).parse(raw);
  const { me } = await base();
  const { ctx } = await import("../context");
  return startIntegrationConnect(me.id, integration, origin, new URL(ctx().req.url).origin);
}

/** Starts an OAuth connection for `userId` and returns the authorize URL the user must open (shared by the RPC and the agent tool). */
export async function startIntegrationConnect(userId: string, integration: z.infer<typeof IntegrationId>, origin: string, callbackOrigin: string) {
  const { AuthError, reg } = await base(false);
  const { isAllowedOrigin } = await import("../context");
  const { randomId } = await import("@security/session.server");
  const { d1 } = await import("../d1");
  const p = reg.INTEGRATIONS[integration]!;
  if (!isAllowedOrigin(origin)) throw new AuthError(403, "Origin not allowed");
  const cfg = reg.providerConfig(p.provider);
  if (!cfg) throw new AuthError(503, `${p.name} is not configured yet`);
  const state = randomId(24);
  const { verifier, challenge } = await reg.pkce();
  const t = Math.floor(Date.now() / 1000);
  await d1("DELETE FROM oauth_states WHERE expires_at < ?", [t]);
  await d1("INSERT INTO oauth_states (state, user_id, integration, origin, verifier, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [state, userId, integration, origin.replace(/\/$/, ""), verifier, t + 600]);
  return { url: p.authorize(cfg, `${callbackOrigin}${p.callbackPath}`, state, challenge), expiresInSeconds: 600 };
}
export const INTEGRATION_IDS = IntegrationId.options;

export async function integrationTest(raw: unknown) {
  const target = Target.parse(raw);
  const { me, AuthError, store, reg } = await base();
  if ("integration" in target) {
    const gh = await import("../github/client.server");
    try {
      const u = (await (await gh.ghRaw(me.id, "/user")).json()) as { login: string; public_repos: number; total_private_repos?: number };
      return { ok: true, summary: `Signed in as ${u.login} — ${u.public_repos + (u.total_private_repos ?? 0)} repositories` };
    } catch (e) { return { ok: false, reconnect: e instanceof gh.GithubError && e.code === "reconnect", summary: (e as Error).message }; }
  }
  const r = await store.ownedConnection(me.id, target.connectionId);
  if (!r) throw new AuthError(404, "Connection not found");
  const p = reg.INTEGRATIONS[r.integration]!;
  try {
    const v = await store.withToken(r, p.verify);
    if (v.metadata) await store.setMetadata(r.id, v.metadata);
    return { ok: true, summary: v.summary };
  } catch (e) {
    return { ok: false, reconnect: e instanceof reg.ReauthRequired, summary: e instanceof Error ? e.message : `${p.name} check failed` };
  }
}

export async function integrationDisconnect(raw: unknown) {
  const target = Target.parse(raw);
  const { me } = await base();
  return disconnectIntegrationFor(me.id, target);
}

/** Revokes and removes one of `userId`'s connections (shared by the RPC and the agent tool). */
export async function disconnectIntegrationFor(userId: string, target: z.infer<typeof Target>) {
  const { AuthError, store } = await base(false);
  if ("integration" in target) {
    const { d1 } = await import("../d1");
    const { getGithubAccessToken } = await import("@security/github.server");
    const { providerConfig } = await import("../connect/providers");
    const cfg = providerConfig("github");
    const [had] = await d1<{ user_id: string }>("SELECT user_id FROM github_connections WHERE user_id = ?", [userId]);
    if (!had) throw new AuthError(404, "GitHub is not connected");
    try {
      const token = await getGithubAccessToken(userId);
      if (cfg) await fetch(`https://api.github.com/applications/${cfg.id}/grant`, {
        method: "DELETE",
        headers: { Authorization: `Basic ${btoa(`${cfg.id}:${cfg.secret}`)}`, Accept: "application/vnd.github+json", "User-Agent": "speed-agent", "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: token }),
      });
    } catch { /* already invalid — local removal still proceeds */ }
    await d1("DELETE FROM github_connections WHERE user_id = ?", [userId]);
    return { ok: true, removed: "github" };
  }
  const r = await store.ownedConnection(userId, target.connectionId);
  if (!r) throw new AuthError(404, "Connection not found");
  await store.removeConnection(r);
  return { ok: true, removed: r.integration };
}
export const DisconnectTarget = Target;
