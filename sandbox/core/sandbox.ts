import type { SandboxInfo, SandboxPhase } from "../types/sandbox";
import type { FileChange, FileEntry, FileMeta, TreeNode } from "../types/filesystem";
import { EventBus } from "../bridge/events";
import { handleRequest } from "../bridge/api";
import type { SandboxRequest, SandboxResponse } from "../bridge/messages";
import { Terminal } from "../terminal/terminal";
import { ProcessManager } from "../processes/manager";
import { MemoryFileStore, Workspace } from "../workspace/workspace";
import { WorkspaceSession } from "../workspace/session";
import { requirePermission } from "../security/validation";
import { readFile } from "../filesystem/read";
import { writeFile } from "../filesystem/write";
import { createFile, createFolder } from "../filesystem/create";
import { deletePath } from "../filesystem/delete";
import { movePath } from "../filesystem/move";
import { renamePath } from "../filesystem/rename";
import { copyPath } from "../filesystem/copy";
import { buildTree, fileMeta } from "../filesystem/tree";
import { applyChangesToBuffers, saveBuffer } from "../editor/sync";
import type { EditorBuffer } from "../editor/buffer";
import { takeSnapshot, restoreSnapshot } from "../storage/snapshot";
import type { SnapshotSummary } from "../storage/snapshot";
import { SandboxPersistence, browserBackend } from "../storage/persistence";
import type { KeyValueBackend } from "../storage/persistence";
import { parseState, serializeState } from "../storage/state";
import type { PersistedSandboxState } from "../storage/state";
import { generateStaticOutput, renderOutputPage, writeOutput } from "../project/output";
import { findPage } from "../project/runner";
import { validateProject, validateReferences } from "../intelligence/validate";
import type { OutputRecord, OutputResult } from "../project/output";
import { SandboxError } from "../utils/errors";
import type { SandboxContext } from "./context";
import { uid } from "./context";
import { assertTransition } from "./lifecycle";
import { initialState, withPhase } from "./state";

/** The sandbox engine root: owns .local (workspace), .output, editor session, snapshots and events. */
export class Sandbox {
  private info: SandboxInfo;
  readonly events = new EventBus();
  readonly workspace: Workspace;
  readonly output = new MemoryFileStore();
  readonly session: WorkspaceSession;
  readonly terminal: Terminal;
  readonly processes = new ProcessManager();
  readonly persistence: SandboxPersistence;
  private outputRecord: OutputRecord | null = null;
  private localChangedAt = 0;
  private outputRev = 0;

  constructor(readonly ctx: SandboxContext, kv: KeyValueBackend = browserBackend()) {
    this.info = initialState(ctx.projectId);
    this.workspace = new Workspace(ctx.projectId);
    this.session = new WorkspaceSession(this.workspace, ctx.userId);
    this.terminal = new Terminal(ctx.commandPolicy);
    this.persistence = new SandboxPersistence(kv, ctx.projectId);
    this.workspace.watcher.subscribe((changes) => {
      const renames = new Map<string, string>();
      for (const c of changes) if (c.kind === "rename") renames.set(c.from, c.to);
      applyChangesToBuffers(this.workspace.files, this.session.buffers, changes);
      this.session.reconcile(renames);
      this.events.emit({ type: "fs.changed", changes });
    });
  }

  get state(): SandboxInfo { return this.info; }
  private go(to: SandboxPhase): void { assertTransition(this.info.phase, to); this.info = withPhase(this.info, to); this.events.emit({ type: "phase", phase: to }); }

  /** Initializes the sandbox, restoring persisted state for this project when present. */
  start(workspaceRestore?: (w: Record<string, unknown>) => void): void {
    this.go("initializing");
    try {
      const saved = parseState(this.persistence.loadState());
      if (saved) {
        this.applyState(saved);
        workspaceRestore?.(saved.workspace);
      }
      this.go("ready");
    } catch (e) {
      this.go("error");
      throw e;
    }
  }
  suspend(): void { this.go("suspended"); }
  resume(): void { this.go("ready"); }
  dispose(): void { this.go("disposing"); this.session.end(); this.go("disposed"); }

  private assertReady(write: boolean): void {
    if (this.info.phase !== "ready") throw new SandboxError("INVALID_STATE", `Sandbox is ${this.info.phase}`);
    requirePermission(this.ctx.permissions, write ? "fs:write" : "fs:read");
  }
  private commit(changes: FileChange[]): FileChange[] {
    this.localChangedAt++;
    this.info = { ...this.info, updatedAt: Date.now() };
    this.workspace.watcher.emit(changes);
    return changes;
  }

  // ---- filesystem (.local) ----
  tree(): TreeNode[] { this.assertReady(false); return buildTree(this.workspace.files); }
  read(path: string): FileEntry { this.assertReady(false); return readFile(this.workspace.files, path); }
  meta(path: string): FileMeta | undefined { this.assertReady(false); return fileMeta(this.workspace.files, path); }
  /** Mirrors the authoritative server codebase into .local: emits per-path changes so editor buffers reconcile. */
  replaceLocal(files: readonly FileEntry[], folders: readonly string[]): FileChange[] {
    this.assertReady(false);
    const st = this.workspace.files;
    const changes: FileChange[] = [];
    const next = new Map(files.map((f) => [f.path, f]));
    for (const f of st.list()) if (!next.has(f.path)) { st.delete(f.path); changes.push({ kind: "delete", path: f.path }); }
    for (const d of st.folders()) if (!folders.includes(d) && !files.some((f) => f.path.startsWith(`${d}/`))) { st.removeFolder(d); changes.push({ kind: "rmdir", path: d }); }
    for (const d of folders) if (!st.hasFolder(d)) { st.addFolder(d); changes.push({ kind: "mkdir", path: d }); }
    for (const f of files) {
      const cur = st.get(f.path);
      if (!cur) { st.set({ ...f }); changes.push({ kind: "create", path: f.path }); }
      else if (cur.content !== f.content || cur.encoding !== f.encoding) { st.set({ ...f }); changes.push({ kind: "update", path: f.path }); }
    }
    return changes.length ? this.commit(changes) : [];
  }
  isFolder(path: string): boolean { return this.workspace.files.hasFolder(path); }
  write(path: string, content: string): FileChange[] { this.assertReady(true); return this.commit([writeFile(this.workspace.files, path, content)]); }
  createFile(path: string, content = ""): FileChange[] { this.assertReady(true); return this.commit([createFile(this.workspace.files, path, content)]); }
  createFolder(path: string): FileChange[] { this.assertReady(true); return this.commit([createFolder(this.workspace.files, path)]); }
  remove(path: string): FileChange[] { this.assertReady(true); return this.commit(deletePath(this.workspace.files, path)); }
  move(from: string, to: string): FileChange[] { this.assertReady(true); return this.commit(movePath(this.workspace.files, from, to)); }
  rename(path: string, name: string): FileChange[] {
    this.assertReady(true);
    if (!name || name.includes("/")) throw new SandboxError("INVALID_PATH", "A name cannot be empty or contain /");
    return this.commit(renamePath(this.workspace.files, path, name));
  }
  copy(from: string, to: string): FileChange[] { this.assertReady(true); return this.commit(copyPath(this.workspace.files, from, to)); }

  // ---- editor ----
  openFile(path: string): EditorBuffer { this.assertReady(false); return this.session.open(path); }
  editBuffer(path: string, content: string, selection?: { start: number; end: number }): void {
    const b = this.session.get(path); if (!b) throw new SandboxError("NOT_FOUND", `File is not open: ${path}`);
    b.update(content); if (selection) b.selection = selection;
  }
  /** Buffer → filesystem. Returns null when blocked by an unresolved conflict. */
  saveFile(path: string, force = false): FileChange[] | null {
    this.assertReady(true);
    const b = this.session.get(path); if (!b) throw new SandboxError("NOT_FOUND", `File is not open: ${path}`);
    const c = saveBuffer(this.workspace.files, b, this.session.changes, force);
    return c ? this.commit([c]) : null;
  }
  discardFile(path: string): void { const b = this.session.get(path); if (!b) return; if (b.conflict?.kind === "deleted") this.session.close(path); else { b.revert(); b.acceptDisk(); } }
  acceptDisk(path: string): void { this.session.get(path)?.acceptDisk(); }
  closeFile(path: string): void { this.session.close(path); }
  setActive(path: string | null): void { if (path === null || this.session.buffers.has(path)) this.session.active = path; }

  // ---- output / preview (.output) ----
  get lastOutput(): OutputRecord | null { return this.outputRecord; }
  /**
   * Transactional build: validate .local → stage output in a temporary store → verify it → swap into .output.
   * Any failure discards the staged output; the last good .output stays untouched.
   */
  generateOutput(): OutputResult {
    this.assertReady(true);
    const v = validateProject(this.workspace.files);
    let r: OutputResult;
    if (v.errors.length) r = { ok: false, error: `${v.errors.length} error(s): ${v.errors.slice(0, 3).map((e) => `${e.file}:${e.line} ${e.message}`).join("; ")}`, diagnostics: v.errors, warnings: v.warnings };
    else {
      const built = generateStaticOutput(this.workspace.files, uid("out"));
      if (!built.ok) r = built;
      else {
        const staged = new MemoryFileStore();
        writeOutput(staged, built.record);
        const broken = validateReferences(staged).filter((d) => d.severity === "error");
        r = broken.length ? { ok: false, error: `Output check failed: ${broken[0]!.message}`, diagnostics: broken, warnings: v.warnings } : { ...built, warnings: v.warnings };
      }
    }
    if (r.ok) { writeOutput(this.output, r.record); this.outputRecord = r.record; this.outputRev = this.localChangedAt; this.events.emit({ type: "output.ready", id: r.record.id }); }
    else this.events.emit({ type: "output.failed", error: r.error });
    return r;
  }
  outputPages(): string[] { return this.output.list().filter((f) => /\.html?$/i.test(f.path)).map((f) => f.path).sort(); }
  renderPage(page: string): string | null { return renderOutputPage(this.output, page); }
  /** Resolves a link target inside .output to a page path, or null. */
  resolvePage(path: string): string | null { return findPage(this.output, path); }
  /** True when .local has changed after the current output was generated. */
  outputStale(): boolean {
    if (!this.outputRecord) return false;
    return this.localChangedAt > this.outputRev;
  }

  // ---- snapshots ----
  createSnapshot(label: string, workspace: Record<string, unknown>): SnapshotSummary {
    this.assertReady(false);
    const s = takeSnapshot(this.workspace.files, { id: uid("snap"), label, editor: this.session.toState(), sandbox: this.info, workspace });
    this.persistence.saveSnapshot(s);
    return { id: s.id, label: s.label, createdAt: s.createdAt, fileCount: s.files.length };
  }
  listSnapshots(): SnapshotSummary[] { return this.persistence.listSnapshots(); }
  restoreSnapshot(id: string): Record<string, unknown> {
    this.assertReady(true);
    const s = this.persistence.loadSnapshot(id);
    if (!s) throw new SandboxError("NOT_FOUND", "Snapshot not found");
    const before = this.workspace.files.list().map((f) => f.path);
    restoreSnapshot(this.workspace.files, s);
    this.session.restore(s.editor);
    const changes: FileChange[] = [...before.filter((p) => !this.workspace.files.get(p)).map((path) => ({ kind: "delete", path }) as const), ...s.files.map((f) => ({ kind: "update", path: f.path }) as const)];
    this.commit(changes);
    return s.workspace;
  }
  deleteSnapshot(id: string): boolean { return this.persistence.deleteSnapshot(id); }

  // ---- persistence ----
  serialize(workspace: Record<string, unknown>): PersistedSandboxState {
    return { version: 2, sandbox: this.info, local: { files: this.workspace.files.list(), folders: this.workspace.files.folders() }, output: this.outputRecord, editor: this.session.toState(), workspace, localChangedAt: this.localChangedAt, outputRev: this.outputRev };
  }
  save(workspace: Record<string, unknown>): void { this.persistence.saveState(serializeState(this.serialize(workspace))); }
  private applyState(s: PersistedSandboxState): void {
    restoreSnapshot(this.workspace.files, s.local);
    if (s.output) { writeOutput(this.output, s.output); this.outputRecord = s.output; }
    this.session.restore(s.editor);
    this.localChangedAt = s.localChangedAt;
    this.outputRev = s.outputRev;
    this.info = { ...this.info, id: s.sandbox.id, createdAt: s.sandbox.createdAt, updatedAt: s.sandbox.updatedAt };
  }

  /** Typed request entry point for bridge callers. */
  request(req: SandboxRequest): SandboxResponse {
    if (this.info.phase !== "ready") return { ok: false, code: "INVALID_STATE", message: `Sandbox is ${this.info.phase}` };
    try {
      if (req.type === "terminal.run") requirePermission(this.ctx.permissions, "terminal:run");
      else if (req.type === "fs.write" || req.type === "fs.delete" || req.type === "fs.move") requirePermission(this.ctx.permissions, "fs:write");
      else requirePermission(this.ctx.permissions, "fs:read");
    } catch (e) { return { ok: false, code: "FORBIDDEN", message: e instanceof Error ? e.message : "Forbidden" }; }
    return handleRequest(this.workspace, this.terminal, req);
  }
}
