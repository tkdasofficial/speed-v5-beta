import { AgentTools } from "@sandbox/intelligence/tools";
import type { BuildOutcome } from "@sandbox/intelligence/tools";
import { parseErrorMessage } from "@sandbox/intelligence/errors";

// The single source of truth for the active project Workspace. It owns the one Sandbox instance.
import { useEffect, useSyncExternalStore } from "react";
import { attachServer } from "./server-sync";
import { Sandbox } from "@sandbox/core/sandbox";
import { createContext, uid } from "@sandbox/core/context";
import { SandboxPersistence, browserBackend } from "@sandbox/storage/persistence";
import type { SnapshotSummary } from "@sandbox/storage/snapshot";
import type { BufferConflict, Selection } from "@sandbox/editor/buffer";
import type { FileChange, TreeNode } from "@sandbox/types/filesystem";
import type { SandboxPhase } from "@sandbox/types/sandbox";

export type ActionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type WorkspaceActionType =
  | "file.create" | "folder.create" | "file.save" | "path.delete" | "path.rename" | "path.move" | "path.copy"
  | "snapshot.create" | "snapshot.restore" | "snapshot.delete" | "output.generate" | "prompt" | "agent";
export interface WorkspaceAction {
  id: string; type: WorkspaceActionType; description: string; status: ActionStatus;
  createdAt: number; finishedAt?: number; path?: string; changes?: string[]; error?: string;
  /** Agent loop round this action belongs to; groups actions between AI messages. */
  round?: string; agentKind?: string; note?: string; fixed?: boolean;
}
/** One agent run: a user prompt worked through several message → actions rounds. */
export type AgentPlan = { title: string; summary: string; create: string[]; modify: string[]; pages: string[]; design: string[]; functional: string[]; validation: string[] };
export interface AgentRun { id: string; prompt: string; startedAt: number; endedAt?: number; status: "running" | "done" | "failed" | "stopped" | "denied"; snapshotId?: string; /** Server workflow phase (thinking, planning, awaiting_approval, building, validating, testing, …). */ phase?: string | undefined; /** Latest plan the agent proposed, with its version. */ plan?: AgentPlan | undefined; planVersion?: number | undefined; planApproved?: boolean | undefined; /** True once the run actually changed a file; runs without it show no checkpoint. */ mutated?: boolean; messages: { id: string; at: number }[]; error?: string; /** Latest persisted server step label while running. */ step?: string | undefined }
export type PreviewStatus = "empty" | "loading" | "ready" | "error";
export interface PreviewState { status: PreviewStatus; page: string; outputId: string | null; outputAt: number | null; stale: boolean; error: string | null; reloadKey: number }
export type WorkspaceStatus = "initializing" | "ready" | "idle" | "working" | "saving" | "syncing" | "previewing" | "error";
export interface OpenFileView { path: string; dirty: boolean; conflict: BufferConflict | null; language: string }
export interface ActiveBufferView extends OpenFileView { content: string; selection: Selection }
export interface WorkspaceView {
  projectId: string; phase: SandboxPhase; status: WorkspaceStatus; error: { message: string; at: number } | null;
  tree: TreeNode[]; expanded: string[]; selected: string | null;
  openFiles: OpenFileView[]; active: ActiveBufferView | null; dirtyCount: number;
  actions: WorkspaceAction[]; snapshots: SnapshotSummary[]; preview: PreviewState; previewPages: string[];
  savedAt: number | null; runs: AgentRun[];
}
interface PersistedWorkspace { expanded: string[]; selected: string | null; actions: WorkspaceAction[]; previewPage: string; previewError: string | null; runs?: AgentRun[] }

const MAX_ACTIONS = 300;
const describe = (c: FileChange): string => (c.kind === "rename" ? `${c.from} → ${c.to}` : `${c.kind} ${c.path}`);

/** User file operations mirrored to the server codebase (the source of truth). */
export type RemoteOp =
  | { op: "write"; path: string; content: string } | { op: "create"; path: string; content?: string }
  | { op: "mkdir"; path: string } | { op: "delete"; path: string } | { op: "move"; from: string; to: string } | { op: "copy"; from: string; to: string };

export class WorkspaceStore {
  readonly sandbox: Sandbox;
  /** Set by the server sync layer; every successful user file operation is sent through it. */
  remote: ((op: RemoteOp) => void) | null = null;
  private listeners = new Set<() => void>();
  private view: WorkspaceView;
  private expanded = new Set<string>();
  private selected: string | null = null;
  private actions: WorkspaceAction[] = [];
  private runs: AgentRun[] = [];
  private error: { message: string; at: number } | null = null;
  private previewPage = "index.html";
  private previewLoading = false;
  private previewError: string | null = null;
  private previewReload = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savedAt: number | null = null;
  private initError: string | null = null;
  private offEvents: () => void;

  constructor(readonly projectId: string, userId: string) {
    this.sandbox = new Sandbox(createContext(projectId, userId));
    this.offEvents = this.sandbox.events.on((e) => { if (e.type === "fs.changed") this.changed(); });
    this.view = this.compute();
    try {
      this.sandbox.start((w) => this.restore(w as Partial<PersistedWorkspace>));
    } catch (e) {
      this.initError = e instanceof Error ? e.message : "The sandbox failed to start";
      this.error = { message: this.initError, at: Date.now() };
    }
    this.view = this.compute();
  }

  private restore(w: Partial<PersistedWorkspace>): void {
    this.expanded = new Set(w.expanded ?? []);
    this.selected = w.selected ?? null;
    this.previewPage = w.previewPage ?? "index.html";
    this.previewError = w.previewError ?? null;
    this.runs = (w.runs ?? []).map((r) => (r.status === "running" && r.snapshotId?.startsWith("rev:") ? r : r.status === "running" ? { ...r, status: "stopped", endedAt: r.endedAt ?? Date.now(), error: "Interrupted — the workspace was closed before it finished." } : r));
    // Actions that were still running when the workspace closed did not finish; say so.
    this.actions = (w.actions ?? []).map((a) => (a.status === "running" || a.status === "queued"
      ? { ...a, status: "cancelled", finishedAt: a.finishedAt ?? Date.now(), error: "Interrupted — the workspace was closed before it finished." }
      : a));
  }

  // ---- subscription ----
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getView = (): WorkspaceView => this.view;
  private emit(): void { this.view = this.compute(); for (const fn of this.listeners) fn(); }
  private changed(): void { this.schedulePersist(); this.emit(); }

  private compute(): WorkspaceView {
    const sb = this.sandbox;
    const ready = sb.state.phase === "ready";
    const buffers = sb.session.openBuffers();
    const openFiles = buffers.map((b) => ({ path: b.path, dirty: b.dirty, conflict: b.conflict, language: b.language }));
    const a = sb.session.active ? sb.session.get(sb.session.active) : undefined;
    const rec = sb.lastOutput;
    const preview: PreviewState = {
      status: rec ? (this.previewLoading ? "loading" : "ready") : this.previewLoading ? "loading" : this.previewError ? "error" : "empty",
      page: this.previewPage, outputId: rec?.id ?? null, outputAt: rec?.createdAt ?? null,
      stale: rec ? sb.outputStale() : false, error: this.previewError, reloadKey: this.previewReload,
    };
    const running = this.actions.filter((x) => x.status === "running" || x.status === "queued");
    const status: WorkspaceStatus =
      sb.state.phase === "idle" || sb.state.phase === "initializing" ? "initializing"
      : this.error || sb.state.phase === "error" ? "error"
      : running.some((x) => x.type === "file.save") ? "saving"
      : running.length ? "working"
      : this.previewLoading ? "previewing"
      : this.saveTimer ? "syncing"
      : openFiles.some((f) => f.dirty) ? "ready" : "idle";
    return {
      projectId: this.projectId, phase: sb.state.phase, status, error: this.error,
      tree: ready ? sb.tree() : [], expanded: [...this.expanded], selected: this.selected,
      openFiles, active: a ? { path: a.path, dirty: a.dirty, conflict: a.conflict, language: a.language, content: a.content, selection: a.selection } : null,
      dirtyCount: openFiles.filter((f) => f.dirty).length,
      actions: this.actions, snapshots: ready ? sb.listSnapshots() : [], preview, previewPages: sb.outputPages(), savedAt: this.savedAt, runs: this.runs,
    };
  }

  // ---- persistence ----
  private persisted(): PersistedWorkspace {
    return { expanded: [...this.expanded], selected: this.selected, actions: this.actions.slice(-MAX_ACTIONS), previewPage: this.previewPage, previewError: this.previewError, runs: this.runs.slice(-50) };
  }
  private schedulePersist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }
  /** Writes workspace + sandbox state to durable storage now. */
  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.sandbox.state.phase !== "ready") return;
    try { this.sandbox.save(this.persisted() as unknown as Record<string, unknown>); this.savedAt = Date.now(); }
    catch (e) { this.fail(`Couldn't save workspace state: ${e instanceof Error ? e.message : "storage unavailable"}`); }
    this.emit();
  }

  // ---- actions ----
  private fail(message: string): void { this.error = { message, at: Date.now() }; }
  dismissError(): void { this.error = this.initError ? { message: this.initError, at: Date.now() } : null; this.emit(); }

  beginAction(type: WorkspaceActionType, description: string, path?: string, extra?: { round?: string; agentKind?: string; note?: string }): string {
    const act: WorkspaceAction = { id: uid("act"), type, description, status: "running", createdAt: Date.now(), ...(path ? { path } : {}), ...extra };
    this.actions = [...this.actions, act].slice(-MAX_ACTIONS);
    this.schedulePersist(); this.emit();
    return act.id;
  }
  endAction(id: string, result: { ok: true; changes?: readonly FileChange[] } | { ok: false; error: string } | { cancelled: true }): void {
    this.actions = this.actions.map((x) => {
      if (x.id !== id) return x;
      const finishedAt = Date.now();
      if ("cancelled" in result) return { ...x, status: "cancelled", finishedAt };
      if (!result.ok) return { ...x, status: "failed", finishedAt, error: result.error };
      return { ...x, status: "completed", finishedAt, ...(result.changes?.length ? { changes: result.changes.map(describe) } : {}) };
    });
    if ("ok" in result && !result.ok) this.fail(result.error);
    this.schedulePersist(); this.emit();
  }
  /** Runs a synchronous sandbox operation as a tracked action. Returns false when it failed. */
  private run(type: WorkspaceActionType, description: string, path: string | undefined, fn: () => readonly FileChange[] | void): boolean {
    const id = this.beginAction(type, description, path);
    try { const changes = fn() ?? []; this.endAction(id, { ok: true, changes }); return true; }
    catch (e) { this.endAction(id, { ok: false, error: e instanceof Error ? e.message : String(e) }); return false; }
  }

  // ---- files & folders ----
  createFile(path: string, content = ""): boolean {
    const ok = this.run("file.create", `Create file`, path, () => this.sandbox.createFile(path, content));
    if (ok) { this.remote?.({ op: "create", path, content }); this.expandParents(path); this.open(path); }
    return ok;
  }
  createFolder(path: string): boolean {
    const ok = this.run("folder.create", `Create folder`, path, () => this.sandbox.createFolder(path));
    if (ok) { this.remote?.({ op: "mkdir", path }); this.expandParents(path); this.expanded.add(path.replace(/^\/+|\/+$/g, "")); this.emit(); }
    return ok;
  }
  rename(path: string, name: string): boolean {
    const folder = this.sandbox.isFolder(path);
    const parent = path.split("/").slice(0, -1).join("/");
    const ok = this.run("path.rename", `Rename ${folder ? "folder" : "file"}`, path, () => this.sandbox.rename(path, name));
    if (ok) { this.remote?.({ op: "move", from: path, to: parent ? `${parent}/${name}` : name }); this.remapExpanded(path, parent ? `${parent}/${name}` : name); }
    return ok;
  }
  move(from: string, to: string): boolean {
    const ok = this.run("path.move", `Move`, `${from} → ${to}`, () => this.sandbox.move(from, to));
    if (ok) { this.remote?.({ op: "move", from, to }); this.remapExpanded(from, to.replace(/^\/+|\/+$/g, "")); this.expandParents(to); }
    return ok;
  }
  copy(from: string, to: string): boolean {
    const ok = this.run("path.copy", `Copy`, `${from} → ${to}`, () => this.sandbox.copy(from, to));
    if (ok) { this.remote?.({ op: "copy", from, to }); this.expandParents(to); }
    return ok;
  }
  remove(path: string): boolean {
    const ok = this.run("path.delete", `Delete ${this.sandbox.isFolder(path) ? "folder" : "file"}`, path, () => this.sandbox.remove(path));
    if (ok) { this.remote?.({ op: "delete", path }); for (const e of [...this.expanded]) if (e === path || e.startsWith(`${path}/`)) this.expanded.delete(e); if (this.selected === path) this.selected = null; this.emit(); }
    return ok;
  }
  refresh(): void { this.emit(); }
  toggleFolder(path: string): void { if (this.expanded.has(path)) this.expanded.delete(path); else this.expanded.add(path); this.selected = path; this.schedulePersist(); this.emit(); }
  select(path: string | null): void { this.selected = path; this.schedulePersist(); this.emit(); }
  private expandParents(path: string): void {
    const segs = path.replace(/^\/+|\/+$/g, "").split("/");
    for (let i = 1; i < segs.length; i++) this.expanded.add(segs.slice(0, i).join("/"));
    this.schedulePersist(); this.emit();
  }
  private remapExpanded(from: string, to: string): void {
    this.expanded = new Set([...this.expanded].map((e) => (e === from || e.startsWith(`${from}/`) ? to + e.slice(from.length) : e)));
    if (this.selected && (this.selected === from || this.selected.startsWith(`${from}/`))) this.selected = to + this.selected.slice(from.length);
    this.schedulePersist(); this.emit();
  }

  // ---- editor ----
  open(path: string): void {
    try { this.sandbox.openFile(path); this.selected = path; this.changed(); }
    catch (e) { this.fail(e instanceof Error ? e.message : "Couldn't open file"); this.emit(); }
  }
  edit(path: string, content: string, selection?: Selection): void {
    this.sandbox.editBuffer(path, content, selection);
    this.changed();
  }
  setActive(path: string | null): void { this.sandbox.setActive(path); this.changed(); }
  save(path: string, force = false): boolean {
    const b = this.sandbox.session.get(path);
    if (!b) return false;
    if (b.conflict?.kind === "changed" && !force) { this.fail(`${path} changed on disk. Choose which version to keep before saving.`); this.emit(); return false; }
    const ok = this.run("file.save", "Save file", path, () => this.sandbox.saveFile(path, force) ?? []);
    if (ok) { const f = this.sandbox.workspace.files.get(path); if (f) this.remote?.({ op: "write", path, content: f.content }); }
    return ok;
  }
  saveAll(): void { for (const f of this.view.openFiles) if (f.dirty && f.conflict?.kind !== "changed") this.save(f.path); }
  discard(path: string): void { this.sandbox.discardFile(path); this.changed(); }
  acceptDisk(path: string): void { this.sandbox.acceptDisk(path); this.changed(); }
  close(path: string): void { this.sandbox.closeFile(path); this.changed(); }

  // ---- snapshots ----
  createSnapshot(label: string): boolean {
    return this.run("snapshot.create", `Create snapshot “${label}”`, undefined, () => { this.flush(); this.sandbox.createSnapshot(label, this.persisted() as unknown as Record<string, unknown>); });
  }
  restoreSnapshot(id: string): boolean {
    const s = this.sandbox.listSnapshots().find((x) => x.id === id);
    return this.run("snapshot.restore", `Restore snapshot “${s?.label ?? id}”`, undefined, () => {
      const w = this.sandbox.restoreSnapshot(id) as Partial<PersistedWorkspace>;
      this.expanded = new Set(w.expanded ?? []); this.selected = w.selected ?? null;
    });
  }
  deleteSnapshot(id: string): boolean {
    const s = this.sandbox.listSnapshots().find((x) => x.id === id);
    return this.run("snapshot.delete", `Delete snapshot “${s?.label ?? id}”`, undefined, () => { if (!this.sandbox.deleteSnapshot(id)) throw new Error("Snapshot not found"); });
  }

  // ---- server mirror ----
  /** Replaces local files with the server codebase (server wins). */
  applyServerTree(files: { path: string; content: string; encoding: "utf8" | "base64"; updatedAt: number }[], folders: string[]): void {
    if (this.sandbox.state.phase !== "ready") return;
    try { this.sandbox.replaceLocal(files, folders); } catch (e) { this.fail(e instanceof Error ? e.message : "Couldn't load project files"); this.emit(); }
  }
  reportRemoteError(message: string): void { this.fail(message); this.emit(); }

  /** Folds one persisted background-task event into the timeline (idempotent; replayed after reconnect). */
  applyJobEvent(ev: { taskId: string; seq: number; kind: string; data: unknown; at: string }): void {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    const at = Date.parse(`${ev.at.replace(" ", "T")}Z`) || Date.now();
    const rid = ev.taskId;
    let r = this.runs.find((x) => x.id === rid);
    if (!r && ev.kind !== "run.start") return;
    switch (ev.kind) {
      case "run.start":
        if (r) return;
        r = { id: rid, prompt: String(d["prompt"] ?? ""), startedAt: at, status: "running", messages: d["messageId"] ? [{ id: String(d["messageId"]), at }] : [], snapshotId: `rev:${Number(d["revision"] ?? 0)}` };
        this.runs = [...this.runs, r].slice(-50);
        break;
      case "message":
        if (r!.messages.some((m) => m.id === d["messageId"])) return;
        this.runs = this.runs.map((x) => (x.id === rid ? { ...x, messages: [...x.messages, { id: String(d["messageId"]), at }] } : x));
        break;
      case "action.started": {
        const id = String(d["id"]);
        if (this.actions.some((a) => a.id === id)) return;
        const act: WorkspaceAction = { id, type: "agent", description: String(d["title"] ?? "Working"), status: r!.status === "running" ? "running" : "cancelled", createdAt: at, round: `${rid}-${String(d["round"] ?? 0)}`, agentKind: String(d["kind"] ?? "inspect") };
        this.actions = [...this.actions, act].slice(-MAX_ACTIONS);
        break;
      }
      case "phase": {
        const ph = String(d["phase"] ?? "");
        const label: Record<string, string> = { thinking: "Thinking", planning: "Creating Plan", building: "Thinking", validating: "Validating", testing: "Testing" };
        this.runs = this.runs.map((x) => (x.id === rid ? { ...x, phase: ph, step: x.status === "running" ? label[ph] : undefined } : x));
        break;
      }
      case "plan": {
        const v = Number(d["version"] ?? 1);
        if ((r!.planVersion ?? 0) >= v) return;
        this.runs = this.runs.map((x) => (x.id === rid ? { ...x, plan: d["plan"] as unknown as AgentPlan, planVersion: v, planApproved: false, step: undefined } : x));
        break;
      }
      case "plan.decision": {
        const dec = String(d["decision"] ?? "");
        this.runs = this.runs.map((x) => (x.id === rid ? { ...x, phase: dec === "deny" ? "denied" : "thinking", step: dec === "deny" ? undefined : "Thinking" } : x));
        break;
      }
      case "plan.approved": this.runs = this.runs.map((x) => (x.id === rid ? { ...x, planApproved: true } : x)); break;
      case "action": {
        const id = String(d["id"]);
        const ok = d["ok"] !== false;
        const prev = this.actions.find((a) => a.id === id);
        if (prev && prev.status !== "running") return;
        if (prev) {
          this.actions = this.actions.map((a) => (a.id === id ? { ...a, description: String(d["title"] ?? a.description), status: ok ? "completed" : "failed", finishedAt: at, ...(!ok && d["error"] ? { error: String(d["error"]) } : {}) } : a));
          break;
        }
        const act: WorkspaceAction = { id, type: "agent", description: String(d["title"] ?? "Step"), status: ok ? "completed" : "failed", createdAt: at, finishedAt: at, round: `${rid}-${String(d["round"] ?? 0)}`, agentKind: String(d["kind"] ?? "inspect"), ...(d["target"] ? { path: String(d["target"]) } : {}), ...(!ok && d["error"] ? { error: String(d["error"]) } : {}) };
        this.actions = [...this.actions, act].slice(-MAX_ACTIONS);
        break;
      }
      case "fixed": { const ids = (d["ids"] as string[] | undefined) ?? []; this.actions = this.actions.map((a) => (ids.includes(a.id) ? { ...a, fixed: true } : a)); break; }
      case "files": this.runs = this.runs.map((x) => (x.id === rid ? { ...x, mutated: true } : x)); break;
      case "run.end": case "cancelled": case "failed": {
        if (r!.status !== "running") return;
        const status: AgentRun["status"] = ev.kind === "failed" ? "failed" : ev.kind === "cancelled" ? "stopped" : (d["status"] as AgentRun["status"]) ?? "done";
        const err = ev.kind === "failed" ? String(d["error"] ?? "The task failed") : d["error"] ? String(d["error"]) : undefined;
        this.actions = this.actions.map((a) => (a.status === "running" && a.round?.startsWith(`${rid}-`) ? { ...a, status: "cancelled" } : a));
        this.runs = this.runs.map((x) => (x.id === rid ? { ...x, step: undefined, status, endedAt: at, mutated: x.mutated || d["mutated"] === true, ...(err ? { error: err } : {}) } : x));
        break;
      }
      case "step": case "retry": {
        if (r!.status !== "running") return;
        const step = ev.kind === "retry" ? `Retrying (attempt ${String(d["attempt"] ?? "")})` : String(d["label"] ?? "Working");
        this.runs = this.runs.map((x) => (x.id === rid ? { ...x, step } : x));
        break;
      }
      default: return;
    }
    this.schedulePersist(); this.emit();
  }

  // ---- agent runs ----
  startRun(prompt: string): string {
    const run: AgentRun = { id: uid("run"), prompt, startedAt: Date.now(), status: "running", messages: [] };
    this.runs = [...this.runs, run].slice(-50);
    this.schedulePersist(); this.emit();
    return run.id;
  }
  /** Takes the run's before-checkpoint lazily, just before the first file-changing step, so plain chats leave no checkpoint. */
  ensureRunSnapshot(runId: string): void {
    const r = this.runs.find((x) => x.id === runId);
    if (!r || r.snapshotId || this.sandbox.state.phase !== "ready") return;
    try {
      this.flush();
      const snapshotId = this.sandbox.createSnapshot(`Before “${r.prompt.slice(0, 40)}”`, this.persisted() as unknown as Record<string, unknown>).id;
      this.runs = this.runs.map((x) => (x.id === runId ? { ...x, snapshotId } : x));
      this.schedulePersist(); this.emit();
    } catch { /* checkpoint optional */ }
  }
  /** Marks that the run really changed project files; only such runs show “Checkpoint saved”. */
  runMutated(runId: string): void {
    this.runs = this.runs.map((r) => (r.id === runId && !r.mutated ? { ...r, mutated: true } : r));
    this.schedulePersist(); this.emit();
  }
  runMessage(runId: string, messageId: string): void {
    this.runs = this.runs.map((r) => (r.id === runId ? { ...r, messages: [...r.messages, { id: messageId, at: Date.now() }] } : r));
    this.schedulePersist(); this.emit();
  }
  endRun(runId: string, status: AgentRun["status"], error?: string): void {
    this.runs = this.runs.map((r) => (r.id === runId ? { ...r, status, endedAt: Date.now(), ...(error ? { error } : {}) } : r));
    this.schedulePersist(); this.emit();
  }
  markFixed(ids: string[]): void {
    if (!ids.length) return;
    this.actions = this.actions.map((a) => (ids.includes(a.id) ? { ...a, fixed: true } : a));
    if (this.error) this.error = null;
    this.schedulePersist(); this.emit();
  }
  /** Quiet failure recording for agent steps: the agent handles them, so no global error banner. */
  endAgentAction(id: string, ok: boolean, error?: string): void {
    this.actions = this.actions.map((x) => (x.id !== id ? x : ok ? { ...x, status: "completed", finishedAt: Date.now() } : { ...x, status: "failed", finishedAt: Date.now(), error: error ?? "Failed" }));
    this.schedulePersist(); this.emit();
  }

  // ---- preview / output ----
  generateOutput(extra?: { round?: string; agentKind?: string }): boolean | string {
    const id = this.beginAction(extra ? "agent" : "output.generate", extra ? "Check" : "Generate preview output", extra ? "preview build" : undefined, extra);
    const r = this.sandbox.generateOutput();
    if (r.ok) {
      this.previewError = null; this.previewLoading = true; this.previewReload++;
      if (!this.sandbox.outputPages().includes(this.previewPage)) this.previewPage = r.record.entry;
      this.endAction(id, { ok: true });
      return true;
    }
    this.previewError = r.error;
    this.endAction(id, { ok: false, error: r.error });
    return extra ? r.error : false;
  }
  setPreviewPage(page: string): void { this.previewPage = page; this.previewLoading = true; this.schedulePersist(); this.emit(); }
  reloadPreview(): void { if (!this.sandbox.lastOutput) return; this.previewLoading = true; this.previewReload++; this.emit(); }
  previewLoaded(): void { if (this.previewLoading) { this.previewLoading = false; this.emit(); } }
  /** Link navigation from inside the preview; returns false when the page doesn't exist. */
  navigatePreview(path: string): boolean { const p = this.sandbox.resolvePage(path); if (!p) return false; this.setPreviewPage(p); return true; }
  renderPreview(): string | null { return this.sandbox.renderPage(this.previewPage); }

  // ---- agent tool layer ----
  private runtimeErrors: string[] = [];
  /** Script errors posted by the preview iframe; read by the agent's preview-verification tools. */
  reportPreviewError(message: string): void { this.runtimeErrors = [...this.runtimeErrors, message].slice(-20); }
  /** Builds for the agent as a tracked "Check" step, returning structured diagnostics. */
  agentBuild(extra: { round: string }): BuildOutcome {
    const id = this.beginAction("agent", "Check", "preview build", { ...extra, agentKind: "check" });
    const r = this.sandbox.generateOutput();
    if (r.ok) {
      this.previewError = null; this.previewLoading = true; this.previewReload++; this.runtimeErrors = [];
      if (!this.sandbox.outputPages().includes(this.previewPage)) this.previewPage = r.record.entry;
      this.endAgentAction(id, true);
      return { ok: true, outputId: r.record.id, files: r.record.files.length, warnings: r.warnings ?? [] };
    }
    this.previewError = r.error;
    this.endAgentAction(id, false, r.error);
    return { ok: false, errors: r.diagnostics ?? [parseErrorMessage(this.sandbox.workspace.files, r.error)], warnings: r.warnings ?? [] };
  }
  /** Internal codebase tools bound to this workspace; `round` names the timeline group for build steps. */
  createAgentTools(round: { current: string }): AgentTools {
    const sb = this.sandbox;
    return new AgentTools({
      local: sb.workspace.files, output: sb.output,
      folders: () => sb.workspace.files.folders(),
      write: (p, c) => { sb.write(p, c); },
      create: (p, c) => { sb.createFile(p, c); },
      remove: (p) => { sb.remove(p); },
      move: (f, t) => { sb.move(f, t); },
      build: () => this.agentBuild({ round: round.current }),
      lastOutput: () => { const o = sb.lastOutput; return o ? { id: o.id, createdAt: o.createdAt, files: o.files.length } : null; },
      outputStale: () => sb.outputStale(),
      previewErrors: () => this.runtimeErrors,
      clearPreviewErrors: () => { this.runtimeErrors = []; },
    });
  }

  dispose(): void {
    this.flush();
    this.offEvents();
    if (this.sandbox.state.phase === "ready") this.sandbox.dispose();
    this.listeners.clear();
  }
}

// ---- the single active workspace ----
let active: WorkspaceStore | null = null;
export function openWorkspace(projectId: string, userId: string): WorkspaceStore {
  if (active && active.projectId === projectId) return active;
  active?.dispose();
  active = new WorkspaceStore(projectId, userId);
  const store = active;
  const detach = attachServer(store);
  const dispose = store.dispose.bind(store);
  store.dispose = () => { detach(); dispose(); };
  return active;
}
export function closeWorkspace(projectId?: string): void {
  if (active && (!projectId || active.projectId === projectId)) { active.dispose(); active = null; }
}
export const activeWorkspace = (): WorkspaceStore | null => active;

if (typeof window !== "undefined") window.addEventListener("pagehide", () => active?.flush());

const noopSub = () => () => {};
const nullView = () => null;
/** Opens the project's workspace for this component tree and subscribes to its state. */
export function useWorkspace(projectId: string | undefined, userId = "local"): { store: WorkspaceStore | null; view: WorkspaceView | null } {
  const store = typeof window !== "undefined" && projectId ? openWorkspace(projectId, userId) : null;
  useEffect(() => () => { if (projectId) closeWorkspace(projectId); }, [projectId]);
  const view = useSyncExternalStore(store ? store.subscribe : noopSub, store ? store.getView : nullView, nullView);
  return { store, view };
}

/** Project-lifecycle helpers for workspace data kept on this device. */
export function duplicateWorkspaceData(fromProjectId: string, toProjectId: string): void {
  if (active?.projectId === fromProjectId) active.flush();
  new SandboxPersistence(browserBackend(), fromProjectId).copyTo(toProjectId);
}
export function deleteWorkspaceData(projectId: string): void {
  closeWorkspace(projectId);
  new SandboxPersistence(browserBackend(), projectId).clearAll();
}
