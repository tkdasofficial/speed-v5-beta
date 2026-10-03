// Deterministic content hashing for build inputs/outputs: entries are sorted by path, so file order never changes the hash.
export type HashFile = { path: string; content: string; encoding?: "utf8" | "base64" | undefined };

export async function hashFiles(files: HashFile[]): Promise<string> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const enc = new TextEncoder();
  const parts = sorted.map((f) => `${f.path}\u0000${f.encoding ?? "utf8"}\u0000${f.content.length}\u0000${f.content}\u0000`);
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(parts.join("")));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Safe relative path: no absolute paths, drive letters, backslashes, `..`/`.` segments or control characters. */
export function safeRelPath(p: string): boolean {
  if (!p || p.length > 400 || p.startsWith("/") || p.includes("\\") || /^[a-zA-Z]:/.test(p) || /[\u0000-\u001f]/.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

export const IGNORED = /^(node_modules|dist|build|\.git|\.vite|\.cache)(\/|$)|(^|\/)\.env(\.|$)/;
