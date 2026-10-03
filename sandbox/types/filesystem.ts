// Shared filesystem types. Paths are POSIX, relative to a sandbox root (.local or .output).
export type WorkspacePath = string;
export type FileEncoding = "utf8" | "base64";
export interface FileEntry { path: WorkspacePath; content: string; encoding: FileEncoding; updatedAt: number; createdAt?: number }
export interface FileMeta { path: WorkspacePath; size: number; encoding: FileEncoding; updatedAt: number; createdAt: number; language: string }
export interface TreeNode { name: string; path: WorkspacePath; type: "file" | "folder"; children?: TreeNode[] }
export type FileChange =
  | { kind: "create"; path: WorkspacePath }
  | { kind: "update"; path: WorkspacePath }
  | { kind: "delete"; path: WorkspacePath }
  | { kind: "rename"; from: WorkspacePath; to: WorkspacePath }
  | { kind: "mkdir"; path: WorkspacePath }
  | { kind: "rmdir"; path: WorkspacePath };
/** Flat store of files plus explicit folders (so empty folders exist). */
export interface FileStore {
  get(path: WorkspacePath): FileEntry | undefined;
  set(entry: FileEntry): void;
  delete(path: WorkspacePath): boolean;
  list(): FileEntry[];
  folders(): WorkspacePath[];
  hasFolder(path: WorkspacePath): boolean;
  addFolder(path: WorkspacePath): void;
  removeFolder(path: WorkspacePath): boolean;
  clear(): void;
}
