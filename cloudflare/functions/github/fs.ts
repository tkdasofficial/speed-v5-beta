// Pure helpers for the GitHub repository read layer (no I/O, safe to unit test).

export type TreeEntry = { path: string; name: string; type: "file" | "dir"; size: number | null; sha: string };
export type RawTreeItem = { path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string; size?: number };

/** Largest file returned as text; bigger files return metadata only. */
export const MAX_TEXT_BYTES = 512 * 1024;

/** Normalizes a GitHub git-tree response: files and directories only (submodules dropped), dirs first. */
export function normalizeTree(items: RawTreeItem[]): TreeEntry[] {
  return items
    .filter((i) => i.type === "blob" || i.type === "tree")
    .map((i) => ({ path: i.path, name: i.path.split("/").pop() ?? i.path, type: i.type === "tree" ? ("dir" as const) : ("file" as const), size: i.type === "blob" ? (i.size ?? null) : null, sha: i.sha }))
    .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "dir" ? -1 : 1));
}

/** Validates a repository-relative path; returns null when it could escape the repo or is malformed. */
export function safeRepoPath(p: string): string | null {
  const s = p.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s || s.length > 1024 || /[\\\0\r\n]/.test(s)) return null;
  const parts = s.split("/");
  if (parts.some((x) => !x || x === "." || x === "..")) return null;
  return parts.map(encodeURIComponent).join("/");
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|avif|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|exe|dll|so|dylib|bin|wasm|class|o|a|mp[34]|mov|avi|mkv|webm|wav|ogg|flac|ttf|otf|woff2?|eot|psd|sqlite|db)$/i;

/** Decodes base64 file content as UTF-8 text, or returns null for binary data. */
export function decodeText(path: string, b64: string): string | null {
  if (BINARY_EXT.test(path)) return null;
  const bytes = Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}
