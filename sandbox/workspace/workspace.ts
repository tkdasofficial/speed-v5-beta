import type { FileEntry, FileStore } from "../types/filesystem";
import type { WorkspaceInfo } from "../types/workspace";
import { FileWatcher } from "../filesystem/watcher";
import { uid } from "../core/context";
/** In-memory file store; paths are relative to its root. Parent folders of files are implicit. */
export class MemoryFileStore implements FileStore {
  private files = new Map<string, FileEntry>();
  private dirs = new Set<string>();
  get(path: string): FileEntry | undefined { return this.files.get(path); }
  set(entry: FileEntry): void {
    const prev = this.files.get(entry.path);
    this.files.set(entry.path, { ...entry, createdAt: entry.createdAt ?? prev?.createdAt ?? entry.updatedAt });
    const segs = entry.path.split("/");
    for (let i = 1; i < segs.length; i++) this.dirs.add(segs.slice(0, i).join("/"));
  }
  delete(path: string): boolean { return this.files.delete(path); }
  list(): FileEntry[] { return [...this.files.values()]; }
  folders(): string[] { return [...this.dirs]; }
  hasFolder(path: string): boolean { return this.dirs.has(path); }
  addFolder(path: string): void { const segs = path.split("/"); for (let i = 1; i <= segs.length; i++) this.dirs.add(segs.slice(0, i).join("/")); }
  removeFolder(path: string): boolean { return this.dirs.delete(path); }
  clear(): void { this.files.clear(); this.dirs.clear(); }
}
/** The active project workspace (.local is its root — never a nested project folder). */
export class Workspace implements WorkspaceInfo {
  readonly id = uid("ws");
  readonly root = ".local" as const;
  readonly watcher = new FileWatcher();
  constructor(readonly projectId: string, readonly files: FileStore = new MemoryFileStore()) {}
}
