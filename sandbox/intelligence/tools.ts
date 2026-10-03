// Internal agent tool registry. Every tool is scoped to the project's .local root, never edits .output,
// and returns a structured { success, data | error } result. Not exposed in the UI.
import type { FileStore } from "../types/filesystem";
import { normalizePath } from "../utils/paths";
import { analyzeFile, brokenReferences, projectGraph, relatedFiles } from "./deps";
import { errorContext, formatDiagnostics, parseErrorMessage } from "./errors";
import { findCssSelectors, findExports, findHtmlElements, findImports, findJsSymbols, findReferences, outline, readRange, searchFilename, searchText } from "./search";
import { validateCss, validateFile, validateHtml, validateJs, validateJson, validateProject, validateReferences, validatePaths, validateTs } from "./validate";
import { ChangeTracker, lineDiff } from "./changes";
import type { Diagnostic, ToolResult } from "./types";
import { fail, ok } from "./types";

export type BuildOutcome = { ok: true; outputId: string; files: number; warnings: Diagnostic[] } | { ok: false; errors: Diagnostic[]; warnings: Diagnostic[] };

/** What the tool layer needs from the host (the Sandbox via WorkspaceStore). Writes go through it so UI, editor and persistence stay in sync. */
export interface ToolHost {
  local: FileStore;
  output: FileStore;
  folders(): string[];
  write(path: string, content: string): void;
  create(path: string, content: string): void;
  remove(path: string): void;
  move(from: string, to: string): void;
  build(): BuildOutcome;
  lastOutput(): { id: string; createdAt: number; files: number } | null;
  outputStale(): boolean;
  previewErrors(): string[];
  clearPreviewErrors(): void;
}

export const WRITE_TOOLS = new Set(["create_file", "edit_file", "patch_file", "delete_file", "rename_file", "move_file", "rollback_change"]);
export const BUILD_TOOLS = new Set(["build_project", "build_static"]);

type Args = Record<string, unknown>;
const str = (a: Args, k: string, req = true): string => { const v = a[k]; if (typeof v === "string" && v) return v; if (req) throw new ToolArgError(`"${k}" is required`); return ""; };
const num = (a: Args, k: string, d: number) => (typeof a[k] === "number" ? (a[k] as number) : d);
const list = (a: Args, k: string): string[] | undefined => (Array.isArray(a[k]) ? (a[k] as unknown[]).filter((x): x is string => typeof x === "string") : typeof a[k] === "string" ? [a[k] as string] : undefined);
class ToolArgError extends Error {}

/** Project-boundary path check: relative to .local, no escapes, never .output. */
function safePath(raw: string): string {
  const p = normalizePath(raw.replace(/^\.local\/?/, "").replace(/^\/+/, ""));
  if (p === ".output" || p.startsWith(".output/")) throw new ToolArgError(".output is generated and read-only — edit the source in .local and rebuild");
  if (/^\.git(\/|$)/.test(p) || /(^|\/)\.env(\.|$)/.test(p)) throw new ToolArgError(`Protected path: ${p}`);
  return p;
}

export class AgentTools {
  readonly changes = new ChangeTracker();
  private buildLog: string[] = [];
  private lastBuild: BuildOutcome | null = null;
  private builds = 0;
  constructor(private host: ToolHost, private maxBuilds = 12) {}

  run(name: string, args: Args = {}): ToolResult {
    try {
      const fn = (this.tools as Record<string, (a: Args) => ToolResult>)[name];
      if (!fn) return fail("unknown_tool", `No tool named ${name}`);
      return fn.call(this, args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof ToolArgError) return fail("invalid_arguments", msg);
      if (/No such file|not found/i.test(msg)) return fail("file_not_found", msg, typeof args["path"] === "string" ? args["path"] : undefined);
      if (/escapes|Empty path|Protected|INVALID_PATH|FORBIDDEN/i.test(msg)) return fail("invalid_path", msg);
      return fail("tool_error", msg);
    }
  }

  private file(path: string) { const f = this.host.local.get(path); if (!f) throw new Error(`No such file: ${path}`); return f; }

  /** Edits are checked syntactically after applying; a new syntax error is reported, not silently kept. */
  private afterWrite(path: string): Diagnostic[] { return validateFile(this.host.local, path).filter((d) => d.severity === "error" && d.type !== "missing_file"); }

  private tools = {
    // ---- discovery ----
    list_files: (a: Args) => ok(this.host.local.list().map((f) => f.path).filter((p) => { const d = str(a, "dir", false); return !d || p.startsWith(`${d.replace(/\/+$/, "")}/`); }).sort()),
    list_directories: () => ok(this.host.folders().sort()),
    get_file_tree: () => {
      const lines: string[] = [];
      for (const p of [...this.host.local.list().map((f) => f.path), ...this.host.folders().map((f) => `${f}/`)].sort()) lines.push(`${"  ".repeat(p.replace(/\/$/, "").split("/").length - 1)}${p.replace(/\/$/, "").split("/").pop()}${p.endsWith("/") ? "/" : ""}`);
      return ok(lines.join("\n"));
    },
    file_exists: (a: Args) => { const p = safePath(str(a, "path")); return ok({ path: p, exists: !!this.host.local.get(p), isFolder: this.host.folders().includes(p) }); },
    get_file_metadata: (a: Args) => { const p = safePath(str(a, "path")); const f = this.file(p); return ok({ path: p, size: f.content.length, lines: f.content.split("\n").length, encoding: f.encoding, updatedAt: f.updatedAt }); },

    // ---- search ----
    search_text: (a: Args) => ok(searchText(this.host.local, { query: str(a, "query"), mode: (a["mode"] as "exact" | "fuzzy" | "regex") ?? "exact", ...(list(a, "ext") ? { ext: list(a, "ext")! } : {}), ...(str(a, "dir", false) ? { dir: str(a, "dir") } : {}), caseSensitive: a["caseSensitive"] === true, limit: num(a, "limit", 40) })),
    search_files: (a: Args) => this.tools.search_text(a),
    search_filename: (a: Args) => ok(searchFilename(this.host.local, str(a, "query"), { ...(list(a, "ext") ? { ext: list(a, "ext")! } : {}), ...(str(a, "dir", false) ? { dir: str(a, "dir") } : {}) })),
    find_references: (a: Args) => ok(findReferences(this.host.local, str(a, "name"))),
    find_imports: (a: Args) => ok(findImports(this.host.local, str(a, "path", false) || undefined)),
    find_exports: (a: Args) => ok(findExports(this.host.local, str(a, "path", false) || undefined)),
    find_html_elements: (a: Args) => ok(findHtmlElements(this.host.local, str(a, "selector"))),
    find_css_selectors: (a: Args) => ok(findCssSelectors(this.host.local, str(a, "selector"))),
    find_js_symbols: (a: Args) => ok(findJsSymbols(this.host.local, str(a, "name"))),

    // ---- inspection ----
    read_file: (a: Args) => { const p = safePath(str(a, "path")); const f = this.file(p); return ok(f.encoding === "base64" ? `(binary ${f.content.length} bytes base64)` : f.content.slice(0, 20000) + (f.content.length > 20000 ? "\n… (truncated — use read_file_range)" : "")); },
    read_file_range: (a: Args) => { const p = safePath(str(a, "path")); this.file(p); return ok(readRange(this.host.local, p, num(a, "start", 1), num(a, "end", num(a, "start", 1) + 80))); },
    get_file_outline: (a: Args) => { const p = safePath(str(a, "path")); this.file(p); return ok(outline(this.host.local, p)); },
    get_code_context: (a: Args) => { const p = safePath(str(a, "path")); this.file(p); return ok(errorContext(this.host.local, p, num(a, "line", 1), num(a, "radius", 8))); },

    // ---- modification (targeted, tracked, syntax-checked) ----
    create_file: (a: Args) => {
      const p = safePath(str(a, "path")); const content = typeof a["content"] === "string" ? a["content"] : "";
      const before = this.host.local.get(p)?.content ?? null;
      if (before === null) this.host.create(p, content); else this.host.write(p, content);
      const c = this.changes.record({ kind: before === null ? "add" : "modify", path: p, before, after: content, reason: str(a, "reason", false) });
      return ok({ change: c.id, path: p, diagnostics: this.afterWrite(p) });
    },
    edit_file: (a: Args) => {
      const p = safePath(str(a, "path")); const cur = this.file(p).content;
      if (typeof a["content"] === "string" && a["find"] === undefined) return this.tools.create_file(a);
      const find = str(a, "find"); const replace = typeof a["replace"] === "string" ? a["replace"] : "";
      const n = cur.split(find).length - 1;
      if (!n) return fail("text_not_found", `The text to replace wasn't found in ${p} — read the file and copy the exact text`, p);
      if (n > 1 && a["all"] !== true) return fail("ambiguous_match", `The text appears ${n} times in ${p} — include more surrounding text or pass "all": true`, p);
      const next = a["all"] === true ? cur.split(find).join(replace) : cur.replace(find, () => replace);
      this.host.write(p, next);
      const c = this.changes.record({ kind: "modify", path: p, before: cur, after: next, reason: str(a, "reason", false) });
      return ok({ change: c.id, path: p, diagnostics: this.afterWrite(p) });
    },
    patch_file: (a: Args) => {
      const p = safePath(str(a, "path")); const cur = this.file(p).content;
      const edits = Array.isArray(a["edits"]) ? (a["edits"] as { find?: unknown; replace?: unknown }[]) : [];
      if (!edits.length) throw new ToolArgError('"edits" must be a list of {find, replace}');
      let next = cur;
      for (const [i, e] of edits.entries()) {
        if (typeof e.find !== "string" || !next.includes(e.find)) return fail("text_not_found", `Edit ${i + 1}: text not found in ${p} — nothing was changed`, p);
        next = next.replace(e.find, () => (typeof e.replace === "string" ? e.replace : ""));
      }
      this.host.write(p, next);
      const c = this.changes.record({ kind: "modify", path: p, before: cur, after: next, reason: str(a, "reason", false) });
      return ok({ change: c.id, path: p, edits: edits.length, diagnostics: this.afterWrite(p) });
    },
    delete_file: (a: Args) => {
      const p = safePath(str(a, "path")); const before = this.file(p).content;
      const usedBy = relatedFiles(this.host.local, p).usedBy;
      if (usedBy.length && a["force"] !== true) return fail("has_references", `${p} is still referenced by ${usedBy.join(", ")} — update those first or pass "force": true`, p);
      this.host.remove(p);
      const c = this.changes.record({ kind: "delete", path: p, before, after: null, reason: str(a, "reason", false) });
      return ok({ change: c.id, path: p });
    },
    rename_file: (a: Args) => this.tools.move_file({ ...a, to: (() => { const p = safePath(str(a, "path")); const n = str(a, "name"); if (n.includes("/")) throw new ToolArgError("name cannot contain /"); return [...p.split("/").slice(0, -1), n].join("/"); })() }),
    move_file: (a: Args) => {
      const from = safePath(str(a, "path", false) || str(a, "from")); const to = safePath(str(a, "to"));
      const content = this.file(from).content;
      if (this.host.local.get(to)) return fail("already_exists", `${to} already exists`, to);
      const usedBy = relatedFiles(this.host.local, from).usedBy;
      this.host.move(from, to);
      const c = this.changes.record({ kind: "rename", from, path: to, before: content, after: content, reason: str(a, "reason", false) });
      return ok({ change: c.id, from, to, updateReferencesIn: usedBy });
    },

    // ---- understanding ----
    analyze_file_dependencies: (a: Args) => { const p = safePath(str(a, "path")); this.file(p); const d = analyzeFile(this.host.local, p); return ok({ ...d, selectors: d.selectors.slice(0, 80) }); },
    analyze_project_dependencies: () => ok(projectGraph(this.host.local)),
    get_dependency_graph: () => ok(projectGraph(this.host.local)),
    find_related_files: (a: Args) => ok(relatedFiles(this.host.local, safePath(str(a, "path")))),
    find_asset_references: (a: Args) => { const q = str(a, "path", false); return ok(this.host.local.list().flatMap((f) => analyzeFile(this.host.local, f.path).refs.filter((r) => (r.kind === "asset" || r.kind === "css-url") && (!q || r.target === q || r.ref.includes(q))).map((r) => ({ file: f.path, ...r })))); },
    find_broken_references: () => ok(brokenReferences(this.host.local)),

    // ---- validation ----
    validate_html: (a: Args) => { const p = safePath(str(a, "path")); return ok(split(validateHtml(p, this.file(p).content))); },
    validate_css: (a: Args) => { const p = safePath(str(a, "path")); return ok(split(validateCss(p, this.file(p).content))); },
    validate_javascript: (a: Args) => { const p = safePath(str(a, "path")); return ok(split(validateJs(p, this.file(p).content))); },
    validate_typescript: (a: Args) => { const p = safePath(str(a, "path")); this.file(p); return ok(split(validateTs(p))); },
    validate_json: (a: Args) => { const p = safePath(str(a, "path")); return ok(split(validateJson(p, this.file(p).content))); },
    validate_project: () => ok(validateProject(this.host.local)),
    validate_paths: () => ok(split(validatePaths(this.host.local))),
    validate_assets: () => ok(split(validateReferences(this.host.local).filter((d) => d.type === "missing_asset"))),
    validate_references: () => ok(split(validateReferences(this.host.local))),

    // ---- build (transactional: a failed build never replaces .output) ----
    build_project: () => {
      if (++this.builds > this.maxBuilds) return fail("build_limit", `Build limit (${this.maxBuilds}) reached for this request — stop and report the remaining errors`);
      const r = this.host.build();
      this.lastBuild = r;
      this.buildLog.push(r.ok ? `#${this.builds} OK → .output ${r.outputId} (${r.files} files, ${r.warnings.length} warnings)` : `#${this.builds} FAILED (${r.errors.length} errors) — previous .output kept`);
      return ok(r);
    },
    build_static: () => this.tools.build_project(),
    build_typescript: () => fail("unsupported", "No TypeScript compiler in static projects — convert to .js"),
    get_build_status: () => ok({ last: this.lastBuild ? (this.lastBuild.ok ? "success" : "failed") : "never", builds: this.builds, output: this.host.lastOutput(), stale: this.host.outputStale() }),
    get_build_logs: () => ok(this.buildLog.slice(-20)),
    get_build_output: () => ok(this.host.output.list().map((f) => f.path).sort()),
    clean_build_artifacts: () => ok({ removed: 0, note: "Builds are staged in memory and discarded on failure; the last good .output is kept on purpose" }),

    // ---- errors ----
    get_errors: () => { const v = validateProject(this.host.local); const rt = this.host.previewErrors().map((m) => parseErrorMessage(this.host.local, m)); return ok({ errors: [...v.errors, ...rt], warnings: v.warnings, lastBuild: this.lastBuild && !this.lastBuild.ok ? this.lastBuild.errors : [] }); },
    parse_build_errors: (a: Args) => ok((list(a, "messages") ?? []).map((m) => parseErrorMessage(this.host.local, m))),
    classify_error: (a: Args) => ok(parseErrorMessage(this.host.local, str(a, "message"), str(a, "path", false) || undefined)),
    get_error_context: (a: Args) => { const p = safePath(str(a, "path")); this.file(p); return ok(errorContext(this.host.local, p, num(a, "line", 1), num(a, "radius", 6))); },
    find_error_source: (a: Args) => { const d = parseErrorMessage(this.host.local, str(a, "message")); return ok({ file: d.file, line: d.line, type: d.type, context: d.context }); },
    find_related_error_files: (a: Args) => ok(relatedFiles(this.host.local, safePath(str(a, "path")))),
    check_error_dependencies: (a: Args) => { const p = safePath(str(a, "path")); return ok(analyzeFile(this.host.local, p).refs.filter((r) => !r.external && !r.exists)); },

    // ---- change tracking ----
    get_changed_files: () => ok(this.changes.summary()),
    get_change_diff: (a: Args) => {
      const id = num(a, "change", 0); const path = str(a, "path", false);
      const items = id ? [this.changes.get(id)].filter(Boolean) : this.changes.all().filter((c) => !path || c.path === path);
      return ok(items.map((c) => (c!.kind === "rename" ? `renamed ${c!.from} → ${c!.path}` : lineDiff(c!.before ?? "", c!.after ?? "", c!.path))).join("\n\n") || "(no changes)");
    },
    rollback_change: (a: Args) => {
      const c = a["change"] ? this.changes.get(num(a, "change", 0)) : this.changes.last();
      if (!c || c.rolledBack) return fail("not_found", "No change to roll back");
      if (c.kind === "add") this.host.remove(c.path);
      else if (c.kind === "delete") this.host.create(c.path, c.before ?? "");
      else if (c.kind === "rename") this.host.move(c.path, c.from!);
      else this.host.write(c.path, c.before ?? "");
      c.rolledBack = true;
      return ok({ rolledBack: c.id, path: c.path, kind: c.kind });
    },

    // ---- preview verification (reads .output only) ----
    start_preview: () => (this.host.lastOutput() ? ok({ status: "running", output: this.host.lastOutput() }) : fail("no_output", "No successful build yet — run build_project")),
    stop_preview: () => ok({ status: "stopped" }),
    get_preview_status: () => ok({ output: this.host.lastOutput(), stale: this.host.outputStale(), runtimeErrors: this.host.previewErrors().length }),
    check_preview: () => {
      if (!this.host.lastOutput()) return fail("no_output", "No successful build yet — run build_project");
      const broken = validateReferences(this.host.output).filter((d) => d.severity === "error");
      return ok({ ok: !broken.length, broken: broken.map((d) => ({ file: d.file, line: d.line, type: d.type, message: d.message, fixIn: `.local/${d.file}` })) });
    },
    capture_preview_errors: (a: Args) => { const e = this.host.previewErrors().map((m) => parseErrorMessage(this.host.local, m)); if (a["clear"] === true) this.host.clearPreviewErrors(); return ok(e); },
  };
}

function split(list: Diagnostic[]) { return { errors: list.filter((d) => d.severity === "error"), warnings: list.filter((d) => d.severity === "warning") }; }

/** Short text for the model: tool name + result, truncated. */
export function formatToolResult(name: string, r: ToolResult, max = 12000): string {
  if (!r.success) return `${name}: ERROR ${r.error.type} — ${r.error.message}`;
  const d = r.data as { ok?: boolean; errors?: Diagnostic[]; warnings?: Diagnostic[]; diagnostics?: Diagnostic[] } | string;
  if (typeof d === "string") return `${name}: ok\n${d.slice(0, max)}`;
  if (d && Array.isArray(d.errors) && Array.isArray(d.warnings)) {
    const head = d.ok === true ? "BUILD OK" : d.ok === false ? "BUILD FAILED (previous .output kept)" : `${d.errors.length} errors, ${d.warnings.length} warnings`;
    return `${name}: ${head}\n${formatDiagnostics(d.errors)}${d.warnings.length ? `\nwarnings:\n${formatDiagnostics(d.warnings, 5)}` : ""}`.slice(0, max);
  }
  if (d && Array.isArray(d.diagnostics) && d.diagnostics.length) return `${name}: ok but introduced errors:\n${formatDiagnostics(d.diagnostics)}`.slice(0, max);
  return `${name}: ok ${JSON.stringify(d).slice(0, max)}`;
}
