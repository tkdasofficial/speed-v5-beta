// Integration connection tokens: encrypted at rest in D1, refreshed server-side, never returned to the browser.
import { d1 } from "@backend/d1";
import { envStr } from "@backend/context";
import { INTEGRATIONS, providerConfig, ReauthRequired, type TokenSet } from "@backend/connect/providers";

const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key() {
  const secret = envStr("AUTH_SECRET");
  if (!secret) throw new Error("Server is missing AUTH_SECRET");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`provider-tokens:${secret}`));
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
const now = () => Math.floor(Date.now() / 1000);

export type Row = {
  id: string; user_id: string; integration: string; provider: string; external_account_id: string; account_label: string | null; scope: string | null;
  access_token_enc: string; refresh_token_enc: string | null; access_expires_at: number | null; status: string; metadata: string | null;
  created_at: string; updated_at: string; last_used_at: string | null;
};

/** Creates or updates (same user + integration + provider account) a connection; returns its id. */
export async function saveConnection(userId: string, integration: string, externalId: string, label: string, t: TokenSet, metadata: unknown) {
  const p = INTEGRATIONS[integration]!;
  const rows = await d1<{ id: string }>(
    `INSERT INTO integration_connections (id, user_id, integration, provider, external_account_id, account_label, scope, access_token_enc, refresh_token_enc, access_expires_at, status, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT(user_id, integration, external_account_id) DO UPDATE SET account_label=excluded.account_label, scope=excluded.scope,
       access_token_enc=excluded.access_token_enc, refresh_token_enc=COALESCE(excluded.refresh_token_enc, integration_connections.refresh_token_enc),
       access_expires_at=excluded.access_expires_at, status='active', metadata=excluded.metadata, updated_at=datetime('now')
     RETURNING id`,
    [crypto.randomUUID(), userId, integration, p.provider, externalId, label, t.scope ?? null, await seal(t.access_token),
      t.refresh_token ? await seal(t.refresh_token) : null, t.expires_in ? now() + t.expires_in : null, metadata ? JSON.stringify(metadata) : null],
  );
  return rows[0]!.id;
}

export async function listConnections(userId: string) {
  return d1<Row>("SELECT * FROM integration_connections WHERE user_id = ? ORDER BY created_at", [userId]);
}

/** Loads a connection only if it belongs to the user (prevents cross-user access). */
export async function ownedConnection(userId: string, id: string) {
  return (await d1<Row>("SELECT * FROM integration_connections WHERE id = ? AND user_id = ?", [id, userId]))[0] ?? null;
}

export async function markReauth(id: string) {
  await d1("UPDATE integration_connections SET status = 'reconnect_required', updated_at = datetime('now') WHERE id = ?", [id]);
}

/** Valid access token for a connection, refreshing it within 5 minutes of expiry. */
export async function accessToken(r: Row, force = false): Promise<string> {
  const p = INTEGRATIONS[r.integration];
  if (!p) throw new Error("Unknown integration");
  if (r.status !== "active") throw new ReauthRequired(`${p.name} needs to be reconnected`);
  if (!force && (!r.access_expires_at || r.access_expires_at - 300 > now())) return open(r.access_token_enc);
  const cfg = providerConfig(p.provider);
  if (!r.refresh_token_enc || !cfg) { await markReauth(r.id); throw new ReauthRequired(`${p.name} session expired — please reconnect`); }
  try {
    const t = await p.refresh(cfg, await open(r.refresh_token_enc));
    await d1(
      `UPDATE integration_connections SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc), access_expires_at = ?, updated_at = datetime('now') WHERE id = ?`,
      [await seal(t.access_token), t.refresh_token ? await seal(t.refresh_token) : null, t.expires_in ? now() + t.expires_in : null, r.id],
    );
    return t.access_token;
  } catch (e) {
    if (e instanceof ReauthRequired) await markReauth(r.id);
    throw e;
  }
}

/** Runs a provider call with the connection's token; on a 401 refreshes once and retries, then flags reconnect. */
export async function withToken<T>(r: Row, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    const out = await fn(await accessToken(r));
    await d1("UPDATE integration_connections SET last_used_at = datetime('now') WHERE id = ?", [r.id]);
    return out;
  } catch (e) {
    if (!(e instanceof ReauthRequired) || r.status !== "active" || !r.refresh_token_enc) { if (e instanceof ReauthRequired) await markReauth(r.id); throw e; }
    try { return await fn(await accessToken(r, true)); }
    catch (e2) { if (e2 instanceof ReauthRequired) await markReauth(r.id); throw e2; }
  }
}

/** Revokes provider-side where supported (best effort), then deletes the stored credentials. */
export async function removeConnection(r: Row) {
  const p = INTEGRATIONS[r.integration];
  const cfg = p ? providerConfig(p.provider) : null;
  if (p?.revoke && cfg) {
    try { await p.revoke(cfg, r.refresh_token_enc ? await open(r.refresh_token_enc) : await open(r.access_token_enc)); } catch { /* local removal still proceeds */ }
  }
  await d1("DELETE FROM integration_connections WHERE id = ? AND user_id = ?", [r.id, r.user_id]);
}

export async function setMetadata(id: string, metadata: unknown) {
  await d1("UPDATE integration_connections SET metadata = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(metadata ?? null), id]);
}
