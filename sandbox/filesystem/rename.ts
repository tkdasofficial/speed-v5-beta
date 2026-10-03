import { dirname, joinPath } from "../utils/paths";
import { validatePath } from "../security/validation";
import { movePath } from "./move";
import type { FileChange, FileStore } from "../types/filesystem";
/** Renames the last segment of a path, keeping it in the same folder. */
export function renamePath(store: FileStore, path: string, newName: string): FileChange[] {
  const p = validatePath(path);
  const dir = dirname(p);
  return movePath(store, p, dir ? joinPath(dir, newName) : joinPath(newName));
}
