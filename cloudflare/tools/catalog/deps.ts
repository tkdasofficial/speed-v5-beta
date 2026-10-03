// Dependency and environment/config tools. package.json edits use real npm registry data; env values are
// AES-GCM encrypted at rest (project_env) and never returned to the model in plain text.
import { defineTool, group } from "../registry";
import { z, ToolFailure, readPkg, writePkg, npmInfo, fetchJson, importedPackages, detect, write, safeToolPath, getFile, NPM } from "./util";
import { envStr } from "@backend/context";

const NAME = z.string().regex(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i).max(214);
const dep = group({ category: "dependencies" });

/** Highest published version satisfying a simple ^/~/exact range (enough for package.json maintenance). */
function satisfies(v: string, range: string) {
  const p = (s: string) => s.replace(/^[^\d]*/, "").split(/[.-]/).slice(0, 3).map((x) => Number(x) || 0);
  const [a, b, c] = p(v), [x, y, z] = p(range);
  if (/-/.test(v)) return false;
  if (range.startsWith("^")) return a === x && (a > 0 ? (b! > y! || (b === y && c! >= z!)) : b === y && c! >= z!);
  if (range.startsWith("~")) return a === x && b === y && c! >= z!;
  return v === range.replace(/^[=v]/, "");
}

export const depTools = [
  dep({
    name: "list_dependencies", description: "Dependencies and devDependencies from package.json, plus packages imported but not declared.", capabilities: ["npm ls", "packages"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const s = await env.files(); const pkg = readPkg(s);
      const declared = { ...(pkg!.dependencies ?? {}), ...(pkg!.devDependencies ?? {}) };
      const used = importedPackages(s);
      return { data: { dependencies: pkg!.dependencies ?? {}, devDependencies: pkg!.devDependencies ?? {}, undeclared: [...used.keys()].filter((n) => !declared[n]), unused: Object.keys(pkg!.dependencies ?? {}).filter((n) => !used.has(n) && !/^(react-dom|typescript|vite|@types\/)/.test(n)) } };
    },
  }),
  dep({
    name: "add_dependency", description: "Add a package to package.json at its latest (or given) version, verified on npm.", readOnly: false, requiredPermissions: ["project:write", "network:fetch"], timeoutMs: 20_000, capabilities: ["npm install package", "add package"],
    inputSchema: z.object({ name: NAME, version: z.string().max(50).optional(), dev: z.boolean().default(false) }),
    handler: async (a, env) => {
      const s = await env.files(); const pkg = readPkg(s)!;
      const info = await npmInfo(a.name, env);
      if (a.version && !info.versions.some((v) => satisfies(v, a.version!) || v === a.version)) throw new ToolFailure("DEPENDENCY_FAILED", `${a.name}@${a.version} does not exist on npm (latest ${info.latest})`);
      const range = a.version ?? `^${info.latest}`;
      const key = a.dev ? "devDependencies" : "dependencies";
      pkg[key] = Object.fromEntries(Object.entries({ ...(pkg[key] ?? {}), [a.name]: range }).sort(([x], [y]) => x.localeCompare(y)));
      const other = a.dev ? "dependencies" : "devDependencies";
      if (pkg[other]?.[a.name]) delete pkg[other]![a.name];
      writePkg(env, s, pkg);
      return { data: { name: a.name, version: range, dev: a.dev }, stateChanges: [{ kind: "file", target: "package.json", detail: `added ${a.name}` }], next: "install_dependencies" };
    },
  }),
  dep({
    name: "remove_dependency", description: "Remove a package from package.json (warns if still imported).", readOnly: false, capabilities: ["npm uninstall"],
    inputSchema: z.object({ name: NAME }),
    handler: async (a, env) => {
      const s = await env.files(); const pkg = readPkg(s)!;
      const had = !!(pkg.dependencies?.[a.name] || pkg.devDependencies?.[a.name]);
      if (!had) throw new ToolFailure("DEPENDENCY_FAILED", `${a.name} is not in package.json`);
      delete pkg.dependencies?.[a.name]; delete pkg.devDependencies?.[a.name];
      writePkg(env, s, pkg);
      const still = importedPackages(s).get(a.name) ?? [];
      return { data: { removed: a.name }, warnings: still.length ? [`Still imported by ${still.slice(0, 5).join(", ")}`] : [], stateChanges: [{ kind: "file", target: "package.json", detail: `removed ${a.name}` }] };
    },
  }),
  dep({
    name: "update_dependency", description: "Update a package to its latest (or given) version in package.json.", readOnly: false, requiredPermissions: ["project:write", "network:fetch"], capabilities: ["upgrade package"],
    inputSchema: z.object({ name: NAME, version: z.string().max(50).optional() }),
    handler: async (a, env) => {
      const s = await env.files(); const pkg = readPkg(s)!;
      const key = pkg.dependencies?.[a.name] ? "dependencies" : pkg.devDependencies?.[a.name] ? "devDependencies" : null;
      if (!key) throw new ToolFailure("DEPENDENCY_FAILED", `${a.name} is not in package.json`, false, undefined, "add_dependency");
      const info = await npmInfo(a.name, env);
      const from = pkg[key]![a.name]!;
      const to = a.version ?? `^${info.latest}`;
      pkg[key]![a.name] = to; writePkg(env, s, pkg);
      return { data: { name: a.name, from, to }, stateChanges: [{ kind: "file", target: "package.json", detail: `${a.name} ${from} → ${to}` }], next: "install_dependencies" };
    },
  }),
  dep({
    name: "check_outdated_dependencies", description: "Compare declared versions with the latest on npm.", requiredPermissions: ["project:read", "network:fetch"], timeoutMs: 45_000, capabilities: ["npm outdated"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const pkg = readPkg(await env.files())!;
      const all = Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).slice(0, 60);
      const out = await Promise.all(all.map(async ([n, r]) => { try { const i = await npmInfo(n, env); return { name: n, wanted: r, latest: i.latest, outdated: !!i.latest && !satisfies(i.latest, r) }; } catch (e) { return { name: n, wanted: r, latest: null, error: (e as Error).message }; } }));
      return { data: { outdated: out.filter((x) => "outdated" in x && x.outdated), checked: out.length, errors: out.filter((x) => "error" in x) } };
    },
  }),
  dep({
    name: "audit_dependencies", description: "Check declared package versions against the npm security advisory database.", requiredPermissions: ["project:read", "network:fetch"], timeoutMs: 30_000, capabilities: ["npm audit", "vulnerabilities"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const pkg = readPkg(await env.files())!;
      const all = Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
      const body: Record<string, string[]> = {};
      for (const [n, r] of all) body[n] = [r.replace(/^[^\d]*/, "")];
      const r = await fetchJson<Record<string, { title: string; severity: string; url: string; vulnerable_versions: string }[]>>(`${NPM}/-/npm/v1/security/advisories/bulk`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeoutMs: 25_000 }, env);
      if (r.status >= 400) throw new ToolFailure("INTEGRATION_FAILED", `npm advisory API returned ${r.status}`, true);
      const found = Object.entries(r.body ?? {}).flatMap(([n, l]) => l.map((x) => ({ package: n, severity: x.severity, title: x.title, vulnerable: x.vulnerable_versions, url: x.url })));
      return { data: { vulnerabilities: found, packages: all.length } };
    },
  }),
  dep({
    name: "fix_missing_dependencies", description: "Add every imported-but-undeclared package to package.json at its latest version.", readOnly: false, requiredPermissions: ["project:write", "network:fetch"], timeoutMs: 45_000, capabilities: ["missing package", "cannot find module"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const s = await env.files(); const pkg = readPkg(s)!;
      const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const missing = [...importedPackages(s).keys()].filter((n) => !declared[n]).slice(0, 20);
      const added: string[] = [], failed: string[] = [];
      for (const n of missing) { try { const i = await npmInfo(n, env); (pkg.dependencies ??= {})[n] = `^${i.latest}`; added.push(`${n}@^${i.latest}`); } catch { failed.push(n); } }
      if (added.length) writePkg(env, s, pkg);
      return { data: { added, failed }, stateChanges: added.length ? [{ kind: "file", target: "package.json", detail: "added missing" }] : [], next: added.length ? "install_dependencies" : null };
    },
  }),
];

// ---------------- environment / config ----------------
const ENV_NAME = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/);
const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
async function key() {
  const secret = envStr("AUTH_SECRET");
  if (!secret) throw new ToolFailure("UNKNOWN_ERROR", "Server is missing AUTH_SECRET");
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode(`project-env:${secret}`)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(projectId: string, v: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return `${b64(iv)}.${b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(projectId) }, await key(), enc.encode(v)))}`;
}
/** Decrypts a project env value (server-only; used by the runtime job to inject env into builds). */
export async function openEnv(projectId: string, sealed: string) {
  const [iv, ct] = sealed.split(".");
  const u = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u(iv!), additionalData: enc.encode(projectId) }, await key(), u(ct!)));
}
const mask = (v: string) => (v.length <= 4 ? "****" : `${v.slice(0, 2)}${"*".repeat(Math.min(12, v.length - 4))}${v.slice(-2)}`);
const envTool = group({ category: "environment", requiredPermissions: ["env:read"] });

/** Env names referenced by source code (Vite import.meta.env.X and process.env.X). */
function referencedEnv(s: Awaited<ReturnType<import("../types").ToolEnv["files"]>>) {
  const out = new Map<string, string[]>();
  for (const f of s.list()) {
    if (!/\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/.test(f.path)) continue;
    for (const m of f.content.matchAll(/(?:import\.meta\.env|process\.env)(?:\.([A-Z_][A-Z0-9_]*)|\[["']([A-Z_][A-Z0-9_]*)["']\])/g)) {
      const n = m[1] ?? m[2]!; if (["MODE", "DEV", "PROD", "SSR", "BASE_URL", "NODE_ENV"].includes(n)) continue;
      out.set(n, [...new Set([...(out.get(n) ?? []), f.path])]);
    }
  }
  return out;
}

export const envTools = [
  envTool({
    name: "list_env_vars", description: "Names of the project's environment variables (values masked).", capabilities: ["env", "environment variables", "secrets list"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const { d1 } = await import("@backend/d1");
      const rows = await d1<{ name: string; updated_at: string }>("SELECT name, updated_at FROM project_env WHERE project_id = ? ORDER BY name", [env.projectId]);
      return { data: { variables: rows } };
    },
  }),
  envTool({
    name: "get_env_var", description: "Whether a variable is set, with a masked preview (the plain value never leaves the server).",
    inputSchema: z.object({ name: ENV_NAME }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      const [r] = await d1<{ value_enc: string; updated_at: string }>("SELECT value_enc, updated_at FROM project_env WHERE project_id = ? AND name = ?", [env.projectId, a.name]);
      if (!r) return { data: { name: a.name, set: false } };
      const v = await openEnv(env.projectId, r.value_enc);
      return { data: { name: a.name, set: true, preview: mask(v), length: v.length, public: a.name.startsWith("VITE_"), updatedAt: r.updated_at } };
    },
  }),
  envTool({
    name: "set_env_var", description: "Create or update an environment variable (encrypted at rest; VITE_ names are public in browser builds).", readOnly: false, requiredPermissions: ["env:write"], capabilities: ["add secret", "set environment variable"],
    inputSchema: z.object({ name: ENV_NAME, value: z.string().min(1).max(8000) }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      await d1("INSERT INTO project_env (project_id, name, value_enc) VALUES (?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET value_enc = excluded.value_enc, updated_at = datetime('now')", [env.projectId, a.name, await seal(env.projectId, a.value)]);
      return { data: { name: a.name, set: true }, stateChanges: [{ kind: "settings", target: `env:${a.name}` }] };
    },
  }),
  envTool({
    name: "delete_env_var", description: "Delete an environment variable.", destructive: true, requiredPermissions: ["env:write"],
    inputSchema: z.object({ name: ENV_NAME }),
    handler: async (a, env) => {
      const { d1 } = await import("@backend/d1");
      const r = await d1<{ name: string }>("DELETE FROM project_env WHERE project_id = ? AND name = ? RETURNING name", [env.projectId, a.name]);
      if (!r.length) throw new ToolFailure("INVALID_ARGUMENT", `${a.name} is not set`);
      return { data: { deleted: a.name }, stateChanges: [{ kind: "settings", target: `env:${a.name}`, detail: "deleted" }] };
    },
  }),
  envTool({
    name: "check_env_requirements", description: "Find env variables the code reads that are not set (and set ones nothing uses).", capabilities: ["missing env", "undefined env variable"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const { d1 } = await import("@backend/d1");
      const set = new Set((await d1<{ name: string }>("SELECT name FROM project_env WHERE project_id = ?", [env.projectId])).map((r) => r.name));
      const used = referencedEnv(await env.files());
      const missing = [...used].filter(([n]) => !set.has(n)).map(([name, files]) => ({ name, files: files.slice(0, 5) }));
      const serverOnlyInBrowser = [...used].filter(([n, f]) => !n.startsWith("VITE_") && f.some((p) => p.startsWith("src/"))).map(([n]) => n);
      return { data: { missing, unused: [...set].filter((n) => !used.has(n)), nonPublicInClientCode: serverOnlyInBrowser }, next: missing.length ? "set_env_var" : null };
    },
  }),
  envTool({
    name: "get_project_config", description: "Detected framework/build system and the content of the main config files.", requiredPermissions: ["project:read"], capabilities: ["config", "vite config", "tsconfig"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const s = await env.files(); const d = detect(s);
      const files = ["package.json", "vite.config.ts", "vite.config.js", "tsconfig.json", "tailwind.config.js", "tailwind.config.ts", "postcss.config.js", "eslint.config.js", ".eslintrc.json", ".prettierrc", "index.html"].filter((p) => s.get(p));
      return { data: { framework: d.framework, buildSystem: d.buildSystem, packageManager: d.packageManager, scripts: d.pkg?.scripts ?? {}, configs: Object.fromEntries(files.map((p) => [p, s.get(p)!.content.slice(0, 4000)])) } };
    },
  }),
  envTool({
    name: "update_project_config", description: "Deep-merge a JSON patch into a JSON config file (package.json, tsconfig.json, .prettierrc…); null deletes a key.", readOnly: false, requiredPermissions: ["project:write"], capabilities: ["change config", "add script"],
    inputSchema: z.object({ path: z.string().regex(/\.(json|prettierrc|eslintrc)$|^\.prettierrc$/), patch: z.record(z.string(), z.unknown()) }),
    handler: async (a, env) => {
      const p = safeToolPath(a.path); const s = await env.files();
      const cur = s.get(p) ? (() => { try { return JSON.parse(getFile(s, p).content.replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>; } catch (e) { throw new ToolFailure("INVALID_ARGUMENT", `${p} is not valid JSON: ${(e as Error).message}`); } })() : {};
      const merge = (t: Record<string, unknown>, src: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(src)) {
          if (v === null) delete t[k];
          else if (typeof v === "object" && !Array.isArray(v) && typeof t[k] === "object" && t[k] && !Array.isArray(t[k])) merge(t[k] as Record<string, unknown>, v as Record<string, unknown>);
          else t[k] = v;
        }
        return t;
      };
      write(env, s, p, `${JSON.stringify(merge(cur, a.patch), null, 2)}\n`);
      return { data: { path: p, keys: Object.keys(a.patch) }, stateChanges: [{ kind: "file", target: p, detail: "config updated" }] };
    },
  }),
];
