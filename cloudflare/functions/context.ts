/// <reference types="node" />
// Request-scoped context for the Speed API Worker (env bindings + incoming request).
import { AsyncLocalStorage } from "node:async_hooks";

export interface D1Stmt { bind(...v: unknown[]): D1Stmt; all<T>(): Promise<{ results?: T[] }> }
export interface D1Database { prepare(sql: string): D1Stmt; batch(stmts: D1Stmt[]): Promise<unknown[]> }

export type Env = {
  DB: D1Database;
  ALLOWED_ORIGINS?: string;
  [k: string]: unknown;
};

type Ctx = { req: Request; env: Env };
export const als = new AsyncLocalStorage<Ctx>();

export function ctx(): Ctx {
  const c = als.getStore();
  if (!c) throw new Error("No request context");
  return c;
}

export const envStr = (k: string) => {
  const v = ctx().env[k];
  return typeof v === "string" && v ? v : undefined;
};

export const bearer = () => /^Bearer\s+(\S+)$/.exec(ctx().req.headers.get("authorization") ?? "")?.[1];

/** Allowed frontend origins come from the ALLOWED_ORIGINS variable (comma-separated, `*` wildcards allowed). */
export function isAllowedOrigin(origin: string | null | undefined, env: Env = ctx().env): origin is string {
  if (!origin) return false;
  const list = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  return list.some((p) => {
    if (p === origin) return true;
    if (!p.includes("*")) return false;
    const re = new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9-]+") + "$", "i");
    return re.test(origin);
  });
}

export function requestOrigin() {
  const o = ctx().req.headers.get("origin");
  return isAllowedOrigin(o) ? o : null;
}

/** Cloudflare Secrets Store bindings expose `get()`; resolve them once per request so code reads plain strings via envStr(). */
const BINDINGS = new Set(["DB", "SANDBOX_DB", "AGENT_DB", "TASKS"]);
export async function resolveSecrets(env: Env): Promise<Env> {
  const out: Env = { ...env };
  await Promise.all(Object.entries(env).map(async ([k, v]) => {
    if (!BINDINGS.has(k) && v && typeof v === "object" && typeof (v as { get?: unknown }).get === "function") {
      try { out[k] = await (v as { get(): Promise<string> }).get(); } catch { out[k] = undefined; }
    }
  }));
  return out;
}
