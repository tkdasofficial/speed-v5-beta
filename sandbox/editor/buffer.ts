import type { WorkspacePath } from "../types/filesystem";
const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", css: "css", scss: "scss", html: "html", htm: "html", md: "markdown", mdx: "markdown",
  py: "python", sql: "sql", yml: "yaml", yaml: "yaml", toml: "toml", svg: "xml", xml: "xml", sh: "shell", txt: "plaintext",
};
export const languageFor = (path: string): string => LANG[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
export type BufferConflict = { kind: "changed"; diskContent: string } | { kind: "deleted" };
export interface Selection { start: number; end: number }
export interface BufferState { path: WorkspacePath; content: string; saved: string; selection: Selection; conflict: BufferConflict | null }
/** An open editor buffer tracking unsaved content against the saved (filesystem) baseline. */
export class EditorBuffer {
  private current: string;
  selection: Selection = { start: 0, end: 0 };
  conflict: BufferConflict | null = null;
  constructor(public path: WorkspacePath, private saved: string) { this.current = saved; }
  get content(): string { return this.current; }
  get baseline(): string { return this.saved; }
  get dirty(): boolean { return this.current !== this.saved || this.conflict?.kind === "deleted"; }
  get language(): string { return languageFor(this.path); }
  update(next: string): void { this.current = next; }
  markSaved(): void { this.saved = this.current; this.conflict = null; }
  revert(): void { this.current = this.saved; }
  /** Applies a filesystem change: reloads when clean, records a conflict when dirty. */
  external(diskContent: string | null): void {
    if (diskContent === null) { this.conflict = { kind: "deleted" }; return; }
    if (diskContent === this.saved) return;
    if (this.current === this.saved && !this.conflict) { this.saved = diskContent; this.current = diskContent; return; }
    this.conflict = { kind: "changed", diskContent };
  }
  acceptDisk(): void {
    if (this.conflict?.kind === "changed") { this.saved = this.conflict.diskContent; this.current = this.saved; }
    this.conflict = null;
  }
  toState(): BufferState { return { path: this.path, content: this.current, saved: this.saved, selection: this.selection, conflict: this.conflict }; }
  static from(s: BufferState): EditorBuffer { const b = new EditorBuffer(s.path, s.saved); b.current = s.content; b.selection = s.selection; b.conflict = s.conflict; return b; }
}
