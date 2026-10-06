// Agent D1 access (binding AGENT_DB). Stores agent runtime state only — references and summaries, never project code or secrets.
import { ctx } from "@backend/context";
import { scrub } from "../tools/guard";

function db(): D1Database {
  const b = ctx().env["AGENT_DB"] as D1Database | undefined;
  if (!b) throw new Error("AGENT_DB binding missing");
  return b;
}
const norm = (p: unknown[]) => p.map((x) => (x === undefined ? null : x));

export async function agentDb<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db().prepare(sql).bind(...norm(params)).all<T>()).results ?? [];
}
export async function agentDbBatch(stmts: { sql: string; params: unknown[] }[]): Promise<void> {
  if (!stmts.length) return;
  const d = db();
  await d.batch(stmts.map((s) => d.prepare(s.sql).bind(...norm(s.params))));
}
/** Redacted, size-capped JSON for persisted metadata so secrets and huge payloads never land in Agent D1. */
export const safeJson = (v: unknown, max = 8_000) => JSON.stringify(scrub(v ?? {})).slice(0, max);
