// Discovery, search and inspection over a FileStore. Results carry line numbers; nothing loads the whole project.
import type { FileStore } from "../types/filesystem";
import { analyzeFile } from "./deps";

export interface SearchOpts { query: string; mode?: "exact" | "fuzzy" | "regex"; ext?: string[]; dir?: string; caseSensitive?: boolean; limit?: number }
export interface Hit { file: string; line: number; column: number; text: string }

const inScope = (path: string, o: { ext?: string[]; dir?: string }) =>
  (!o.dir || path === o.dir || path.startsWith(`${o.dir.replace(/\/+$/, "")}/`)) && (!o.ext?.length || o.ext.some((e) => path.toLowerCase().endsWith(`.${e.replace(/^\./, "").toLowerCase()}`)));

function fuzzyScore(hay: string, needle: string): number {
  let i = 0, score = 0, run = 0;
  for (const c of hay) { if (c === needle[i]) { i++; run++; score += run; } else run = 0; if (i === needle.length) return score; }
  return -1;
}

export function searchText(store: FileStore, o: SearchOpts): Hit[] {
  const limit = o.limit ?? 50, out: Hit[] = [];
  const flags = o.caseSensitive ? "g" : "gi";
  const re = o.mode === "regex" ? new RegExp(o.query, flags) : o.mode === "fuzzy" ? null : new RegExp(o.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  const words = o.query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const f of store.list()) {
    if (f.encoding === "base64" || !inScope(f.path, o)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length && out.length < limit; i++) {
      const l = lines[i]!;
      if (re) { re.lastIndex = 0; const m = re.exec(l); if (m) out.push({ file: f.path, line: i + 1, column: m.index + 1, text: l.trim().slice(0, 200) }); }
      else { const low = l.toLowerCase(); if (words.every((w) => low.includes(w) || fuzzyScore(low, w) > w.length)) out.push({ file: f.path, line: i + 1, column: 1, text: l.trim().slice(0, 200) }); }
    }
    if (out.length >= limit) break;
  }
  return out;
}

export function searchFilename(store: FileStore, query: string, o: { ext?: string[]; dir?: string } = {}): string[] {
  const q = query.toLowerCase();
  return store.list().map((f) => f.path).filter((p) => inScope(p, o))
    .map((p) => ({ p, s: p.toLowerCase().includes(q) ? 1000 - p.length : fuzzyScore(p.toLowerCase(), q) }))
    .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 30).map((x) => x.p);
}

export function readRange(store: FileStore, file: string, start: number, end: number): string | null {
  const t = store.get(file)?.content; if (t === undefined) return null;
  const lines = t.split("\n"), s = Math.max(1, start), e = Math.min(lines.length, Math.max(s, end));
  return lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(4)} | ${l}`).join("\n");
}

/** Structural outline: headings/sections/ids for HTML, selectors for CSS, functions/classes/exports for JS. */
export function outline(store: FileStore, file: string): { line: number; kind: string; name: string }[] {
  const t = store.get(file)?.content ?? "";
  const out: { line: number; kind: string; name: string }[] = [];
  t.split("\n").forEach((l, i) => {
    const line = i + 1;
    if (/\.html?$/i.test(file)) {
      for (const m of l.matchAll(/<(header|nav|main|section|footer|form|h[1-3]|button|article|aside)\b([^>]*)>/gi)) {
        const id = /\bid=["']([^"']+)/i.exec(m[2]!)?.[1], cls = /\bclass=["']([^"']+)/i.exec(m[2]!)?.[1];
        out.push({ line, kind: m[1]!.toLowerCase(), name: `${id ? `#${id}` : ""}${cls ? `.${cls.split(/\s+/).join(".")}` : ""}` || m[1]! });
      }
    } else if (/\.css$/i.test(file)) { const m = /^\s*([^{}@/][^{]*?)\s*\{/.exec(l); if (m) out.push({ line, kind: "rule", name: m[1]!.slice(0, 80) }); else if (/^\s*@(media|keyframes|font-face)/.test(l)) out.push({ line, kind: "at-rule", name: l.trim().replace(/\{.*$/, "").slice(0, 80) }); }
    else if (/\.(m?js|ts)$/i.test(file)) {
      const m = /\b(function\*?|class)\s+([A-Za-z_$][\w$]*)/.exec(l) ?? /\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/.exec(l);
      if (m) out.push({ line, kind: m[1]!.startsWith("function") ? "function" : m[1] === "class" ? "class" : "function", name: m[2]! });
      const ev = /addEventListener\(\s*["'](\w+)/.exec(l); if (ev) out.push({ line, kind: "listener", name: ev[1]! });
    }
  });
  return out.slice(0, 200);
}

/** Elements matching a simple selector (tag, #id, .class, tag.class) with line numbers. */
export function findHtmlElements(store: FileStore, selector: string): Hit[] {
  const m = /^([a-z][\w-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)$/i.exec(selector.trim());
  if (!m) return searchText(store, { query: selector, ext: ["html", "htm"] });
  const [, tag, id, cls] = m, classes = (cls ?? "").split(".").filter(Boolean);
  const out: Hit[] = [];
  for (const f of store.list()) if (/\.html?$/i.test(f.path)) f.content.split("\n").forEach((l, i) => {
    for (const x of l.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
      if (tag && x[1]!.toLowerCase() !== tag.toLowerCase()) continue;
      if (id && !new RegExp(`\\bid=["']${id}["']`).test(x[2]!)) continue;
      const have = (/\bclass=["']([^"']*)/.exec(x[2]!)?.[1] ?? "").split(/\s+/);
      if (classes.some((c) => !have.includes(c))) continue;
      out.push({ file: f.path, line: i + 1, column: (x.index ?? 0) + 1, text: x[0].slice(0, 200) });
    }
  });
  return out.slice(0, 50);
}

/** CSS rules whose selector mentions the given token (class, id or tag). */
export function findCssSelectors(store: FileStore, token: string): Hit[] {
  const t = token.replace(/^[.#]/, "");
  const re = new RegExp(`(^|[\\s,>+~.#(])[.#]?${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])[^{]*\\{`);
  const out: Hit[] = [];
  for (const f of store.list()) {
    if (!/\.(css|html?)$/i.test(f.path)) continue;
    f.content.split("\n").forEach((l, i) => { if (re.test(l)) out.push({ file: f.path, line: i + 1, column: 1, text: l.trim().slice(0, 200) }); });
  }
  return out.slice(0, 50);
}

export function findJsSymbols(store: FileStore, name: string): Hit[] {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return searchText(store, { query: `\\b(function\\*?|class|const|let|var)\\s+${esc}\\b|\\b${esc}\\s*[:=]\\s*(async\\s*)?(function|\\()`, mode: "regex", caseSensitive: true, ext: ["js", "mjs", "html", "htm"] });
}

export function findReferences(store: FileStore, name: string): Hit[] {
  return searchText(store, { query: `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, mode: "regex", caseSensitive: true });
}

export function findImports(store: FileStore, file?: string) {
  return store.list().filter((f) => !file || f.path === file).flatMap((f) => analyzeFile(store, f.path).refs.filter((r) => r.kind === "module" || r.kind === "script" || r.kind === "stylesheet" || r.kind === "css-import").map((r) => ({ file: f.path, ...r })));
}
export function findExports(store: FileStore, file?: string) {
  return store.list().filter((f) => /\.(m?js|ts)$/i.test(f.path) && (!file || f.path === file)).map((f) => ({ file: f.path, exports: analyzeFile(store, f.path).exports }));
}
