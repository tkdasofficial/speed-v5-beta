// Registry of "connect your account" integrations (distinct from sign-in providers in ../oauth.ts).
// Callback path for each: /oauth/<provider>/callback or /oauth/<provider>/<service>/callback.
import { envStr } from "../context";

export type TokenSet = { access_token: string; refresh_token?: string | undefined; expires_in?: number | undefined; scope?: string | undefined };
export type Cfg = { id: string; secret: string };
export type Identity = { externalId: string; label: string };
export type Verify = { ok: true; summary: string; metadata?: Record<string, unknown> };

/** Thrown when the provider rejects the credential (revoked / invalid). */
export class ReauthRequired extends Error {}

export type Integration = {
  id: string;            // stable id, also the D1 `integration` column
  provider: string;      // OAuth provider; selects the Secrets Store credentials
  name: string;
  callbackPath: string;
  authorize: (cfg: Cfg, redirect: string, state: string, challenge: string) => string;
  exchange: (cfg: Cfg, code: string, redirect: string, verifier: string) => Promise<TokenSet>;
  refresh: (cfg: Cfg, refreshToken: string) => Promise<TokenSet>;
  identify: (token: string) => Promise<Identity>;
  verify: (token: string) => Promise<Verify>;
  revoke?: (cfg: Cfg, token: string) => Promise<void>;
};

async function tokenCall(url: string, cfg: Cfg, body: Record<string, string>, name: string): Promise<TokenSet> {
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: `Basic ${btoa(`${cfg.id}:${cfg.secret}`)}` },
      body: new URLSearchParams(body),
    });
  } catch { throw new Error(`Could not reach ${name}, please try again`); }
  const t = (await r.json().catch(() => ({}))) as Partial<TokenSet> & { error?: string };
  if (t.error === "invalid_grant") throw new ReauthRequired(`${name} access was revoked — please reconnect`);
  if (!r.ok || !t.access_token) throw new Error(`${name} authorization failed`);
  return t as TokenSet;
}

/** GET a provider JSON API; 401 → ReauthRequired, other failures → sanitized error. */
async function api<T>(url: string, token: string, name: string): Promise<T> {
  let r: Response;
  try { r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }); }
  catch { throw new Error(`Could not reach ${name}, please try again`); }
  if (r.status === 401) throw new ReauthRequired(`${name} access was revoked — please reconnect`);
  if (r.status === 403) throw new Error(`${name} denied access — the required permission was not granted`);
  if (!r.ok) throw new Error(`${name} request failed (${r.status})`);
  return r.json() as Promise<T>;
}

// ---------- Supabase (Management API) ----------
const SB = "https://api.supabase.com/v1";
const supabase: Integration = {
  id: "supabase", provider: "supabase", name: "Supabase", callbackPath: "/oauth/supabase/callback",
  authorize: (cfg, redirect, state, challenge) =>
    `${SB}/oauth/authorize?${new URLSearchParams({ client_id: cfg.id, redirect_uri: redirect, response_type: "code", state, code_challenge: challenge, code_challenge_method: "S256" })}`,
  exchange: (cfg, code, redirect, verifier) =>
    tokenCall(`${SB}/oauth/token`, cfg, { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }, "Supabase"),
  refresh: (cfg, rt) => tokenCall(`${SB}/oauth/token`, cfg, { grant_type: "refresh_token", refresh_token: rt }, "Supabase"),
  identify: async (token) => {
    const orgs = await api<{ id: string; name: string }[]>(`${SB}/organizations`, token, "Supabase");
    if (!orgs.length) throw new Error("No Supabase organization was authorized");
    const ids = orgs.map((o) => o.id).sort();
    return { externalId: ids.join(","), label: orgs.map((o) => o.name).join(", ") };
  },
  verify: async (token) => {
    const [orgs, projects] = await Promise.all([
      api<{ id: string; name: string }[]>(`${SB}/organizations`, token, "Supabase"),
      api<{ id: string; name: string; region: string; status: string; organization_id: string }[]>(`${SB}/projects`, token, "Supabase"),
    ]);
    return {
      ok: true,
      summary: `${orgs.length} organization${orgs.length === 1 ? "" : "s"}, ${projects.length} project${projects.length === 1 ? "" : "s"}`,
      metadata: { organizations: orgs.map((o) => o.name), projects: projects.slice(0, 50).map((p) => ({ name: p.name, region: p.region, status: p.status })) },
    };
  },
};

// ---------- Google (one OAuth implementation, per-service scopes + checks) ----------
const GOOGLE_BASE = ["openid", "email", "profile"];
const G = (s: string) => `https://www.googleapis.com/auth/${s}`;
function google(service: string, name: string, scopes: string[], verify: Integration["verify"]): Integration {
  return {
    id: `google_${service}`, provider: "google", name, callbackPath: `/oauth/google/${service}/callback`,
    authorize: (cfg, redirect, state, challenge) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: cfg.id, redirect_uri: redirect, response_type: "code", state,
        scope: [...GOOGLE_BASE, ...scopes].join(" "),
        access_type: "offline", prompt: "select_account consent", include_granted_scopes: "false",
        code_challenge: challenge, code_challenge_method: "S256",
      })}`,
    exchange: (cfg, code, redirect, verifier) =>
      tokenCall("https://oauth2.googleapis.com/token", cfg, { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }, name),
    refresh: (cfg, rt) => tokenCall("https://oauth2.googleapis.com/token", cfg, { grant_type: "refresh_token", refresh_token: rt }, name),
    identify: async (token) => {
      const u = await api<{ sub: string; email?: string; email_verified?: boolean; name?: string }>("https://openidconnect.googleapis.com/v1/userinfo", token, "Google");
      return { externalId: u.sub, label: u.email ?? u.name ?? "Google account" };
    },
    verify,
    revoke: async (_cfg, token) => {
      await fetch(`https://oauth2.googleapis.com/revoke?${new URLSearchParams({ token })}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }).catch(() => {});
    },
  };
}
const driveCount = async (token: string, mime: string, name: string, kind: string): Promise<Verify> => {
  const r = await api<{ files: { name: string }[] }>(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q: `mimeType='${mime}' and trashed=false`, pageSize: "10", fields: "files(name)", orderBy: "modifiedTime desc" })}`, token, name);
  return { ok: true, summary: r.files.length ? `Recent ${kind}: ${r.files.slice(0, 3).map((f) => f.name).join(", ")}` : `Access verified — no ${kind} yet`, metadata: { recent: r.files.map((f) => f.name) } };
};

const googleDrive = google("drive", "Google Drive", [G("drive.readonly")], async (t) => {
  const r = await api<{ user?: { emailAddress?: string }; storageQuota?: { usage?: string; limit?: string } }>("https://www.googleapis.com/drive/v3/about?fields=user,storageQuota", t, "Google Drive");
  const gb = (v?: string) => (v ? `${(Number(v) / 1e9).toFixed(1)} GB` : "unlimited");
  return { ok: true, summary: `Drive access verified — ${gb(r.storageQuota?.usage)} of ${gb(r.storageQuota?.limit)} used` };
});
const gmail = google("gmail", "Gmail", [G("gmail.readonly"), G("gmail.send")], async (t) => {
  const r = await api<{ emailAddress: string; messagesTotal: number }>("https://gmail.googleapis.com/gmail/v1/users/me/profile", t, "Gmail");
  return { ok: true, summary: `Mailbox ${r.emailAddress} verified — ${r.messagesTotal.toLocaleString()} messages` };
});
const sheets = google("sheets", "Google Sheets", [G("spreadsheets"), G("drive.metadata.readonly")],
  (t) => driveCount(t, "application/vnd.google-apps.spreadsheet", "Google Sheets", "spreadsheets"));
const docs = google("docs", "Google Docs", [G("documents"), G("drive.metadata.readonly")],
  (t) => driveCount(t, "application/vnd.google-apps.document", "Google Docs", "documents"));
const calendar = google("calendar", "Google Calendar", [G("calendar.readonly"), G("calendar.events")], async (t) => {
  const r = await api<{ items: { summary: string; primary?: boolean }[] }>("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=50", t, "Google Calendar");
  return { ok: true, summary: `${r.items.length} calendar${r.items.length === 1 ? "" : "s"} available`, metadata: { calendars: r.items.map((c) => c.summary) } };
});

export const INTEGRATIONS: Record<string, Integration> = Object.fromEntries(
  [supabase, googleDrive, gmail, sheets, docs, calendar].map((i) => [i.id, i]),
);

/** Resolves /oauth/<a>[/<b>]/callback to an integration, or null for sign-in providers. */
export function integrationForCallback(path: string): Integration | null {
  return Object.values(INTEGRATIONS).find((i) => i.callbackPath === path.replace(/\/$/, "")) ?? null;
}

export function providerConfig(provider: string): Cfg | null {
  const key = provider.toUpperCase();
  const id = envStr(`${key}_CLIENT_ID`);
  const secret = envStr(`${key}_CLIENT_SECRET`);
  return id && secret ? { id, secret } : null;
}

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function pkce() {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}
