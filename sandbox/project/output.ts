import type { Diagnostic } from "../intelligence/types";
import { runStaticPage } from "./runner";
import type { FileEntry, FileStore } from "../types/filesystem";
/** A successful .output generation. */
export interface OutputRecord { id: string; createdAt: number; entry: string; files: FileEntry[] }
export type OutputResult = { ok: true; record: OutputRecord; warnings?: Diagnostic[] } | { ok: false; error: string; diagnostics?: Diagnostic[]; warnings?: Diagnostic[] };
const STATIC = /\.(html?|css|js|mjs|json|svg|txt|xml|webmanifest|ico|png|jpe?g|gif|webp|avif|woff2?|ttf|otf|csv|md|mp3|mp4|webm)$/i;
/**
 * Produces static output from .local: the project must have index.html at its root.
 * Runs entirely in the browser — framework builds need a runtime that is not attached.
 */
export function generateStaticOutput(local: FileStore, id: string): OutputResult {
  const files = local.list().filter((f) => STATIC.test(f.path));
  if (!local.get("index.html")) {
    const hasPkg = !!local.get("package.json");
    return { ok: false, error: hasPkg
      ? "This project needs a build runtime to produce output (package.json found, no index.html at the project root). Build runtimes are not connected yet."
      : "No index.html at the project root — add one to generate a preview." };
  }
  const now = Date.now();
  return { ok: true, record: { id, createdAt: now, entry: "index.html", files: files.map((f) => ({ ...f, updatedAt: now })) } };
}
/** Replaces the .output store contents with a successful record (never called for failures). */
export function writeOutput(output: FileStore, rec: OutputRecord): void {
  output.clear();
  for (const f of rec.files) output.set({ ...f });
}
/** Renders an output page through the in-browser static runner (see runner.ts). */
export function renderOutputPage(output: FileStore, page: string): string | null { return runStaticPage(output, page); }
