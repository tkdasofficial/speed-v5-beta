// Auth API handlers. Sessions are bearer tokens (only their hash is stored in D1),
// so any allowed frontend origin can sign in without third-party cookies.
import { z } from "zod";
import { d1 } from "../d1";
import { ctx, bearer, requestOrigin, envStr } from "../context";
import { createSession, deleteSession, hashPassword, randomId, userFromToken, verifyPassword } from "@security/session.server";
import { currentUser } from "@security/authorize.server";
import { hashCode, issueVerifyCode, nowText, sendEmail } from "../email/send.server";
import { publish } from "@realtime/publish.server";

const email = z.string().trim().toLowerCase().email().max(255);
const creds = z.object({ email, password: z.string().min(8).max(72) });

function requestMeta() {
  const h = ctx().req.headers;
  const ip = h.get("cf-connecting-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  return { ip, agent: (h.get("user-agent") ?? "unknown").slice(0, 160) };
}

export async function signUp(raw: unknown) {
  const data = creds.parse(raw);
  const exists = await d1("SELECT id FROM users WHERE email = ?", [data.email]);
  if (exists.length) return { ok: false as const, error: "An account with this email already exists" };
  const id = crypto.randomUUID();
  await d1("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)", [id, data.email, await hashPassword(data.password)]);
  await d1("INSERT INTO profiles (user_id) VALUES (?)", [id]);
  const token = await createSession(id);
  await issueVerifyCode(id, data.email);
  return { ok: true as const, token };
}

export async function signIn(raw: unknown) {
  const data = z.object({ email, password: z.string().min(1).max(72) }).parse(raw);
  const [u] = await d1<{ id: string; email: string; password_hash: string | null; email_verified: number }>(
    "SELECT id, email, password_hash, email_verified FROM users WHERE email = ?", [data.email]);
  if (!u?.password_hash || !(await verifyPassword(data.password, u.password_hash))) return { ok: false as const, error: "Incorrect email or password" };
  const token = await createSession(u.id);
  if (u.email_verified) await sendEmail("loginAlert", u.email, { when: nowText(), ...requestMeta() }, { userId: u.id });
  return { ok: true as const, verified: !!u.email_verified, token };
}

export async function verifyEmail(raw: unknown) {
  const data = z.object({ code: z.string().regex(/^\d{8}$/, "Enter the 8-digit code") }).parse(raw);
  const me = await currentUser();
  if (!me) return { ok: false as const, error: "Please log in again" };
  if (me.email_verified) return { ok: true as const };
  const now = Math.floor(Date.now() / 1000);
  const [row] = await d1<{ id: string; code_hash: string; attempts: number; expires_at: number }>(
    "SELECT id, code_hash, attempts, expires_at FROM email_codes WHERE user_id = ? AND purpose = 'verify' ORDER BY created_at DESC LIMIT 1", [me.id]);
  if (!row || row.expires_at < now) return { ok: false as const, error: "This code has expired. Send a new one." };
  if (row.attempts >= 5) return { ok: false as const, error: "Too many attempts. Send a new code." };
  if (row.code_hash !== (await hashCode(data.code))) {
    await d1("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?", [row.id]);
    return { ok: false as const, error: "That code isn't right" };
  }
  await d1("UPDATE users SET email_verified = 1 WHERE id = ?", [me.id]);
  await d1("DELETE FROM email_codes WHERE user_id = ? AND purpose = 'verify'", [me.id]);
  return { ok: true as const };
}

export async function resendVerifyCode() {
  const me = await currentUser();
  if (!me) return { ok: false as const, error: "Please log in again" };
  if (me.email_verified) return { ok: true as const };
  return issueVerifyCode(me.id, me.email);
}

export async function requestPasswordReset(raw: unknown) {
  const data = z.object({ email }).parse(raw);
  const origin = requestOrigin() ?? envStr("ALLOWED_ORIGINS")?.split(",")[0]?.trim();
  const [u] = await d1<{ id: string; email: string }>("SELECT id, email FROM users WHERE email = ?", [data.email]);
  const now = Math.floor(Date.now() / 1000);
  if (u && origin && !origin.includes("*")) {
    const recent = await d1<{ n: number }>("SELECT COUNT(*) AS n FROM email_codes WHERE user_id = ? AND purpose = 'reset' AND created_at > ?", [u.id, now - 60]);
    if (!recent[0]?.n) {
      const token = randomId(32);
      await d1("DELETE FROM email_codes WHERE user_id = ? AND purpose = 'reset'", [u.id]);
      await d1("INSERT INTO email_codes (id, user_id, purpose, code_hash, expires_at, created_at) VALUES (?, ?, 'reset', ?, ?, ?)",
        [crypto.randomUUID(), u.id, await hashCode(token), now + 30 * 60, now]);
      await sendEmail("passwordReset", u.email, { url: `${origin}/auth/reset-password?token=${token}` }, { userId: u.id });
    }
  }
  return { ok: true as const }; // same response whether or not the account exists
}

export async function resetPassword(raw: unknown) {
  const data = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().min(8).max(72) }).parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const [row] = await d1<{ user_id: string; email: string }>(
    "SELECT c.user_id, u.email FROM email_codes c JOIN users u ON u.id = c.user_id WHERE c.purpose = 'reset' AND c.code_hash = ? AND c.expires_at > ?",
    [await hashCode(data.token), now]);
  if (!row) return { ok: false as const, error: "This reset link is invalid or has expired" };
  await d1("UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?", [await hashPassword(data.password), row.user_id]);
  await d1("DELETE FROM email_codes WHERE user_id = ? AND purpose = 'reset'", [row.user_id]);
  await d1("DELETE FROM sessions WHERE user_id = ?", [row.user_id]);
  await sendEmail("accountSecurity", row.email, { change: "Your Speed password was changed and all devices were signed out.", when: nowText() }, { userId: row.user_id });
  return { ok: true as const };
}

export async function signOut() {
  const t = bearer();
  if (t) await deleteSession(t);
  return { ok: true };
}

export async function getMe() {
  return currentUser();
}

export async function saveProfile(raw: unknown) {
  const data = z.object({ fullName: z.string().trim().min(1).max(100), role: z.string().max(40), teamType: z.string().max(40) }).parse(raw);
  const me = await userFromToken(bearer());
  if (!me) return { ok: false as const, error: "Please log in again" };
  await d1(
    `INSERT INTO profiles (user_id, display_name, role, company, onboarded, updated_at) VALUES (?, ?, ?, ?, 1, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name, role=excluded.role, company=excluded.company, onboarded=1, updated_at=datetime('now')`,
    [me.id, data.fullName, data.role, data.teamType],
  );
  const [row] = await d1<{ display_name: string | null; avatar_url: string | null; version: number }>(
    "UPDATE profiles SET version = version + 1 WHERE user_id = ? RETURNING display_name, avatar_url, version", [me.id]);
  if (row) await publish(me.id, "profile", "upsert", me.id, row.version, { email: me.email, displayName: row.display_name, avatarUrl: row.avatar_url, version: row.version });
  return { ok: true as const };
}

/** GitHub connection state for the signed-in user (never returns tokens). */
export async function getGithubConnection() {
  const { requireUser } = await import("@security/authorize.server");
  const { githubStatus } = await import("@security/github.server");
  return githubStatus((await requireUser()).id);
}
