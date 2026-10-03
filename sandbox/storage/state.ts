import type { SandboxInfo } from "../types/sandbox";
import type { FileEntry } from "../types/filesystem";
import type { BufferState } from "../editor/buffer";
import type { OutputRecord } from "../project/output";
/** Serializable sandbox state for resuming a project. */
export interface PersistedSandboxState {
  version: 2;
  sandbox: SandboxInfo;
  local: { files: FileEntry[]; folders: string[] };
  output: OutputRecord | null;
  editor: { openFiles: string[]; activeFile: string | null; buffers: BufferState[] };
  workspace: Record<string, unknown>;
  /** Revision counter of .local changes, and the revision the current output was built from. */
  localChangedAt: number;
  outputRev: number;
}
export const serializeState = (s: PersistedSandboxState): string => JSON.stringify(s);
export function parseState(raw: string | null): PersistedSandboxState | null {
  if (!raw) return null;
  try { const v = JSON.parse(raw) as Partial<PersistedSandboxState>; return v.version === 2 && v.sandbox && v.local ? (v as PersistedSandboxState) : null; } catch { return null; }
}
