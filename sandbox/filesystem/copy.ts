import { SandboxError } from "../utils/errors";
import { isWithin } from "../utils/paths";
import { validatePath } from "../security/validation";
import type { FileChange, FileStore } from "../types/filesystem";
/** Copies a file or folder subtree. Fails without changes if any target exists. */
export function copyPath(store: FileStore, from: string, to: string): FileChange[] {
  const a = validatePath(from), b = validatePath(to);
  if (isWithin(b, a)) throw new SandboxError("INVALID_PATH", `Cannot copy ${a} into itself`);
  const files = store.list().filter((f) => isWithin(f.path, a));
  const dirs = store.folders().filter((d) => isWithin(d, a));
  if (!files.length && !dirs.length) throw new SandboxError("NOT_FOUND", `No such path: ${a}`);
  if (store.get(b) || store.hasFolder(b)) throw new SandboxError("ALREADY_EXISTS", `Target exists: ${b}`);
  const out: FileChange[] = [];
  for (const d of dirs) { const nd = b + d.slice(a.length); store.addFolder(nd); out.push({ kind: "mkdir", path: nd }); }
  const now = Date.now();
  for (const f of files) {
    const dest = b + f.path.slice(a.length);
    store.set({ path: dest, content: f.content, encoding: f.encoding, updatedAt: now, createdAt: now });
    out.push({ kind: "create", path: dest });
  }
  return out;
}
