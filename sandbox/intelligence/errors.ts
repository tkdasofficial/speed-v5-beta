// Error intelligence: parse raw build/runtime messages, classify, attach source context, related files and likely cause.
import type { FileStore } from "../types/filesystem";
import { relatedFiles } from "./deps";
import type { Diagnostic, ErrorCategory } from "./types";

const CAUSE: Partial<Record<ErrorCategory, string>> = {
  syntax_error: "Typo or unbalanced bracket/quote near the reported line",
  missing_file: "A file is referenced or required but doesn't exist in .local",
  missing_module: "Bare npm import — static sites can only import relative .js files or full CDN URLs",
  broken_import: "Import path doesn't match an existing file (check folder, spelling, .js extension)",
  broken_reference: "Link points at a page that doesn't exist",
  missing_asset: "Image/font/media path is wrong or the asset was never created",
  invalid_path: "File name or location is not valid for a static site",
  html_error: "Unbalanced or mis-nested HTML tags",
  css_error: "Unbalanced braces or malformed declarations",
  typescript_error: "TypeScript needs a compile step that static sites don't have",
  build_configuration_error: "Project shape doesn't match a static site (index.html at root)",
  runtime_error: "Script threw while the page was running",
};

/** Source lines around a position, numbered. */
export function errorContext(store: FileStore, file: string, line: number, radius = 3): string {
  const text = store.get(file)?.content;
  if (text === undefined) return "";
  const lines = text.split("\n");
  const from = Math.max(1, line - radius), to = Math.min(lines.length, line + radius);
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${i === line ? ">" : " "}${String(i).padStart(4)} | ${lines[i - 1]!.slice(0, 200)}`);
  return out.join("\n");
}

/** Fills category-derived fields (cause, context, related files) on a diagnostic. */
export function classify(store: FileStore, x: Diagnostic): Diagnostic {
  const rel = store.get(x.file) ? relatedFiles(store, x.file) : { uses: [], usedBy: [] };
  const related = [...new Set([...(x.related ?? []), ...rel.uses, ...rel.usedBy])].slice(0, 10);
  return { ...x, related, context: x.context ?? errorContext(store, x.file, x.line), cause: x.cause ?? CAUSE[x.type] ?? "Unknown — inspect the context" };
}

/** Turns a raw message (build failure, runtime error) into a classified diagnostic. */
export function parseErrorMessage(store: FileStore, raw: string, fallbackFile = "index.html"): Diagnostic {
  const loc = /([\w./-]+\.(?:html?|css|m?js|json|ts))(?::(\d+))?(?::(\d+))?/.exec(raw);
  const msg = raw.replace(/\s+/g, " ").slice(0, 400);
  let type: ErrorCategory = "unknown_error";
  if (/unexpected token|syntax/i.test(msg)) type = "syntax_error";
  else if (/is not defined|cannot read|undefined|null|is not a function/i.test(msg)) type = "runtime_error";
  else if (/not found|no such file|404/i.test(msg)) type = "missing_file";
  else if (/index\.html/i.test(msg)) type = "build_configuration_error";
  else if (/package|runtime/i.test(msg)) type = "dependency_error";
  return classify(store, { type, severity: "error", file: loc?.[1] ?? fallbackFile, line: Number(loc?.[2] ?? 1), column: Number(loc?.[3] ?? 1), message: msg, code: `ERR_${type.toUpperCase()}` });
}

/** Compact text form fed back to the model. */
export function formatDiagnostics(list: Diagnostic[], max = 12): string {
  return list.slice(0, max).map((x) => `- [${x.severity}] ${x.type} ${x.code} ${x.file}:${x.line}:${x.column} — ${x.message}${x.cause ? `\n  cause: ${x.cause}` : ""}${x.related?.length ? `\n  related: ${x.related.join(", ")}` : ""}${x.context ? `\n${x.context}` : ""}`).join("\n") + (list.length > max ? `\n… ${list.length - max} more` : "");
}
