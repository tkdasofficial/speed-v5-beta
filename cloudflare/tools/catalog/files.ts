// Categories 1–4: workspace files, discovery, search/research, code analysis (tools 1–33).
import { defineTool } from "../registry";
import { webSearchTool } from "./websearch";
import { z, P, ToolFailure, safeToolPath, getFile, visible, write, remove, detect, detectRoutes, importedPackages, fetchJson, gh, TEXT_EXT } from "./util";
import { searchText, searchFilename, outline } from "../../../sandbox/intelligence/search";
import { validateProject, validateFile, validateTs, validateViteExports, isViteProject } from "../../../sandbox/intelligence/validate";
import { analyzeFile, projectGraph, brokenReferences } from "../../../sandbox/intelligence/deps";

const tree = (paths: string[], depth: number) => paths.filter((p) => p.split("/").length <= depth);

export const fileTools = [
  // ---- Category 1: project / workspace ----
  defineTool({
    name: "list_files", category: "workspace", description: "List files in the project, optionally under a folder, filtered by extension, up to a depth.",
    capabilities: ["ls", "browse", "directory listing"],
    inputSchema: z.object({ path: z.string().max(400).optional(), depth: z.number().int().min(1).max(20).default(20), ext: z.array(z.string()).optional() }),
    handler: async (a, env) => {
      const s = await env.files(); const dir = safeToolPath(a.path, { allowEmpty: true });
      const files = visible(s).filter((f) => !dir || f.path.startsWith(`${dir}/`)).filter((f) => !a.ext || a.ext.some((e) => f.path.endsWith(`.${e.replace(/^\./, "")}`)))
        .filter((f) => f.path.slice(dir ? dir.length + 1 : 0).split("/").length <= a.depth)
        .map((f) => ({ path: f.path, size: f.content.length, encoding: f.encoding, updatedAt: f.updatedAt })).sort((x, y) => x.path.localeCompare(y.path));
      return { data: { count: files.length, files } };
    },
  }),
  defineTool({
    name: "get_project_structure", category: "workspace", description: "Return the project tree (folders and files), excluding secret files.",
    capabilities: ["tree", "layout", "overview"],
    inputSchema: z.object({ depth: z.number().int().min(1).max(20).default(8) }),
    handler: async (a, env) => {
      const s = await env.files();
      const paths = [...visible(s).map((f) => f.path), ...s.folders().map((d) => `${d}/`)].sort();
      return { data: { tree: tree(paths, a.depth).map((p) => `${"  ".repeat(p.replace(/\/$/, "").split("/").length - 1)}${p.replace(/\/$/, "").split("/").pop()}${p.endsWith("/") ? "/" : ""}`).join("\n"), files: visible(s).length, folders: s.folders().length } };
    },
  }),
  defineTool({
    name: "read_file", category: "workspace", description: "Read a project file (optionally a line range).", capabilities: ["open", "view", "cat"],
    inputSchema: z.object({ path: P, start: z.number().int().min(1).optional(), end: z.number().int().min(1).optional() }),
    handler: async (a, env) => {
      const p = safeToolPath(a.path); const f = getFile(await env.files(), p);
      if (f.encoding === "base64") return { data: { path: p, encoding: "base64", size: f.content.length, content: null }, warnings: ["Binary file — content omitted; use read_asset"] };
      const lines = f.content.split("\n");
      const s = a.start ?? 1, e = Math.min(lines.length, a.end ?? Math.max(s + 600, 600));
      return { data: { path: p, totalLines: lines.length, start: s, end: e, content: lines.slice(s - 1, e).join("\n") }, ...(e < lines.length ? { warnings: [`Truncated at line ${e}; pass start/end for more`] } : {}) };
    },
  }),
  defineTool({
    name: "search_files", category: "workspace", description: "Search file names and contents (exact, fuzzy or regex).", capabilities: ["grep", "find text", "locate"],
    inputSchema: z.object({ query: z.string().min(1).max(500), mode: z.enum(["exact", "fuzzy", "regex"]).default("exact"), ext: z.array(z.string()).optional(), dir: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) }),
    handler: async (a, env) => {
      const s = await env.files();
      if (a.mode === "regex") { try { new RegExp(a.query); } catch { throw new ToolFailure("INVALID_ARGUMENT", "Invalid regular expression"); } }
      const names = searchFilename(s, a.query, { ...(a.ext ? { ext: a.ext } : {}), ...(a.dir ? { dir: safeToolPath(a.dir) } : {}) }).slice(0, 50);
      const hits = searchText(s, { query: a.query, mode: a.mode, ...(a.ext ? { ext: a.ext } : {}), ...(a.dir ? { dir: safeToolPath(a.dir) } : {}), limit: a.limit });
      return { data: { fileMatches: names, contentMatches: hits } };
    },
  }),
  defineTool({
    name: "create_file", category: "workspace", description: "Create a new file (fails if it exists).", readOnly: false, capabilities: ["new file", "add file"],
    inputSchema: z.object({ path: P, content: z.string().max(900_000).default("") }),
    handler: async (a, env) => {
      const p = safeToolPath(a.path); const s = await env.files();
      if (s.get(p)) throw new ToolFailure("CONFLICT", `${p} already exists — use update_file`, false, undefined, "update_file");
      write(env, s, p, a.content);
      return { data: { path: p, bytes: a.content.length, diagnostics: validateFile(s, p).filter((d) => d.severity === "error").slice(0, 10) }, stateChanges: [{ kind: "file", target: p, detail: "created" }] };
    },
  }),
  defineTool({
    name: "write_file", category: "workspace", description: "Create or fully overwrite a file.", readOnly: false, capabilities: ["save file", "overwrite"],
    inputSchema: z.object({ path: P, content: z.string().max(900_000) }),
    handler: async (a, env) => {
      const p = safeToolPath(a.path); const s = await env.files(); const existed = !!s.get(p);
      write(env, s, p, a.content);
      return { data: { path: p, created: !existed, bytes: a.content.length, diagnostics: validateFile(s, p).filter((d) => d.severity === "error").slice(0, 10) }, stateChanges: [{ kind: "file", target: p, detail: existed ? "overwritten" : "created" }] };
    },
  }),
  defineTool({
    name: "update_file", category: "workspace", description: "Targeted edit: replace exact text (must be unique unless all=true).", readOnly: false, capabilities: ["edit", "modify", "change code"],
    inputSchema: z.object({ path: P, find: z.string().min(1), replace: z.string(), all: z.boolean().default(false) }),
    handler: async (a, env) => {
      const p = safeToolPath(a.path); const s = await env.files(); const cur = getFile(s, p).content;
      const n = cur.split(a.find).length - 1;
      if (!n) throw new ToolFailure("INVALID_ARGUMENT", `Text not found in ${p} — read the file and copy the exact text`, false, undefined, "read_file");
      if (n > 1 && !a.all) throw new ToolFailure("CONFLICT", `Text appears ${n} times in ${p}; add context or set all=true`);
      write(env, s, p, a.all ? cur.split(a.find).join(a.replace) : cur.replace(a.find, () => a.replace));
      return { data: { path: p, replacements: a.all ? n : 1, diagnostics: validateFile(s, p).filter((d) => d.severity === "error").slice(0, 10) }, stateChanges: [{ kind: "file", target: p, detail: "updated" }] };
    },
  }),
  defineTool({
    name: "delete_file", category: "workspace", description: "Delete a file.", destructive: true, requiredPermissions: ["project:delete"], capabilities: ["remove file"],
    inputSchema: z.object({ path: P }),
    handler: async (a, env) => { const p = safeToolPath(a.path); const s = await env.files(); remove(env, s, p); return { data: { path: p, deleted: true }, stateChanges: [{ kind: "file", target: p, detail: "deleted" }] }; },
  }),
  defineTool({
    name: "move_file", category: "workspace", description: "Move a file or folder to a new path.", readOnly: false, capabilities: ["relocate"],
    inputSchema: z.object({ from: P, to: P }),
    handler: async (a, env) => {
      const from = safeToolPath(a.from), to = safeToolPath(a.to); const s = await env.files();
      const { movePath } = await import("../../../sandbox/filesystem/move");
      if (s.get(to)) throw new ToolFailure("CONFLICT", `${to} already exists`);
      const moved = s.list().filter((f) => f.path === from || f.path.startsWith(`${from}/`)).map((f) => f.path);
      if (!moved.length && !s.hasFolder(from)) throw new ToolFailure("FILE_NOT_FOUND", `No such file or folder: ${from}`);
      movePath(s, from, to);
      for (const m of moved) { env.markDirty(m); env.markDirty(to + m.slice(from.length)); }
      return { data: { from, to, files: moved.length }, stateChanges: [{ kind: "file", target: to, detail: `moved from ${from}` }], next: "search_files" };
    },
  }),
  defineTool({
    name: "rename_file", category: "workspace", description: "Rename a file in place.", readOnly: false,
    inputSchema: z.object({ path: P, name: z.string().min(1).max(200).regex(/^[^/\\]+$/) }),
    handler: async (a, env) => {
      const p = safeToolPath(a.path); const to = [...p.split("/").slice(0, -1), a.name].join("/");
      const r = await env.run("move_file", { from: p, to });
      if (!r.success) throw new ToolFailure(r.error!.code, r.error!.message, r.error!.retryable);
      return { data: r.data, stateChanges: r.stateChanges };
    },
  }),
  defineTool({
    name: "create_directory", category: "workspace", description: "Create a folder.", readOnly: false, capabilities: ["mkdir", "folder"],
    inputSchema: z.object({ path: P }),
    handler: async (a, env) => { const p = safeToolPath(a.path); const s = await env.files(); const existed = s.hasFolder(p); s.addFolder(p); env.markDirty(p); return { data: { path: p, created: !existed }, stateChanges: [{ kind: "file", target: `${p}/`, detail: "folder" }] }; },
  }),
  defineTool({
    name: "delete_directory", category: "workspace", description: "Delete a folder and everything in it.", destructive: true, requiredPermissions: ["project:delete"], capabilities: ["rmdir", "remove folder"],
    inputSchema: z.object({ path: P }),
    handler: async (a, env) => {
      const p = safeToolPath(a.path); const s = await env.files();
      const files = s.list().filter((f) => f.path.startsWith(`${p}/`));
      if (!files.length && !s.hasFolder(p)) throw new ToolFailure("DIRECTORY_NOT_FOUND", `No such folder: ${p}`);
      for (const f of files) remove(env, s, f.path);
      for (const d of s.folders().filter((d) => d === p || d.startsWith(`${p}/`))) s.removeFolder(d);
      env.markDirty(p);
      return { data: { path: p, deletedFiles: files.length }, stateChanges: [{ kind: "file", target: `${p}/`, detail: "deleted" }] };
    },
  }),

  // ---- Category 2: discovery ----
  defineTool({
    name: "discover_project", category: "discovery", description: "One-shot overview: framework, language, entry points, routes, scripts, file counts.", capabilities: ["understand project", "overview", "inspect"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const s = await env.files(); const d = detect(s);
      return { data: { framework: d.framework, language: d.language, buildSystem: d.buildSystem, packageManager: d.packageManager, entryPoints: d.entries, routes: detectRoutes(s).slice(0, 50), scripts: d.pkg?.scripts ?? {}, dependencies: Object.keys(d.deps).length, files: d.paths.length, folders: s.folders().length, revision: await env.revision() }, next: d.paths.length ? "search_files" : "generate_file" };
    },
  }),
  defineTool({
    name: "analyze_project", category: "discovery", description: "Project health: validation errors/warnings, broken references, size and file-type breakdown.",
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const s = await env.files(); const v = validateProject(s);
      const types: Record<string, number> = {}; for (const f of s.list()) { const e = f.path.split(".").pop()!.toLowerCase(); types[e] = (types[e] ?? 0) + 1; }
      return { data: { ...detect(s), pkg: undefined, deps: undefined, paths: undefined, errors: v.errors.slice(0, 30), warnings: v.warnings.slice(0, 30), brokenReferences: brokenReferences(s).slice(0, 30), bytes: s.list().reduce((n, f) => n + f.content.length, 0), fileTypes: types }, next: v.errors.length ? "diagnose_failure" : null };
    },
  }),
  defineTool({ name: "detect_framework", category: "discovery", description: "Detect the project's framework.", inputSchema: z.object({}), handler: async (_a, env) => { const d = detect(await env.files()); return { data: { framework: d.framework, language: d.language } }; } }),
  defineTool({
    name: "detect_dependencies", category: "discovery", description: "Declared vs imported npm packages (missing and unused).",
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const s = await env.files(); const d = detect(s); const used = importedPackages(s);
      const declared = Object.keys(d.deps);
      return { data: { declared: d.deps, missing: [...used.keys()].filter((n) => !declared.includes(n)), unused: declared.filter((n) => !used.has(n) && !/^(@types\/|typescript|vite|@vitejs|eslint|prettier|tailwindcss|postcss|autoprefixer)/.test(n)) } };
    },
  }),
  defineTool({ name: "detect_entry_points", category: "discovery", description: "Find app entry files (index.html, main.tsx…).", inputSchema: z.object({}), handler: async (_a, env) => { const s = await env.files(); const d = detect(s); const html = s.get("index.html")?.content ?? ""; return { data: { entries: d.entries, htmlScripts: [...html.matchAll(/<script[^>]*src=["']([^"']+)/g)].map((m) => m[1]) } }; } }),
  defineTool({ name: "detect_routes", category: "discovery", description: "Detect page routes (file-based, router <Route>, static pages).", inputSchema: z.object({}), handler: async (_a, env) => ({ data: { routes: detectRoutes(await env.files()) } }) }),
  defineTool({ name: "detect_build_system", category: "discovery", description: "Detect the build tool, scripts and package manager.", inputSchema: z.object({}), handler: async (_a, env) => { const d = detect(await env.files()); return { data: { buildSystem: d.buildSystem, packageManager: d.packageManager, scripts: d.pkg?.scripts ?? {}, hasViteConfig: d.paths.some((p) => /^vite\.config\./.test(p)) } }; } }),
  defineTool({
    name: "detect_project_type", category: "discovery", description: "Classify the project: static site, React+Vite SPA, full-stack, or empty.",
    inputSchema: z.object({}),
    handler: async (_a, env) => { const s = await env.files(); const d = detect(s); const type = d.framework === "empty" ? "empty" : d.framework === "static" ? "static-site" : isViteProject(s) ? "spa" : ["next", "tanstack-start"].includes(d.framework) ? "full-stack" : "other"; return { data: { type, framework: d.framework, buildable: type === "static-site" || type === "spa" } }; },
  }),

  // ---- Category 3: search / research ----
  defineTool({
    name: "project_search", category: "search", description: "Search code for symbols/text and rank files by relevance.", capabilities: ["find usage", "where is"],
    inputSchema: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(50).default(20) }),
    handler: async (a, env) => {
      const s = await env.files();
      const words = a.query.split(/\s+/).filter((w) => w.length > 1);
      const score = new Map<string, number>();
      for (const w of words) for (const h of searchText(s, { query: w, mode: "exact", limit: 400 })) score.set(h.file, (score.get(h.file) ?? 0) + 1);
      for (const f of s.list()) for (const w of words) if (f.path.toLowerCase().includes(w.toLowerCase())) score.set(f.path, (score.get(f.path) ?? 0) + 5);
      const ranked = [...score.entries()].sort((x, y) => y[1] - x[1]).slice(0, a.limit).map(([file, sc]) => ({ file, score: sc, outline: outline(s, file).slice(0, 8) }));
      return { data: { results: ranked } };
    },
  }),
  webSearchTool,
  defineTool({
    name: "docs_search", category: "search", description: "Search developer documentation (MDN).", requiredPermissions: ["network:fetch"], projectScoped: false, retryPolicy: { maxAttempts: 2, backoffMs: 500 },
    inputSchema: z.object({ query: z.string().min(2).max(200) }),
    handler: async (a, env) => {
      const r = await fetchJson<{ documents?: { title: string; summary: string; mdn_url: string }[] }>(`https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(a.query)}&locale=en-US&size=8`, {}, env);
      if (r.status >= 400) throw new ToolFailure("INTEGRATION_FAILED", `MDN returned ${r.status}`, true);
      return { data: { results: (r.body.documents ?? []).map((d) => ({ title: d.title, snippet: d.summary, source: `https://developer.mozilla.org${d.mdn_url}` })) } };
    },
  }),
  defineTool({
    name: "package_search", category: "search", description: "Search the npm registry.", requiredPermissions: ["network:fetch"], projectScoped: false, retryPolicy: { maxAttempts: 2, backoffMs: 500 },
    inputSchema: z.object({ query: z.string().min(1).max(200), size: z.number().int().min(1).max(20).default(8) }),
    handler: async (a, env) => {
      const r = await fetchJson<{ objects?: { package: { name: string; version: string; description?: string; links?: { npm?: string } }; score?: { final?: number } }[] }>(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(a.query)}&size=${a.size}`, {}, env);
      if (r.status >= 400) throw new ToolFailure("INTEGRATION_FAILED", `npm returned ${r.status}`, true);
      return { data: { results: (r.body.objects ?? []).map((o) => ({ name: o.package.name, version: o.package.version, description: o.package.description ?? "", score: o.score?.final ?? null, source: o.package.links?.npm ?? null })) } };
    },
  }),
  defineTool({
    name: "search_github", category: "search", description: "Search GitHub code or repositories with the user's GitHub connection.", requiredPermissions: ["git:read", "network:fetch"], projectScoped: false, prerequisites: ["github_auth"],
    inputSchema: z.object({ query: z.string().min(2).max(256), type: z.enum(["repositories", "code"]).default("repositories") }),
    handler: async (a, env) => {
      const r = await gh<{ total_count: number; items: { full_name?: string; name?: string; path?: string; html_url: string; description?: string; repository?: { full_name: string } }[] }>(env, "GET", `/search/${a.type}?q=${encodeURIComponent(a.query)}&per_page=10`);
      return { data: { total: r.total_count, results: r.items.map((i) => ({ title: i.full_name ?? `${i.repository?.full_name}/${i.path}`, snippet: i.description ?? i.path ?? "", source: i.html_url })) } };
    },
  }),

  // ---- Category 4: code analysis ----
  defineTool({
    name: "analyze_code", category: "analysis", description: "Outline, imports/exports, references and diagnostics for one file.", capabilities: ["understand file"],
    inputSchema: z.object({ path: P }),
    handler: async (a, env) => { const p = safeToolPath(a.path); const s = await env.files(); getFile(s, p); const d = analyzeFile(s, p); return { data: { path: p, outline: outline(s, p), exports: d.exports, references: d.refs.slice(0, 80), diagnostics: validateFile(s, p).slice(0, 20) } }; },
  }),
  defineTool({
    name: "detect_errors", category: "analysis", description: "All current project errors (syntax, references, imports, exports).", capabilities: ["find bugs", "problems"],
    inputSchema: z.object({}),
    handler: async (_a, env) => { const v = validateProject(await env.files()); return { data: { errors: v.errors, warnings: v.warnings.slice(0, 40), ok: !v.errors.length }, next: v.errors.length ? "diagnose_failure" : null }; },
  }),
  defineTool({
    name: "detect_type_errors", category: "analysis", description: "TypeScript-level problems: syntax, broken imports, missing exports.",
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const s = await env.files();
      const errs = [...s.list().filter((f) => /\.tsx?$/.test(f.path)).flatMap((f) => [...validateTs(f.path), ...validateFile(s, f.path)]), ...(isViteProject(s) ? validateViteExports(s) : [])].filter((d) => d.severity === "error");
      return { data: { errors: errs, ok: !errs.length } };
    },
  }),
  defineTool({
    name: "detect_lint_errors", category: "analysis", description: "Lint rules: debugger statements, console.log, var, ==, empty catch, TODOs, long lines.",
    inputSchema: z.object({}),
    handler: async (_a, env) => ({ data: { findings: lint(await env.files()) } }),
  }),
  defineTool({
    name: "analyze_dependencies", category: "analysis", description: "Dependency report: declared, missing, unused, unpinned.",
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const s = await env.files(); const d = detect(s); const used = importedPackages(s);
      return { data: { declared: d.deps, usedBy: Object.fromEntries([...used.entries()].map(([k, v]) => [k, [...new Set(v)].slice(0, 10)])), missing: [...used.keys()].filter((n) => !d.deps[n]), unpinned: Object.entries(d.deps).filter(([, v]) => v === "*" || v === "latest").map(([k]) => k) } };
    },
  }),
  defineTool({
    name: "analyze_imports", category: "analysis", description: "Import graph between project files plus broken imports.",
    inputSchema: z.object({ path: z.string().optional() }),
    handler: async (a, env) => { const s = await env.files(); const g = projectGraph(s); const p = a.path ? safeToolPath(a.path) : null; return { data: { graph: p ? { [p]: g[p] ?? [] } : g, importedBy: p ? Object.entries(g).filter(([, v]) => v.includes(p)).map(([k]) => k) : undefined, broken: brokenReferences(s).filter((r) => !p || r.file === p).slice(0, 50) } }; },
  }),
  defineTool({ name: "analyze_routes", category: "analysis", description: "Routes with their files and whether the files exist and are valid.", inputSchema: z.object({}), handler: async (_a, env) => { const s = await env.files(); return { data: { routes: detectRoutes(s).map((r) => ({ ...r, errors: validateFile(s, r.file).filter((d) => d.severity === "error").length })) } }; } }),
  defineTool({
    name: "analyze_components", category: "analysis", description: "React components: where defined, exported, and used.",
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const s = await env.files(); const comps: { name: string; file: string; exported: boolean; usedIn: string[] }[] = [];
      const src = s.list().filter((f) => /\.(tsx|jsx)$/.test(f.path));
      for (const f of src) for (const m of f.content.matchAll(/(?:export\s+(default\s+)?)?(?:function|const)\s+([A-Z][A-Za-z0-9]*)\s*(?:[=(:<])/g)) {
        const name = m[2]!; comps.push({ name, file: f.path, exported: !!m[0].startsWith("export") || new RegExp(`export\\s+(default\\s+)?\\{?[^}]*\\b${name}\\b`).test(f.content), usedIn: src.filter((g) => g.path !== f.path && new RegExp(`<${name}[\\s/>]`).test(g.content)).map((g) => g.path) });
      }
      return { data: { components: comps.slice(0, 200), unused: comps.filter((c) => !c.usedIn.length && !/^(App|Root|Layout)$/.test(c.name)).map((c) => `${c.name} (${c.file})`) } };
    },
  }),
];

export function lint(s: import("../../../sandbox/workspace/workspace").MemoryFileStore) {
  const out: { file: string; line: number; rule: string; severity: "error" | "warning"; message: string; fixable: boolean }[] = [];
  for (const f of s.list()) {
    if (!/\.(tsx?|jsx?|mjs)$/.test(f.path) || !TEXT_EXT.test(f.path)) continue;
    f.content.split("\n").forEach((l, i) => {
      const add = (rule: string, severity: "error" | "warning", message: string, fixable = false) => out.push({ file: f.path, line: i + 1, rule, severity, message, fixable });
      if (/^\s*debugger;?\s*$/.test(l)) add("no-debugger", "error", "Remove debugger statement", true);
      if (/\bconsole\.log\(/.test(l)) add("no-console", "warning", "console.log left in code");
      if (/(^|[;{\s])var\s+\w/.test(l)) add("no-var", "warning", "Use let/const instead of var", true);
      if (/[^=!<>]==[^=]/.test(l.replace(/(['"`]).*?\1/g, "")) && !/=>/.test(l)) add("eqeqeq", "warning", "Use === instead of ==");
      if (/catch\s*(\(\w*\))?\s*\{\s*\}/.test(l)) add("no-empty", "warning", "Empty catch block");
      if (/\s+$/.test(l)) add("no-trailing-spaces", "warning", "Trailing whitespace", true);
      if (l.length > 400) add("max-len", "warning", "Very long line");
    });
  }
  return out;
}
