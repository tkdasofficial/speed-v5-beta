import type { WorkspacePath } from "../types/filesystem";
export type ChangeMark = "A" | "M" | "D";
/** Tracks which paths changed since the last checkpoint. */
export class ChangeTracker {
  private marks = new Map<WorkspacePath, ChangeMark>();
  mark(path: WorkspacePath, m: ChangeMark): void {
    const prev = this.marks.get(path);
    if (prev === "A" && m === "D") this.marks.delete(path);
    else this.marks.set(path, prev === "A" && m === "M" ? "A" : m);
  }
  list(): { path: WorkspacePath; change: ChangeMark }[] { return [...this.marks].map(([path, change]) => ({ path, change })); }
  clear(): void { this.marks.clear(); }
}
