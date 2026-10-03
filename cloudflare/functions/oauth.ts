import { envStr } from "./context";
export const PROVIDERS = ["google", "github", "gitlab", "bitbucket"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const isProvider = (p: string): p is Provider => (PROVIDERS as readonly string[]).includes(p);

// The OAuth callback always lives on the API Worker itself: /oauth/<provider>/callback.
export const callbackUrl = (request: Request, p: Provider) => `${new URL(request.url).origin}/oauth/${p}/callback`;

export function providerConfig(p: Provider) {
  const key = p.toUpperCase();
  const id = envStr(`${key}_CLIENT_ID`);
  const secret = envStr(`${key}_CLIENT_SECRET`);
  return id && secret ? { id, secret } : null;
}

export function authorizeUrl(p: Provider, clientId: string, redirect: string, state: string) {
  const base = { client_id: clientId, redirect_uri: redirect, state };
  switch (p) {
    case "google":
      return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ ...base, response_type: "code", scope: "openid email profile", prompt: "select_account" })}`;
    case "github":
      return `https://github.com/login/oauth/authorize?${new URLSearchParams({ ...base, scope: "read:user user:email repo", allow_signup: "true" })}`;
    case "gitlab":
      return `https://gitlab.com/oauth/authorize?${new URLSearchParams({ ...base, response_type: "code", scope: "read_user" })}`;
    case "bitbucket":
      return `https://bitbucket.org/site/oauth2/authorize?${new URLSearchParams({ ...base, response_type: "code" })}`;
  }
}

type Identity = { id: string; email: string; name?: string | undefined; avatar?: string | undefined; login?: string; tokens?: import("@security/github.server").GithubTokens };
const form = (o: Record<string, string>) => new URLSearchParams(o);

export async function fetchIdentity(p: Provider, code: string, redirect: string, cfg: { id: string; secret: string }): Promise<Identity> {
  if (p === "google") {
    const t = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ code, client_id: cfg.id, client_secret: cfg.secret, redirect_uri: redirect, grant_type: "authorization_code" }),
    }).then((r) => r.json() as Promise<{ access_token?: string }>);
    if (!t.access_token) throw new Error("Google sign-in failed");
    const u = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } })
      .then((r) => r.json() as Promise<{ sub: string; email: string; email_verified: boolean; name?: string; picture?: string }>);
    if (!u.email || !u.email_verified) throw new Error("Google account email is not verified");
    return { id: u.sub, email: u.email.toLowerCase(), name: u.name, avatar: u.picture };
  }
  if (p === "github") {
    const t = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: cfg.id, client_secret: cfg.secret, code, redirect_uri: redirect }),
    }).then((r) => r.json() as Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string; error?: string }>)
      .catch(() => { throw new Error("Could not reach GitHub, please try again"); });
    if (!t.access_token) throw new Error(t.error === "bad_verification_code" ? "Sign-in expired, please try again" : "GitHub sign-in failed");
    const h = { Authorization: `Bearer ${t.access_token}`, "User-Agent": "speed-agent", Accept: "application/vnd.github+json" };
    const ur = await fetch("https://api.github.com/user", { headers: h });
    if (!ur.ok) throw new Error("Could not load your GitHub profile");
    const u = (await ur.json()) as { id: number; name?: string; login: string; avatar_url?: string };
    const er = await fetch("https://api.github.com/user/emails", { headers: h });
    if (!er.ok) throw new Error("Could not load your GitHub email");
    const emails = (await er.json()) as { email: string; primary: boolean; verified: boolean }[];
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    if (!primary) throw new Error("GitHub account has no verified email");
    return { id: String(u.id), email: primary.email.toLowerCase(), name: u.name ?? u.login, avatar: u.avatar_url, login: u.login,
      tokens: { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in, refresh_token_expires_in: t.refresh_token_expires_in, scope: t.scope } };
  }
  if (p === "gitlab") {
    const t = await fetch("https://gitlab.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form({ code, client_id: cfg.id, client_secret: cfg.secret, redirect_uri: redirect, grant_type: "authorization_code" }),
    }).then((r) => r.json() as Promise<{ access_token?: string }>);
    if (!t.access_token) throw new Error("GitLab sign-in failed");
    const u = await fetch("https://gitlab.com/api/v4/user", { headers: { Authorization: `Bearer ${t.access_token}` } })
      .then((r) => r.json() as Promise<{ id: number; username: string; name?: string; email?: string; confirmed_at?: string | null; avatar_url?: string }>);
    if (!u.email || !u.confirmed_at) throw new Error("GitLab account email is not verified");
    return { id: String(u.id), email: u.email.toLowerCase(), name: u.name ?? u.username, avatar: u.avatar_url };
  }
  // bitbucket
  const t = await fetch("https://bitbucket.org/site/oauth2/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${cfg.id}:${cfg.secret}`)}` },
    body: form({ code, grant_type: "authorization_code", redirect_uri: redirect }),
  }).then((r) => r.json() as Promise<{ access_token?: string }>);
  if (!t.access_token) throw new Error("Bitbucket sign-in failed");
  const h = { Authorization: `Bearer ${t.access_token}` };
  const u = await fetch("https://api.bitbucket.org/2.0/user", { headers: h })
    .then((r) => r.json() as Promise<{ uuid: string; display_name?: string; nickname?: string; links?: { avatar?: { href?: string } } }>);
  const emails = await fetch("https://api.bitbucket.org/2.0/user/emails", { headers: h })
    .then((r) => r.json() as Promise<{ values?: { email: string; is_primary: boolean; is_confirmed: boolean }[] }>);
  const list = emails.values ?? [];
  const primary = list.find((e) => e.is_primary && e.is_confirmed) ?? list.find((e) => e.is_confirmed);
  if (!primary) throw new Error("Bitbucket account has no verified email");
  return { id: u.uuid, email: primary.email.toLowerCase(), name: u.display_name ?? u.nickname, avatar: u.links?.avatar?.href };
}
