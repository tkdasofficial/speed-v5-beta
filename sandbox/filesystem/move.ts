import { SandboxError } from "../utils/errors";
import { isWithin } from "../utils/paths";
import { validatePath } from "../security/validation";
import type { FileChange, FileStore } from "../types/filesystem";
/** Moves a file or folder subtree to a new path. Validates every target before changing anything. */
export function movePath(store: FileStore, from: string, to: string): FileChange[] {
  const a = validatePath(from), b = validatePath(to);
  if (a === b) return [];
  if (isWithin(b, a)) throw new SandboxError("INVALID_PATH", `Cannot move ${a} into itself`);
  const files = store.list().filter((f) => isWithin(f.path, a));
  const dirs = store.folders().filter((d) => isWithin(d, a));
  if (!files.length && !dirs.length) throw new SandboxError("NOT_FOUND", `No such path: ${a}`);
  if (store.get(b) || store.hasFolder(b)) throw new SandboxError("ALREADY_EXISTS", `Target exists: ${b}`);
  for (const f of files) validatePath(b + f.path.slice(a.length));
  const out: FileChange[] = [];
  for (const d of dirs.sort((x, y) => y.length - x.length)) { store.removeFolder(d); out.push({ kind: "rmdir", path: d }); }
  for (const d of dirs.sort((x, y) => x.length - y.length)) { const nd = b + d.slice(a.length); store.addFolder(nd); out.push({ kind: "mkdir", path: nd }); }
  for (const f of files) {
    const dest = b + f.path.slice(a.length);
    store.delete(f.path);
    store.set({ ...f, path: dest, updatedAt: Date.now() });
    out.push({ kind: "rename", from: f.path, to: dest });
  }
  return out;
}
