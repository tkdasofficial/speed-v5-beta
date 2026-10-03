import type { FileEntry, FileStore } from "../types/filesystem";
import type { BufferState } from "../editor/buffer";
import type { SandboxInfo } from "../types/sandbox";
export interface SnapshotEditorState { openFiles: readonly string[]; activeFile: string | null; buffers: readonly BufferState[] }
export interface Snapshot {
  id: string; label: string; createdAt: number;
  files: readonly FileEntry[]; folders: readonly string[];
  editor: SnapshotEditorState; sandbox: SandboxInfo; workspace: Record<string, unknown>;
}
export interface SnapshotSummary { id: string; label: string; createdAt: number; fileCount: number }
export function takeSnapshot(store: FileStore, init: Omit<Snapshot, "files" | "folders" | "createdAt">): Snapshot {
  return { ...init, createdAt: Date.now(), files: store.list().map((f) => ({ ...f })), folders: store.folders() };
}
export function restoreSnapshot(store: FileStore, snap: Pick<Snapshot, "files" | "folders">): void {
  store.clear();
  for (const d of snap.folders) store.addFolder(d);
  for (const f of snap.files) store.set({ ...f });
}
export const summarize = (s: Snapshot): SnapshotSummary => ({ id: s.id, label: s.label, createdAt: s.createdAt, fileCount: s.files.length });
