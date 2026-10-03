// Single send entry point for every allowed email type. Server-only.
// Optional dedupeKey makes a send idempotent (recorded in email_log).
import { d1 } from "@backend/d1";
import { smtpSend } from "./smtp.server";
import { templates, type TemplateName } from "./templates.server";

export async function sendEmail<T extends TemplateName>(
  name: T,
  to: string,
  props: Parameters<(typeof templates)[T]>[0],
  opts: { userId?: string; dedupeKey?: string } = {},
) {
  if (opts.dedupeKey) {
    const r = await d1<{ key: string }>("INSERT OR IGNORE INTO email_log (key, kind, user_id) VALUES (?, ?, ?) RETURNING key", [opts.dedupeKey, name, opts.userId ?? null]);
    if (!r[0]) return { sent: false as const, reason: "duplicate" };
  }
  const t = (templates[name] as (p: typeof props) => { subject: string; html: string; text: string })(props);
  try {
    await smtpSend({ to, subject: t.subject, html: t.html, text: t.text });
    return { sent: true as const };
  } catch (e) {
    if (opts.dedupeKey) await d1("DELETE FROM email_log WHERE key = ?", [opts.dedupeKey]).catch(() => {});
    console.error(`[email] ${name} failed:`, (e as Error).message);
    return { sent: false as const, reason: "send_failed" };
  }
}

export async function emailForUser(userId: string) {
  return (await d1<{ email: string }>("SELECT email FROM users WHERE id = ?", [userId]))[0]?.email ?? null;
}

const enc = new TextEncoder();
export async function hashCode(s: string) {
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))));
}

export function otp8() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 100000000;
  return n.toString().padStart(8, "0");
}

/** Issues a fresh verification OTP (rate-limited to one per 60s) and emails it. */
export async function issueVerifyCode(userId: string, email: string) {
  const now = Math.floor(Date.now() / 1000);
  const recent = await d1<{ n: number }>("SELECT COUNT(*) AS n FROM email_codes WHERE user_id = ? AND purpose = 'verify' AND created_at > ?", [userId, now - 60]);
  if ((recent[0]?.n ?? 0) > 0) return { ok: false as const, error: "Please wait a minute before requesting another code" };
  const code = otp8();
  await d1("DELETE FROM email_codes WHERE user_id = ? AND purpose = 'verify'", [userId]);
  await d1("INSERT INTO email_codes (id, user_id, purpose, code_hash, expires_at, created_at) VALUES (?, ?, 'verify', ?, ?, ?)",
    [crypto.randomUUID(), userId, await hashCode(code), now + 15 * 60, now]);
  const r = await sendEmail("verifyEmail", email, { code }, { userId });
  return r.sent ? { ok: true as const } : { ok: false as const, error: "We couldn't send the email. Try again shortly." };
}

export const nowText = () => new Date().toUTCString();
