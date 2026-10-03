import { SandboxError } from "../utils/errors";
import { validatePath } from "../security/validation";
import { writeFile } from "./write";
import type { FileChange, FileStore } from "../types/filesystem";
export function createFile(store: FileStore, path: string, content = ""): FileChange {
  const p = validatePath(path);
  if (store.get(p)) throw new SandboxError("ALREADY_EXISTS", `File exists: ${p}`);
  if (store.hasFolder(p)) throw new SandboxError("ALREADY_EXISTS", `A folder exists at: ${p}`);
  return writeFile(store, p, content);
}
export function createFolder(store: FileStore, path: string): FileChange {
  const p = validatePath(path);
  if (store.hasFolder(p)) throw new SandboxError("ALREADY_EXISTS", `Folder exists: ${p}`);
  if (store.get(p)) throw new SandboxError("ALREADY_EXISTS", `A file exists at: ${p}`);
  store.addFolder(p);
  return { kind: "mkdir", path: p };
}
