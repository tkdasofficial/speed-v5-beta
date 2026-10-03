// Cloudflare D1 access through the Worker's native `DB` binding. Backend-only.
import { ctx } from "./context";

export async function d1<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await ctx().env.DB.prepare(sql).bind(...params.map((p) => (p === undefined ? null : p))).all<T>();
  return r.results ?? [];
}

/** Runs many statements in one round trip (atomic in D1). */
export async function d1Batch(stmts: { sql: string; params: unknown[] }[]): Promise<void> {
  if (!stmts.length) return;
  const db = ctx().env.DB;
  await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params.map((p) => (p === undefined ? null : p)))));
}
