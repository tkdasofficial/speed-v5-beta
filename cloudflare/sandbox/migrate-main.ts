// Applies a single main-D1 migration by file name (main DB history predates _migrations tracking).
// Usage: bun cloudflare/sandbox/migrate-main.ts 009_tasks.sql
import { readFileSync } from "node:fs";
import { query } from "./setup";
const db = process.env["CLOUDFLARE_D1_DATABASE_ID"]!; const f = process.argv[2]!;
await query(db, readFileSync(`${import.meta.dir}/../migrations/${f}`, "utf8"));
console.log(`applied ${f}`);
