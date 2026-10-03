import { d1 } from "@backend/d1";

export const SESSION_COOKIE = "speed_session";
// Sessions last until the user signs out or clears browser data (renewed on every use).
export const SESSION_TTL = 60 * 60 * 24 * 365 * 10; // 10 years

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;

export function randomId(bytes = 16) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const it = 100000;
  return `pbkdf2$${it}$${b64(salt)}$${b64(await pbkdf2(password, salt, it))}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [, it, salt, hash] = stored.split("$");
  if (!it || !salt || !hash) return false;
  const got = new Uint8Array(await pbkdf2(password, unb64(salt), Number(it)));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i]! ^ want[i]!;
  return diff === 0;
}

async function sha256(s: string) {
  return b64(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** Creates a session; returns the raw token for the cookie (only its hash is stored). */
export async function createSession(userId: string) {
  const token = randomId(32);
  await d1("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)", [
    await sha256(token), userId, Math.floor(Date.now() / 1000) + SESSION_TTL,
  ]);
  return token;
}

export async function userFromToken(token: string | undefined) {
  if (!token) return null;
  const rows = await d1<{ id: string; email: string; email_verified: number; display_name: string | null; avatar_url: string | null; onboarded: number }>(
    `SELECT u.id, u.email, u.email_verified, p.display_name, p.avatar_url, COALESCE(p.onboarded,0) AS onboarded
     FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN profiles p ON p.user_id = u.id
     WHERE s.id = ? AND s.expires_at > ?`,
    [await sha256(token), Math.floor(Date.now() / 1000)],
  );
  const user = rows[0] ?? null;
  // Sliding renewal: keep active sessions alive indefinitely.
  if (user) await d1("UPDATE sessions SET expires_at = ? WHERE id = ?", [Math.floor(Date.now() / 1000) + SESSION_TTL, await sha256(token)]).catch(() => undefined);
  return user;
}

export async function deleteSession(token: string) {
  await d1("DELETE FROM sessions WHERE id = ?", [await sha256(token)]);
}

export function sessionCookie(token: string, secure: boolean) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}${secure ? "; Secure" : ""}`;
}

/** Finds or creates a user for an OAuth identity. */
export async function upsertOAuthUser(provider: string, providerUserId: string, email: string, name?: string, avatar?: string) {
  const linked = await d1<{ user_id: string }>("SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?", [provider, providerUserId]);
  if (linked[0]) return linked[0].user_id;
  const existing = await d1<{ id: string }>("SELECT id FROM users WHERE email = ?", [email]);
  let userId = existing[0]?.id;
  if (!userId) {
    userId = crypto.randomUUID();
    await d1("INSERT INTO users (id, email, email_verified) VALUES (?, ?, 1)", [userId, email]);
    await d1("INSERT INTO profiles (user_id, display_name, avatar_url) VALUES (?, ?, ?)", [userId, name ?? null, avatar ?? null]);
  }
  await d1("INSERT INTO oauth_accounts (provider, provider_user_id, user_id) VALUES (?, ?, ?)", [provider, providerUserId, userId]);
  return userId;
}
