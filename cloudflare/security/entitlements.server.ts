// Authoritative entitlements derived from the server-side subscriptions table
// (kept in sync by the verified Stripe webhook). Never derived from client input.
import { d1 } from "@backend/d1";

export type Plan = "free" | "pro";
export type Entitlements = { plan: Plan; active: boolean; maxProjects: number; periodEnd: number | null };

const LIMITS: Record<Plan, number> = { free: 5, pro: 1000 };

export async function getEntitlements(userId: string): Promise<Entitlements> {
  const rows = await d1<{ plan: string; status: string; current_period_end: number | null }>(
    "SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = ?",
    [userId],
  );
  const s = rows[0];
  const now = Math.floor(Date.now() / 1000);
  const active = !!s && (s.status === "active" || s.status === "trialing") && (!s.current_period_end || s.current_period_end > now);
  const plan: Plan = active && s?.plan === "pro" ? "pro" : "free";
  return { plan, active, maxProjects: LIMITS[plan], periodEnd: s?.current_period_end ?? null };
}

export async function assertCanCreateProject(userId: string) {
  const ent = await getEntitlements(userId);
  const [row] = await d1<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?", [userId]);
  if ((row?.n ?? 0) >= ent.maxProjects) {
    const { sendEmail, emailForUser } = await import("@backend/email/send.server");
    const to = await emailForUser(userId);
    if (to) await sendEmail("usage", to, { title: "Project limit reached", body: `You've reached the ${ent.maxProjects}-project limit on your ${ent.plan} plan. Delete a project or upgrade to create more.` },
      { userId, dedupeKey: `limit:projects:${userId}:${ent.plan}:${new Date().toISOString().slice(0, 10)}` });
    const { AuthError } = await import("./authorize.server");
    throw new AuthError(403, `Your ${ent.plan} plan allows ${ent.maxProjects} projects`);
  }
}
