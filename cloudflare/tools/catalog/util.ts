// Shared helpers for tool handlers. Everything here is real backend work on the authorized project only.
import { z } from "zod";
import { ToolFailure, type ToolEnv } from "../types";
import { safeToolPath, safeExternalUrl, isSecretPath } from "../policy";
import type { MemoryFileStore } from "../../../sandbox/workspace/workspace";

export { z, ToolFailure, safeToolPath, safeExternalUrl, isSecretPath };
export const P = z.string().min(1).max(400);

export const TEXT_EXT = /\.(html?|css|scss|js|jsx|mjs|cjs|ts|tsx|json|md|txt|svg|xml|yml|yaml|toml)$/i;
export const ASSET_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|wav|pdf)$/i;

export function getFile(s: MemoryFileStore, path: string) {
  const f = s.get(path);
  if (!f) throw new ToolFailure("FILE_NOT_FOUND", `No such file: ${path}`, false, undefined, "search_files");
  return f;
}
export const visible = (s: MemoryFileStore) => s.list().filter((f) => !isSecretPath(f.path));

export function write(env: ToolEnv, s: MemoryFileStore, path: string, content: string, encoding: "utf8" | "base64" = "utf8") {
  if (content.length > 900_000) throw new ToolFailure("RESOURCE_LIMIT", "File too large (900 KB max)");
  s.set({ path, content, encoding, updatedAt: Date.now() });
  env.markDirty(path);
}
export function remove(env: ToolEnv, s: MemoryFileStore, path: string) {
  if (!s.delete(path)) throw new ToolFailure("FILE_NOT_FOUND", `No such file: ${path}`);
  env.markDirty(path);
}

// ---- package.json ----
export type Pkg = { name?: string; version?: string; type?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; [k: string]: unknown };
export function readPkg(s: MemoryFileStore, required = true): Pkg | null {
  const f = s.get("package.json");
  if (!f) { if (required) throw new ToolFailure("FILE_NOT_FOUND", "No package.json in this project", false, undefined, "generate_file"); return null; }
  try { return JSON.parse(f.content) as Pkg; } catch (e) { throw new ToolFailure("DEPENDENCY_FAILED", `package.json is not valid JSON: ${(e as Error).message}`); }
}
export function writePkg(env: ToolEnv, s: MemoryFileStore, pkg: Pkg) { write(env, s, "package.json", `${JSON.stringify(pkg, null, 2)}\n`); }

// ---- outbound HTTP (SSRF-guarded, time-boxed) ----
export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}, env?: ToolEnv): Promise<{ status: number; body: T; headers: Headers; ms: number }> {
  safeExternalUrl(url);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), init.timeoutMs ?? 12_000);
  env?.signal.addEventListener("abort", () => ac.abort(), { once: true });
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...init, signal: ac.signal, redirect: "follow" });
    const text = await r.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* text body */ }
    return { status: r.status, body: body as T, headers: r.headers, ms: Date.now() - t0 };
  } catch (e) {
    throw new ToolFailure(ac.signal.aborted ? "TIMEOUT" : "INTEGRATION_FAILED", `Request to ${new URL(url).hostname} failed: ${(e as Error).message}`, true);
  } finally { clearTimeout(t); }
}

export const NPM = "https://registry.npmjs.org";
export async function npmInfo(name: string, env?: ToolEnv) {
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new ToolFailure("INVALID_ARGUMENT", `Invalid package name ${name}`);
  const r = await fetchJson<{ "dist-tags"?: Record<string, string>; description?: string; versions?: Record<string, unknown>; error?: string }>(`${NPM}/${name.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" } }, env);
  if (r.status === 404) throw new ToolFailure("DEPENDENCY_FAILED", `Package ${name} does not exist on npm`);
  if (r.status >= 400) throw new ToolFailure("INTEGRATION_FAILED", `npm registry returned ${r.status}`, true);
  return { latest: r.body["dist-tags"]?.["latest"] ?? null, versions: Object.keys(r.body.versions ?? {}) };
}

// ---- GitHub (user's own connection; repo must be the one linked to this project) ----
export async function linkedRepo(env: ToolEnv) {
  const { d1 } = await import("@backend/d1");
  const [r] = await d1<{ owner: string; name: string; full_name: string; default_branch: string }>("SELECT owner, name, full_name, default_branch FROM project_repos WHERE project_id = ? AND user_id = ?", [env.projectId, env.userId]);
  if (!r) throw new ToolFailure("PREREQUISITE_FAILED", "No GitHub repository is linked to this project", false, undefined, "connect_integration");
  return r;
}
export async function gh<T>(env: ToolEnv, method: string, path: string, body?: unknown): Promise<T> {
  const { getGithubAccessToken } = await import("@security/github.server");
  let token: string;
  try { token = await getGithubAccessToken(env.userId); } catch { throw new ToolFailure("PREREQUISITE_FAILED", "GitHub is not connected (or needs reconnecting)", false, undefined, "connect_integration"); }
  const r = await fetchJson<T & { message?: string }>(`https://api.github.com${path}`, {
    method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "speed-agent", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), timeoutMs: 20_000,
  }, env);
  if (r.status === 401 || r.status === 403) throw new ToolFailure("PERMISSION_DENIED", `GitHub refused the request: ${(r.body as { message?: string }).message ?? r.status}`);
  if (r.status === 404) throw new ToolFailure("FILE_NOT_FOUND", `GitHub: not found (${path.split("?")[0]})`);
  if (r.status === 409 || r.status === 422) throw new ToolFailure("CONFLICT", `GitHub: ${(r.body as { message?: string }).message ?? r.status}`);
  if (r.status >= 400) throw new ToolFailure("INTEGRATION_FAILED", `GitHub returned ${r.status}`, r.status >= 500);
  return r.body;
}
/** git blob SHA-1 of file content (so local files can be compared with a GitHub tree without downloading it). */
export async function blobSha(content: string, encoding: "utf8" | "base64") {
  const bytes = encoding === "base64" ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0)) : new TextEncoder().encode(content);
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length); all.set(head); all.set(bytes, head.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Supabase management API (user's own connection) ----
export async function supabaseQuery(env: ToolEnv, sql: string) {
  const st = await env.settings();
  const ref = String(st["supabaseProjectRef"] ?? "");
  if (!/^[a-z0-9]{10,40}$/.test(ref)) throw new ToolFailure("PREREQUISITE_FAILED", "No database configured (supabaseProjectRef)", false, undefined, "update_integration_config");
  const { listConnections, withToken } = await import("@security/connections.server");
  const conn = (await listConnections(env.userId)).find((c) => c.integration === "supabase" && c.status === "active");
  if (!conn) throw new ToolFailure("PREREQUISITE_FAILED", "Supabase is not connected", false, undefined, "connect_integration");
  return withToken(conn, async (token) => {
    const r = await fetchJson<unknown>(`https://api.supabase.com/v1/projects/${ref}/database/query`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query: sql }), timeoutMs: 25_000 }, env);
    if (r.status >= 400) throw new ToolFailure("INTEGRATION_FAILED", `Database error: ${typeof r.body === "object" && r.body && "message" in r.body ? String((r.body as { message: unknown }).message) : r.status}`, r.status >= 500);
    return r.body as Record<string, unknown>[];
  });
}
export const ident = (s: string) => { if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(s)) throw new ToolFailure("INVALID_ARGUMENT", `Invalid identifier ${s}`); return `"${s}"`; };
export const lit = (v: unknown): string => v === null || v === undefined ? "NULL" : typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : `'${(typeof v === "string" ? v : JSON.stringify(v)).replace(/'/g, "''")}'`;

// ---- project detection ----
export function detect(s: MemoryFileStore) {
  const pkg = readPkg(s, false);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const paths = s.list().map((f) => f.path);
  const framework = deps["next"] ? "next" : deps["@tanstack/react-start"] ? "tanstack-start" : deps["react"] && deps["vite"] ? "react-vite" : deps["vue"] ? "vue" : deps["svelte"] ? "svelte" : deps["react"] ? "react" : paths.includes("index.html") ? "static" : paths.length ? "unknown" : "empty";
  const language = paths.some((p) => /\.tsx?$/.test(p)) ? "typescript" : paths.some((p) => /\.(m?js|jsx)$/.test(p)) ? "javascript" : paths.some((p) => /\.html?$/.test(p)) ? "html" : "unknown";
  const buildSystem = deps["vite"] ? "vite" : deps["webpack"] ? "webpack" : deps["next"] ? "next" : pkg ? "npm-scripts" : framework === "static" ? "static" : "none";
  const packageManager = paths.includes("bun.lockb") || paths.includes("bun.lock") ? "bun" : paths.includes("pnpm-lock.yaml") ? "pnpm" : paths.includes("yarn.lock") ? "yarn" : pkg ? "npm" : "none";
  const entries = ["index.html", "src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js", "src/index.tsx", "src/index.js", "src/App.tsx", "src/App.jsx"].filter((p) => paths.includes(p));
  return { framework, language, buildSystem, packageManager, entries, pkg, deps, paths };
}

/** Routes: file-based (pages/routes dirs), react-router <Route path>, and static HTML pages. */
export function detectRoutes(s: MemoryFileStore) {
  const out: { path: string; file: string; kind: string }[] = [];
  for (const f of s.list()) {
    const m = /^(?:src\/)?(?:pages|routes|app)\/(.+)\.(tsx|jsx|ts|js)$/.exec(f.path);
    if (m && !/(^|\/)(_|components\/)/.test(m[1]!)) out.push({ path: `/${m[1]!.replace(/(^|\/)index$/, "").replace(/\$(\w+)/g, ":$1").replace(/\[(\w+)\]/g, ":$1").replace(/\./g, "/")}`, file: f.path, kind: "file-route" });
    if (/\.(tsx|jsx|js|ts)$/.test(f.path)) for (const r of f.content.matchAll(/<Route[^>]*\bpath=["'{]+([^"'}]+)/g)) out.push({ path: r[1]!, file: f.path, kind: "router" });
    if (/\.html?$/.test(f.path) && !f.path.includes("/")) out.push({ path: f.path === "index.html" ? "/" : `/${f.path}`, file: f.path, kind: "html" });
  }
  return out;
}
export function detectApiRoutes(s: MemoryFileStore) {
  const out: { route: string; file: string; methods: string[] }[] = [];
  for (const f of s.list()) {
    const m = /^(?:src\/)?(?:routes\/api|pages\/api|app\/api|api|functions)\/(.+)\.(ts|js|tsx|mjs)$/.exec(f.path);
    if (!m) continue;
    const methods = [...new Set([...f.content.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b\s*[:(=]/g)].map((x) => x[1]!))];
    out.push({ route: `/api/${m[1]!.replace(/(^|\/)(index|route)$/, "").replace(/\[(\w+)\]/g, ":$1")}`, file: f.path, methods: methods.length ? methods : ["GET"] });
  }
  return out;
}

/** Bare-module imports used by source files. */
export function importedPackages(s: MemoryFileStore) {
  const used = new Map<string, string[]>();
  for (const f of s.list()) {
    if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(f.path)) continue;
    for (const m of f.content.matchAll(/(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"./][^'"]*)['"]/g)) {
      const spec = m[1]!;
      if (/^(node:|https?:|virtual:|~|@\/)/.test(spec)) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      used.set(name, [...(used.get(name) ?? []), f.path]);
    }
  }
  return used;
}

export function unifiedDiff(a: string, b: string, path: string) {
  const x = a.split("\n"), y = b.split("\n");
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    const ni = y.indexOf(x[i] ?? "\u0000", j), nj = x.indexOf(y[j] ?? "\u0000", i);
    if (nj >= 0 && (ni < 0 || nj - i <= ni - j)) { while (i < nj) out.push(`-${x[i++]}`); }
    else if (ni >= 0) { while (j < ni) out.push(`+${y[j++]}`); }
    else { if (i < x.length) out.push(`-${x[i++]}`); if (j < y.length) out.push(`+${y[j++]}`); }
    if (out.length > 400) { out.push("… (diff truncated)"); break; }
  }
  return out.join("\n");
}
