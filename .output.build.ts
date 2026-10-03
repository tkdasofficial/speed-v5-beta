// Output preparation for Speed previews. Small, deterministic and secret-free: it validates a production
// artifact (the files of `.output/dist/` for framework projects, or the final static files for HTML projects),
// keeps its multi-file structure, and rewrites root-relative references so the artifact works under any
// preview base path. It never inlines files into one HTML document.
export type ArtifactFile = { path: string; content: string }; // content is base64
export type Artifact = { entry: "index.html"; files: ArtifactFile[]; fileCount: number; bytes: number };
export type ProjectType = "static" | "react-vite";

export const OUTPUT_DIR = ".output/dist";
export const MAX_ARTIFACT_FILES = 3000;
export const MAX_ARTIFACT_BYTES = 40_000_000;

export class ArtifactError extends Error {}

export function isSafePath(p: string): boolean {
  if (!p || p.length > 400 || p.startsWith("/") || p.includes("\\") || /^[a-zA-Z]:/.test(p) || /[\u0000-\u001f]/.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

const dec = new TextDecoder(), enc = new TextEncoder();
const fromB64 = (b: string) => dec.decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
export const toB64 = (s: string) => { const u = enc.encode(s); let out = ""; for (let i = 0; i < u.length; i += 0x8000) out += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(out); };

/** "/assets/a.js" seen from "pages/x.html" becomes "../assets/a.js". Protocol-relative ("//") URLs are left alone. */
export function relativize(ref: string, fromFile: string): string {
  if (!ref.startsWith("/") || ref.startsWith("//")) return ref;
  const depth = fromFile.split("/").length - 1;
  return (depth ? "../".repeat(depth) : "./") + ref.slice(1);
}

export function normalizeHtml(html: string, file: string): string {
  return html.replace(/(\s(?:src|href|poster|action)\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/gi, (_m, a: string, q: string, u: string) => `${a}${q}${relativize(u, file)}${q}`)
    .replace(/url\(\s*(["']?)(\/(?!\/)[^"')]*)\1\s*\)/gi, (_m, q: string, u: string) => `url(${q}${relativize(u, file)}${q})`);
}
export function normalizeCss(css: string, file: string): string {
  return css.replace(/url\(\s*(["']?)(\/(?!\/)[^"')]*)\1\s*\)/gi, (_m, q: string, u: string) => `url(${q}${relativize(u, file)}${q})`)
    .replace(/@import\s+(["'])(\/(?!\/)[^"']*)\1/gi, (_m, q: string, u: string) => `@import ${q}${relativize(u, file)}${q}`);
}

/** Validates and normalizes an artifact. Throws ArtifactError with a user-readable reason. */
export function prepareArtifact(files: ArtifactFile[]): Artifact {
  if (!Array.isArray(files) || !files.length) throw new ArtifactError("Build produced no usable output.");
  if (files.length > MAX_ARTIFACT_FILES) throw new ArtifactError("Build output has too many files.");
  const seen = new Set<string>();
  let bytes = 0;
  const out = files.map((f) => {
    if (typeof f?.path !== "string" || typeof f.content !== "string" || !isSafePath(f.path)) throw new ArtifactError("Build output contains an unsafe path.");
    if (seen.has(f.path)) throw new ArtifactError(`Build output contains a duplicate file: ${f.path}`);
    seen.add(f.path);
    bytes += f.content.length;
    const ext = f.path.split(".").pop()!.toLowerCase();
    if (ext === "html" || ext === "htm") return { path: f.path, content: toB64(normalizeHtml(fromB64(f.content), f.path)) };
    if (ext === "css") return { path: f.path, content: toB64(normalizeCss(fromB64(f.content), f.path)) };
    return { path: f.path, content: f.content };
  });
  if (!seen.has("index.html")) throw new ArtifactError("Build output has no index.html.");
  if (bytes > MAX_ARTIFACT_BYTES) throw new ArtifactError("Build output is too large.");
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entry: "index.html", files: out, fileCount: out.length, bytes };
}

/** Static HTML projects: the final source files are the artifact (no GitHub build). */
export function isStaticProject(paths: string[]): boolean {
  return paths.includes("index.html") && !paths.includes("package.json");
}
