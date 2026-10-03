import { SandboxError } from "../utils/errors";
import { validatePath } from "../security/validation";
import type { FileChange, FileEncoding, FileStore } from "../types/filesystem";
/** Writes (creates or overwrites) a file and returns the resulting change. */
export function writeFile(store: FileStore, path: string, content: string, encoding: FileEncoding = "utf8"): FileChange {
  const p = validatePath(path);
  if (store.hasFolder(p)) throw new SandboxError("ALREADY_EXISTS", `A folder exists at: ${p}`);
  const segs = p.split("/");
  for (let i = 1; i < segs.length; i++) if (store.get(segs.slice(0, i).join("/"))) throw new SandboxError("INVALID_PATH", `${segs.slice(0, i).join("/")} is a file, not a folder`);
  const existed = store.get(p) !== undefined;
  store.set({ path: p, content, encoding, updatedAt: Date.now() });
  return { kind: existed ? "update" : "create", path: p };
}
