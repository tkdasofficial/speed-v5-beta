import type { FileChange } from "../types/filesystem";
export type ChangeListener = (changes: readonly FileChange[]) => void;
/** In-process change notifier; filesystem operations report their changes here. */
export class FileWatcher {
  private listeners = new Set<ChangeListener>();
  subscribe(fn: ChangeListener): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(changes: readonly FileChange[]): void { if (changes.length) for (const fn of this.listeners) fn(changes); }
}
