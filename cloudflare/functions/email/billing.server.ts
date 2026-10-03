// Maps verified Stripe events to billing emails. Server-only; deduped by Stripe event id.
import { d1 } from "@backend/d1";
import { emailForUser, sendEmail } from "./send.server";

type Ev = { id: string; type: string; data: { object: Record<string, unknown> } };

const money = (cents: unknown, cur: unknown) =>
  typeof cents === "number" ? `${(cents / 100).toFixed(2)} ${String(cur ?? "").toUpperCase()}` : "";

export async function notifyBilling(ev: Ev, userId: string | null) {
  const o = ev.data.object;
  const uid = userId ?? (await d1<{ user_id: string }>("SELECT user_id FROM subscriptions WHERE stripe_customer_id = ?", [String(o["customer"] ?? "")]))[0]?.user_id;
  if (!uid) return;
  const to = await emailForUser(uid);
  if (!to) return;
  const key = { dedupeKey: `stripe:${ev.id}`, userId: uid };
  if (ev.type === "invoice.payment_succeeded") {
    const lines = [`Amount: ${money(o["amount_paid"], o["currency"])}`];
    if (typeof o["hosted_invoice_url"] === "string") lines.push(`Invoice: ${o["hosted_invoice_url"]}`);
    return sendEmail("billing", to, { title: "Payment received", body: "Thanks — your payment was successful.", lines }, key);
  }
  if (ev.type === "invoice.payment_failed") {
    return sendEmail("billing", to, { title: "Payment failed", body: "We couldn't process your latest payment. Please update your payment method to keep your plan.", lines: [`Amount due: ${money(o["amount_due"], o["currency"])}`] }, key);
  }
  if (ev.type === "customer.subscription.created" || ev.type === "customer.subscription.updated" || ev.type === "customer.subscription.deleted") {
    const status = ev.type.endsWith("deleted") ? "canceled" : String(o["status"] ?? "updated");
    return sendEmail("billing", to, { title: "Subscription updated", body: `Your Speed subscription is now ${status}.` }, key);
  }
  return undefined;
}
