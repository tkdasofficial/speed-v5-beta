import { SandboxError } from "../utils/errors";
import { validatePath } from "../security/validation";
import type { FileEntry, FileStore } from "../types/filesystem";
export function readFile(store: FileStore, path: string): FileEntry {
  const p = validatePath(path);
  const f = store.get(p);
  if (!f) throw new SandboxError("NOT_FOUND", `No such file: ${p}`);
  return f;
}
export const exists = (store: FileStore, path: string): boolean => store.get(validatePath(path)) !== undefined;
