// Shared, pure project-file normalization used by every import source (GitHub, GitLab,
// Bitbucket, ZIP, directory) in both the browser preview and the Worker. No I/O.

export type ImportSource = "github" | "gitlab" | "bitbucket" | "zip" | "directory";
export type FileKind = "text" | "binary" | "too_large";
/** One normalized project file. `content` is UTF-8 text, base64 for small binaries, or null. */
export type ProjectFile = { path: string; name: string; type: "file"; size: number; kind: FileKind; content: string | null; source: ImportSource };
export type Skipped = { path: string; reason: string };
export type ProjectTree = { files: ProjectFile[]; dirs: string[]; skipped: Skipped[]; totalBytes: number };

export const LIMITS = {
  maxFiles: 3000,
  maxTextBytes: 512 * 1024,
  maxBinaryBytes: 256 * 1024,
  maxStoredBytes: 40 * 1024 * 1024,
  maxArchiveBytes: 50 * 1024 * 1024,
};

const IGNORED = new Set([".git", "node_modules", "__MACOSX", ".DS_Store", "Thumbs.db"]);

/** Returns a clean relative path, or null when it is absolute, escapes the root or is malformed. */
export function cleanPath(raw: string): string | null {
  if (!raw || raw.length > 1024 || /[\\\0\r\n]/.test(raw)) return null;
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) return null;
  const s = raw.replace(/\/+$/, "");
  if (!s) return null;
  const parts = s.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return null;
  return parts.join("/");
}

const isIgnored = (path: string) => path.split("/").some((p) => IGNORED.has(p));

/** Removes a single shared top-level folder (archives from GitHub/GitLab/Bitbucket and folder picks have one). */
export function stripCommonRoot(paths: string[]): string {
  if (!paths.length) return "";
  const first = paths[0]!.split("/")[0]!;
  return paths.every((p) => p.includes("/") && p.split("/")[0] === first) ? `${first}/` : "";
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|avif|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|exe|dll|so|dylib|bin|wasm|class|o|a|mp[34]|mov|avi|mkv|webm|wav|ogg|flac|ttf|otf|woff2?|eot|psd|sqlite|db)$/i;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Classifies file bytes into the stored representation. */
export function classify(path: string, bytes: Uint8Array): { kind: FileKind; content: string | null } {
  let text: string | null = null;
  if (!BINARY_EXT.test(path) && !bytes.subarray(0, 8000).includes(0)) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { text = null; }
  }
  if (text !== null) return bytes.length > LIMITS.maxTextBytes ? { kind: "too_large", content: null } : { kind: "text", content: text };
  return bytes.length > LIMITS.maxBinaryBytes ? { kind: "too_large", content: null } : { kind: "binary", content: toBase64(bytes) };
}

/** Builds the normalized tree from raw entries (paths relative to the archive/folder root). */
export function buildTree(entries: { path: string; bytes: Uint8Array }[], source: ImportSource): ProjectTree {
  const skipped: Skipped[] = [];
  const valid: { path: string; bytes: Uint8Array }[] = [];
  for (const e of entries) {
    const p = cleanPath(e.path);
    if (!p) { skipped.push({ path: e.path, reason: "Unsafe or invalid path" }); continue; }
    valid.push({ path: p, bytes: e.bytes });
  }
  const root = stripCommonRoot(valid.map((v) => v.path));
  const seen = new Map<string, ProjectFile>();
  let stored = 0;
  let totalBytes = 0;
  for (const v of valid) {
    const path = root ? v.path.slice(root.length) : v.path;
    if (!path || isIgnored(path)) continue;
    if (seen.has(path)) { skipped.push({ path, reason: "Duplicate path" }); continue; }
    if (seen.size >= LIMITS.maxFiles) { skipped.push({ path, reason: `Over the ${LIMITS.maxFiles}-file limit` }); continue; }
    let { kind, content } = classify(path, v.bytes);
    if (content && stored + content.length > LIMITS.maxStoredBytes) { kind = "too_large"; content = null; }
    stored += content?.length ?? 0;
    totalBytes += v.bytes.length;
    seen.set(path, { path, name: path.split("/").pop()!, type: "file", size: v.bytes.length, kind, content, source });
  }
  // A path cannot be both a file and a folder.
  const dirs = new Set<string>();
  for (const p of seen.keys()) { const parts = p.split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/")); }
  for (const d of dirs) if (seen.has(d)) { seen.delete(d); skipped.push({ path: d, reason: "Conflicts with a folder of the same name" }); }
  const files = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { files, dirs: [...dirs].sort(), skipped, totalBytes };
}
