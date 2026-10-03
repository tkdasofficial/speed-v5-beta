import type { FileEntry, FileStore } from "../types/filesystem";
import { SandboxError } from "../utils/errors";
import { validatePath } from "../security/validation";
/** Loads source files into an empty workspace. Files land directly at the .local root. */
export function initializeProject(store: FileStore, files: readonly Omit<FileEntry, "updatedAt">[]): number {
  if (store.list().length) throw new SandboxError("INVALID_STATE", "Workspace is not empty");
  const now = Date.now();
  for (const f of files) store.set({ ...f, path: validatePath(f.path), updatedAt: now });
  return files.length;
}
