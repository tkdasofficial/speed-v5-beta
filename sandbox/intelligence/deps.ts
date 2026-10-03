// Relationship analysis between project files: HTML → CSS/JS/assets, JS imports/exports, CSS imports/urls/selectors.
import type { FileStore } from "../types/filesystem";
import { resolvePath, findPage } from "../project/runner";
import { lineCol } from "./types";

export type RefKind = "stylesheet" | "script" | "module" | "asset" | "link" | "css-import" | "css-url";
export interface Ref { kind: RefKind; ref: string; target: string; line: number; external: boolean; exists: boolean; bare?: boolean }
export interface FileDeps { file: string; refs: Ref[]; exports: string[]; selectors: string[]; ids: string[]; classes: string[] }

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/|#|data:|mailto:|tel:|javascript:)/i;

function add(store: FileStore, file: string, out: Ref[], kind: RefKind, raw: string, text: string, at: number) {
  const ref = raw.trim();
  if (!ref) return;
  const external = EXTERNAL.test(ref);
  let target = "", exists = true;
  if (!external) {
    target = resolvePath(file, ref);
    exists = kind === "link" ? !!findPage(store, target) || !!store.get(target) : !!store.get(target);
  }
  out.push({ kind, ref, target, line: lineCol(text, at).line, external, exists });
}

export function analyzeFile(store: FileStore, file: string): FileDeps {
  const text = store.get(file)?.content ?? "";
  const refs: Ref[] = [], exports: string[] = [], selectors: string[] = [], ids: string[] = [], classes: string[] = [];
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => { re.lastIndex = 0; let m; while ((m = re.exec(text))) fn(m); };
  if (/\.html?$/i.test(file)) {
    each(/<link\b[^>]*>/gi, (m) => {
      const href = /\bhref=["']([^"']+)["']/i.exec(m[0])?.[1];
      if (href) add(store, file, refs, /stylesheet/i.test(m[0]) ? "stylesheet" : "asset", href, text, m.index);
    });
    each(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, (m) => add(store, file, refs, /type=["']module/i.test(m[0]) ? "module" : "script", m[1]!, text, m.index));
    each(/<(?:img|source|video|audio|iframe|embed)\b[^>]*\b(?:src|poster)=["']([^"']+)["']/gi, (m) => add(store, file, refs, "asset", m[1]!, text, m.index));
    each(/<a\b[^>]*\bhref=["']([^"']+)["']/gi, (m) => add(store, file, refs, "link", m[1]!, text, m.index));
    each(/\bid=["']([^"']+)["']/gi, (m) => ids.push(m[1]!));
    each(/\bclass=["']([^"']+)["']/gi, (m) => classes.push(...m[1]!.split(/\s+/).filter(Boolean)));
    each(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m) => cssInto(m[1]!, m.index));
  } else if (/\.css$/i.test(file)) cssInto(text, 0);
  else if (/\.(m?js|ts)$/i.test(file)) {
    each(/\b(?:import|export)\s[^"'`;]*?\bfrom\s*["']([^"']+)["']/g, (m) => add(store, file, refs, "module", m[1]!, text, m.index));
    each(/\bimport\s*\(?\s*["']([^"']+)["']/g, (m) => add(store, file, refs, "module", m[1]!, text, m.index));
    each(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m) => exports.push(m[1]!));
    each(/\bexport\s*\{([^}]*)\}/g, (m) => exports.push(...m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!).filter(Boolean)));
    if (/\bexport\s+default\b/.test(text)) exports.push("default");
  }
  // Bare-specifier modules (npm packages) can't resolve in a static site.
  if (/\.(m?js|ts)$/i.test(file)) for (const r of refs) if (r.kind === "module" && !r.external && !/^\.{0,2}\//.test(r.ref)) { r.target = r.ref; r.exists = false; r.bare = true; }
  return { file, refs, exports, selectors, ids, classes };

  function cssInto(css: string, base: number) {
    const re1 = /@import\s+(?:url\()?\s*["']([^"']+)["']/gi; let m;
    while ((m = re1.exec(css))) add(store, file, refs, "css-import", m[1]!, text, base + m.index);
    const re2 = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
    while ((m = re2.exec(css))) if (!/^data:/i.test(m[2]!)) add(store, file, refs, "css-url", m[2]!, text, base + m.index);
    const re3 = /(^|})\s*([^{}@][^{}]*?)\s*\{/g;
    while ((m = re3.exec(css.replace(/\/\*[\s\S]*?\*\//g, "")))) selectors.push(...m[2]!.split(",").map((s) => s.trim()).filter(Boolean));
  }
}

export function projectGraph(store: FileStore): Record<string, string[]> {
  const g: Record<string, string[]> = {};
  for (const f of store.list()) g[f.path] = analyzeFile(store, f.path).refs.filter((r) => !r.external && r.kind !== "link").map((r) => r.target);
  return g;
}

/** Files that reference `file` plus files it references. */
export function relatedFiles(store: FileStore, file: string): { uses: string[]; usedBy: string[] } {
  const g = projectGraph(store);
  return { uses: [...new Set(g[file] ?? [])], usedBy: Object.keys(g).filter((k) => g[k]!.includes(file)) };
}

export function brokenReferences(store: FileStore): (Ref & { file: string })[] {
  const out: (Ref & { file: string })[] = [];
  for (const f of store.list()) for (const r of analyzeFile(store, f.path).refs) if (!r.external && !r.exists) out.push({ ...r, file: f.path });
  return out;
}
