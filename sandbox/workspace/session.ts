import type { WorkspaceSessionInfo } from "../types/workspace";
import { uid } from "../core/context";
import { EditorBuffer } from "../editor/buffer";
import type { BufferState } from "../editor/buffer";
import { ChangeTracker } from "../editor/changes";
import { readFile } from "../filesystem/read";
import type { Workspace } from "./workspace";
/** A user's editing session: ordered open buffers, the active file and tracked changes. */
export class WorkspaceSession {
  readonly info: WorkspaceSessionInfo;
  readonly changes = new ChangeTracker();
  readonly buffers = new Map<string, EditorBuffer>();
  order: string[] = [];
  active: string | null = null;
  constructor(readonly workspace: Workspace, userId: string) { this.info = { id: uid("wss"), workspaceId: workspace.id, userId, openedAt: Date.now() }; }
  open(path: string): EditorBuffer {
    const existing = this.buffers.get(path);
    const b = existing ?? (() => { const f = readFile(this.workspace.files, path); return new EditorBuffer(f.path, f.content); })();
    this.buffers.set(b.path, b);
    if (!this.order.includes(b.path)) this.order.push(b.path);
    this.active = b.path;
    return b;
  }
  get(path: string): EditorBuffer | undefined { return this.buffers.get(path); }
  close(path: string): void {
    this.buffers.delete(path);
    const i = this.order.indexOf(path);
    this.order = this.order.filter((p) => p !== path);
    if (this.active === path) this.active = this.order[Math.min(i, this.order.length - 1)] ?? null;
  }
  /** Keeps order/active consistent after buffers were renamed or dropped by filesystem sync. */
  reconcile(renames: ReadonlyMap<string, string>): void {
    this.order = this.order.map((p) => renames.get(p) ?? p).filter((p) => this.buffers.has(p));
    if (this.active) this.active = renames.get(this.active) ?? this.active;
    if (this.active && !this.buffers.has(this.active)) this.active = this.order[0] ?? null;
  }
  openBuffers(): EditorBuffer[] { return this.order.map((p) => this.buffers.get(p)).filter((b): b is EditorBuffer => !!b); }
  toState(): { openFiles: string[]; activeFile: string | null; buffers: BufferState[] } {
    return { openFiles: [...this.order], activeFile: this.active, buffers: this.openBuffers().map((b) => b.toState()) };
  }
  restore(s: { openFiles: readonly string[]; activeFile: string | null; buffers: readonly BufferState[] }): void {
    this.buffers.clear();
    for (const b of s.buffers) this.buffers.set(b.path, EditorBuffer.from(b));
    this.order = s.openFiles.filter((p) => this.buffers.has(p));
    this.active = s.activeFile && this.buffers.has(s.activeFile) ? s.activeFile : this.order[0] ?? null;
  }
  end(): void { this.info.closedAt = Date.now(); this.buffers.clear(); this.order = []; this.active = null; }
}
