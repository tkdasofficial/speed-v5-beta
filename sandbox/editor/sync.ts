import { writeFile } from "../filesystem/write";
import type { FileChange, FileStore } from "../types/filesystem";
import type { EditorBuffer } from "./buffer";
import type { ChangeTracker } from "./changes";
/** Writes one buffer to the filesystem. A "changed" conflict blocks unless forced. */
export function saveBuffer(store: FileStore, b: EditorBuffer, tracker: ChangeTracker, force = false): FileChange | null {
  if (b.conflict?.kind === "changed" && !force) return null;
  const c = writeFile(store, b.path, b.content);
  tracker.mark(b.path, c.kind === "create" ? "A" : "M");
  b.markSaved();
  return c;
}
/** Flushes dirty, conflict-free editor buffers into the store. */
export function syncBuffers(store: FileStore, buffers: readonly EditorBuffer[], tracker: ChangeTracker): FileChange[] {
  const out: FileChange[] = [];
  for (const b of buffers) { if (!b.dirty) continue; const c = saveBuffer(store, b, tracker); if (c) out.push(c); }
  return out;
}
/** Propagates filesystem changes into open buffers without destroying unsaved work. */
export function applyChangesToBuffers(store: FileStore, buffers: Map<string, EditorBuffer>, changes: readonly FileChange[]): void {
  for (const c of changes) {
    if (c.kind === "rename") {
      const b = buffers.get(c.from);
      if (b) { buffers.delete(c.from); b.path = c.to; buffers.set(c.to, b); }
    } else if (c.kind === "update" || c.kind === "create") {
      buffers.get(c.path)?.external(store.get(c.path)?.content ?? null);
    } else if (c.kind === "delete") {
      const b = buffers.get(c.path);
      if (b) { if (b.content === b.baseline) buffers.delete(c.path); else b.external(null); }
    }
  }
}
