// Deploy-time setup: finds or creates the "sandbox" D1 database and applies its migrations, plus pending
// main-database migrations from cloudflare/migrations (tracked in a _migrations table). Idempotent.
import { readdirSync, readFileSync } from "node:fs";
const env = process.env;
const API = `https://api.cloudflare.com/client/v4/accounts/${env["CLOUDFLARE_ACCOUNT_ID"]}/d1/database`;
const H = { Authorization: `Bearer ${env["CLOUDFLARE_API_TOKEN"]}`, "Content-Type": "application/json" };

async function cf<T>(path: string, init?: RequestInit): Promise<T> {
  const r = (await (await fetch(`${API}${path}`, { ...init, headers: H })).json()) as { success: boolean; result: T; errors: unknown };
  if (!r.success) throw new Error(`D1 API ${path}: ${JSON.stringify(r.errors)}`);
  return r.result;
}
export const query = (db: string, sql: string, params: unknown[] = []) => cf<{ results: Record<string, unknown>[] }[]>(`/${db}/query`, { method: "POST", body: JSON.stringify({ sql, params }) });

export async function migrate(db: string, dir: string) {
  await query(db, "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");
  const done = new Set(((await query(db, "SELECT name FROM _migrations"))[0]?.results ?? []).map((r) => String(r["name"])));
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    await query(db, readFileSync(`${dir}/${f}`, "utf8"));
    await query(db, "INSERT INTO _migrations (name) VALUES (?)", [f]);
    console.log(`applied ${f}`);
  }
}

export async function ensureSandboxDb(): Promise<string> {
  const list = await cf<{ uuid: string; name: string }[]>(`?name=sandbox`);
  const id = list.find((d) => d.name === "sandbox")?.uuid ?? (await cf<{ uuid: string }>("", { method: "POST", body: JSON.stringify({ name: "sandbox" }) })).uuid;
  await migrate(id, `${import.meta.dir}/../migrations-sandbox`);
  return id;
}
