// Stripe webhook verification and subscription → entitlement persistence.
// Inactive until STRIPE_WEBHOOK_SECRET is configured.
import { d1 } from "@backend/d1";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

export async function verifyStripeSignature(payload: string, header: string | null, secret: string, toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts["t"]);
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
  return sigs.some((s) => {
    if (s.length !== want.length) return false;
    let d = 0;
    for (let i = 0; i < s.length; i++) d |= s.charCodeAt(i) ^ want.charCodeAt(i);
    return d === 0;
  });
}

type StripeSub = { id: string; customer: string; status: string; current_period_end?: number; metadata?: { user_id?: string; plan?: string } };

export async function applySubscription(sub: StripeSub) {
  const userId = sub.metadata?.user_id
    ?? (await d1<{ user_id: string }>("SELECT user_id FROM subscriptions WHERE stripe_customer_id = ?", [sub.customer]))[0]?.user_id;
  if (!userId) return null;
  await d1(
    `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id=excluded.stripe_customer_id, stripe_subscription_id=excluded.stripe_subscription_id,
       plan=excluded.plan, status=excluded.status, current_period_end=excluded.current_period_end, updated_at=datetime('now')`,
    [userId, sub.customer, sub.id, sub.metadata?.plan === "pro" ? "pro" : "free", sub.status, sub.current_period_end ?? null],
  );
  return userId;
}
