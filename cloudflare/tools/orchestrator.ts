// ToolOrchestrator (spec §2): the only way tools run. Policy → arguments → prerequisites → execute (timeout, retry,
// cancellation) → normalize → state update → audit. Storage and project IO are injected so the core is testable.
import type { MemoryFileStore } from "../../sandbox/workspace/workspace";
import { findToolsByCapability, getTool, getToolMetadata, isToolEnabled } from "./registry";
import { checkPolicy, grantedPermissions } from "./policy";
import { LIMITS, LoopGuard, normalizeError, normalizeSuccess, toFailure } from "./guard";
import { checkPrerequisites } from "./prerequisites";
import type { ToolEnv, ToolResult } from "./types";
import { ToolFailure } from "./types";

export interface OperationStore {
  start(op: { id: string; parentId: string | null; userId: string; projectId: string; taskId: string | null; toolName: string; args: unknown; revisionBefore: number | null }): Promise<void>;
  finish(id: string, r: ToolResult, revisionAfter: number | null): Promise<void>;
  cancelRequested(id: string): Promise<boolean>;
}
export interface ProjectIO {
  load(projectId: string): Promise<{ store: MemoryFileStore; revision: number }>;
  snapshot(store: MemoryFileStore): unknown;
  commit(projectId: string, baseRevision: number, before: unknown, store: MemoryFileStore, meta: { taskId: string | null; label: string }): Promise<{ revision: number; changed: string[] }>;
  revision(projectId: string): Promise<number>;
  settings(projectId: string): Promise<Record<string, string | number | boolean>>;
  patchSettings(userId: string, projectId: string, p: Record<string, string | number | boolean>): Promise<void>;
}

export interface SessionOpts { userId: string; projectId: string; taskId?: string | null; readOnly?: boolean; confirmed?: boolean; signal?: AbortSignal; ops: OperationStore; io: ProjectIO }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const opId = () => `op_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;

/** One orchestrated session (an agent turn or one API request). Shares the working copy, loop guard and audit parent. */
export class ToolSession {
  readonly guard = new LoopGuard();
  readonly logs: string[] = [];
  private store: MemoryFileStore | null = null;
  private before: unknown = null;
  private base = 0;
  private dirty = new Set<string>();
  private readonly depths = new Map<string, number>();
  private readonly abort = new AbortController();
  constructor(readonly o: SessionOpts) { o.signal?.addEventListener("abort", () => this.abort.abort()); }

  get pendingChanges() { return [...this.dirty]; }
  cancel() { this.abort.abort(); }

  private async files() {
    if (!this.store) { const l = await this.o.io.load(this.o.projectId); this.store = l.store; this.base = l.revision; this.before = this.o.io.snapshot(l.store); }
    return this.store;
  }
  async commit(label: string) {
    if (!this.store || !this.dirty.size) return { revision: this.base, changed: [] as string[] };
    const r = await this.o.io.commit(this.o.projectId, this.base, this.before, this.store, { taskId: this.o.taskId ?? null, label: label.slice(0, 80) });
    this.dirty.clear(); this.base = r.revision; this.before = this.o.io.snapshot(this.store);
    if (r.changed.length) this.guard.stateChanged();
    return r;
  }

  private env(operationId: string): ToolEnv {
    return {
      userId: this.o.userId, projectId: this.o.projectId, taskId: this.o.taskId ?? null, workspaceId: this.o.projectId, operationId,
      readOnly: !!this.o.readOnly, confirmed: !!this.o.confirmed, signal: this.abort.signal,
      files: () => this.files(),
      markDirty: (p) => { this.dirty.add(p); this.guard.stateChanged(); },
      revision: async () => (this.store ? this.base : this.o.io.revision(this.o.projectId)),
      commit: (label) => this.commit(label),
      invalidate: () => { this.store = null; this.dirty.clear(); this.guard.stateChanged(); },
      settings: () => this.o.io.settings(this.o.projectId),
      patchSettings: async (p) => { await this.o.io.patchSettings(this.o.userId, this.o.projectId, p); this.guard.stateChanged(); },
      // Children carry their parent explicitly, so concurrent children (execute_parallel) keep correct audit links.
      run: (name, args) => this.execute(name, args, operationId),
      log: (m) => { this.logs.push(m); },
    };
  }

  /** Resolves a capability request to a concrete tool (the agent asks for what it needs; the orchestrator picks). */
  resolve(nameOrCapability: string): string | null {
    if (getTool(nameOrCapability)) return nameOrCapability;
    return findToolsByCapability(nameOrCapability, { limit: 1, readOnly: !!this.o.readOnly })[0]?.name ?? null;
  }

  async execute(nameOrCapability: string, rawArgs: Record<string, unknown> = {}, parentOp: string | null = null): Promise<ToolResult> {
    const name = this.resolve(nameOrCapability) ?? nameOrCapability;
    const id = opId();
    const t0 = Date.now();
    const tool = getTool(name);
    if (!tool) return normalizeError(id, name, new ToolFailure("UNKNOWN_TOOL", `No tool for "${nameOrCapability}". Use find_tools{capability} to discover tools.`, false, { suggestions: findToolsByCapability(nameOrCapability, { limit: 5 }).map((x) => x.name) }, "find_tools"), 0, 0);
    if (!isToolEnabled(name)) return normalizeError(id, name, new ToolFailure("PERMISSION_DENIED", `Tool "${name}" is disabled in the Agent Tool Registry.`), 0, 0);
    const depth = parentOp ? (this.depths.get(parentOp) ?? 0) + 1 : 0;
    if (depth >= LIMITS.maxDepth) return normalizeError(id, name, new ToolFailure("LOOP_DETECTED", "Nested orchestration too deep"), 0, 0);
    let attempts = 0;
    const parentId = parentOp;
    let started = false;
    try {
      this.guard.check(name, rawArgs);
      checkPolicy({ tool, args: rawArgs, projectId: this.o.projectId, readOnly: !!this.o.readOnly, confirmed: !!this.o.confirmed, granted: grantedPermissions(!!this.o.readOnly) });
      const { confirm: _c, projectId: _p, ...rest } = rawArgs;
      const args = tool.inputSchema.parse(rest) as Record<string, unknown>;
      const env = this.env(id);
      await checkPrerequisites(tool, env);
      await this.o.ops.start({ id, parentId, userId: this.o.userId, projectId: this.o.projectId, taskId: this.o.taskId ?? null, toolName: name, args: rest, revisionBefore: this.store ? this.base : null });
      started = true;
      this.depths.set(id, depth);
      try {
        for (;;) {
          attempts++;
          if (this.abort.signal.aborted || (await this.o.ops.cancelRequested(id))) throw new ToolFailure("CANCELLED", "Operation cancelled");
          try {
            const out = await withTimeout(tool.handler(args, env), tool.timeoutMs, this.abort.signal);
            const r = normalizeSuccess(id, name, out, Date.now() - t0, attempts);
            await this.o.ops.finish(id, r, this.store ? this.base : null);
            return r;
          } catch (e) {
            const f = toFailure(e);
            const canRetry = (f.retryable || f.code === "TIMEOUT") && attempts < tool.retryPolicy.maxAttempts && (tool.idempotent || f.code === "CONFLICT");
            if (!canRetry) throw f;
            if (f.code === "CONFLICT") env.invalidate();
            await sleep(tool.retryPolicy.backoffMs * attempts);
          }
        }
      } finally { this.depths.delete(id); }
    } catch (e) {
      const r = normalizeError(id, name, e, Date.now() - t0, attempts);
      if (r.error && this.guard.recordError(name, r.error.code, r.error.message)) {
        r.error.message += " (same failure repeated — stop retrying, diagnose and change strategy)";
        r.nextRecommendedAction = "diagnose_failure";
      }
      if (started) await this.o.ops.finish(id, r, this.store ? this.base : null).catch(() => undefined);
      else await this.o.ops.start({ id, parentId, userId: this.o.userId, projectId: this.o.projectId, taskId: this.o.taskId ?? null, toolName: name, args: rawArgs, revisionBefore: null }).then(() => this.o.ops.finish(id, r, null)).catch(() => undefined);
      return r;
    }
  }

  /** Independent operations in parallel (bounded); any write tool forces sequential execution. */
  async parallel(calls: { tool: string; args?: Record<string, unknown> }[]): Promise<ToolResult[]> {
    const tools = calls.map((c) => getTool(this.resolve(c.tool) ?? c.tool));
    const parallelSafe = tools.every((t) => t?.supportsParallelExecution);
    if (!parallelSafe) return this.sequence(calls, { stopOnError: false });
    const out: ToolResult[] = new Array(calls.length);
    for (let i = 0; i < calls.length; i += LIMITS.maxParallel) {
      const chunk = calls.slice(i, i + LIMITS.maxParallel);
      const res = await Promise.all(chunk.map((c) => this.execute(c.tool, c.args ?? {})));
      res.forEach((r, j) => (out[i + j] = r));
    }
    return out;
  }

  /** Dependent operations in order; stops at the first failure unless told otherwise. */
  async sequence(calls: { tool: string; args?: Record<string, unknown> }[], o: { stopOnError?: boolean } = {}): Promise<ToolResult[]> {
    const out: ToolResult[] = [];
    for (const c of calls) {
      const r = await this.execute(c.tool, c.args ?? {});
      out.push(r);
      if (!r.success && o.stopOnError !== false) break;
    }
    return out;
  }

  describe(name: string) { return getToolMetadata(name); }
}

function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => { t = setTimeout(() => rej(new ToolFailure("TIMEOUT", `Timed out after ${Math.round(ms / 1000)} s`, true)), ms); }),
    new Promise<never>((_, rej) => { if (signal.aborted) rej(new ToolFailure("CANCELLED", "Operation cancelled")); signal.addEventListener("abort", () => rej(new ToolFailure("CANCELLED", "Operation cancelled")), { once: true }); }),
  ]).finally(() => clearTimeout(t));
}
