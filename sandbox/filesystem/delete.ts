import { SandboxError } from "../utils/errors";
import { isWithin } from "../utils/paths";
import { validatePath } from "../security/validation";
import type { FileChange, FileStore } from "../types/filesystem";
/** Deletes a file, or a folder and everything under it. */
export function deletePath(store: FileStore, path: string): FileChange[] {
  const p = validatePath(path);
  const files = store.list().filter((f) => isWithin(f.path, p));
  const dirs = store.folders().filter((d) => isWithin(d, p)).sort((a, b) => b.length - a.length);
  if (!files.length && !dirs.length) throw new SandboxError("NOT_FOUND", `No such path: ${p}`);
  const out: FileChange[] = files.map((f) => { store.delete(f.path); return { kind: "delete", path: f.path } as const; });
  for (const d of dirs) { store.removeFolder(d); out.push({ kind: "rmdir", path: d }); }
  return out;
}
