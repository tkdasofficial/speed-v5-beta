// AgentRun: the Agent Core's runtime recorder for one ai_agent task (run_id = task id). Records stages, steps, tool
// calls, per-file events, local progress, checkpoints and AI usage in Agent D1. Recording is fail-soft: a telemetry
// write error is logged and never breaks the user's run.
import type { TaskContext } from "../tasks/registry";
import type { ToolResult } from "../tools/types";
import type { ToolSession } from "../tools/orchestrator";
import type { AgentStore, RunStatus } from "./store";
import { progressMessage, type ProgressEvent } from "./messages";
import { registryToolId } from "./registry";

/** Tool arguments as a small reference: paths and sizes, never file contents or secrets. */
export function argsRef(args: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") out[k] = v.length > 120 || /content|replace|find|code|patch|value/i.test(k) ? `<${v.length} chars>` : v;
    else if (Array.isArray(v)) out[k] = `<${v.length} items>`;
    else if (v && typeof v === "object") out[k] = `<object ${Object.keys(v).length} keys>`;
    else out[k] = v;
  }
  return JSON.stringify(out);
}

const runs = new WeakMap<TaskContext, AgentRun>();

export class AgentRun {
  private seed = 0;
  constructor(readonly store: AgentStore, readonly runId: string, private c: TaskContext | null) {}

  static async for(c: TaskContext): Promise<AgentRun> {
    let r = runs.get(c);
    if (!r) { const { agentStore } = await import("./db.server"); r = new AgentRun(agentStore(), c.task.id, c); runs.set(c, r); }
    return r;
  }
  private async safe<T>(f: () => Promise<T>): Promise<T | null> {
    try { return await f(); } catch (e) { console.error(`[agent-d1] ${this.runId}: ${(e as Error).message}`); return null; }
  }

  start(i: { projectId: string; userId: string; taskText: string; parentRunId?: string | null; metadata?: unknown }) {
    return this.safe(async () => {
      await this.store.createRun({ runId: this.runId, ...i });
      await this.store.addMessage(this.runId, { role: "user", type: "user_request", content: i.taskText });
    });
  }
  stage(stage: string, status?: RunStatus, stepId?: string | null) { return this.safe(() => this.store.updateRun(this.runId, { stage, ...(status ? { status } : {}), ...(stepId !== undefined ? { stepId } : {}) })); }
  async step(s: Parameters<AgentStore["addStep"]>[1]) { const id = await this.safe(() => this.store.addStep(this.runId, s)); if (id && s.status !== "pending") await this.safe(() => this.store.updateRun(this.runId, { stepId: id })); return id; }
  finishStep(id: string | null | undefined, p: Parameters<AgentStore["finishStep"]>[1]) { return id ? this.safe(() => this.store.finishStep(id, p)) : Promise.resolve(null); }

  /** Local progress (Dynamic Message Generator) → Agent D1 message + task event. No AI call. */
  async progress(e: ProgressEvent, stepId?: string | null) {
    const text = progressMessage(e, this.seed++ + this.runId.length);
    await this.safe(() => this.store.addMessage(this.runId, { role: "agent", type: e.type === "complete" ? "status" : "progress", content: text, stepId: stepId ?? null, metadata: { event: e.type } }));
    await this.c?.emit("agent.progress", { text, event: e.type }).catch(() => undefined);
    return text;
  }

  /** Runs a tool through the orchestrator session and records it in agent_tool_calls. */
  async tool(sess: Pick<ToolSession, "execute">, name: string, args: Record<string, unknown>, o: { stepId?: string | null; batchId?: string | null } = {}): Promise<ToolResult> {
    const callId = await this.safe(() => this.store.startToolCall(this.runId, { toolName: name, toolId: registryToolId(name), stepId: o.stepId ?? null, batchId: o.batchId ?? null, inputRef: argsRef(args) }));
    const t0 = Date.now();
    const r = await sess.execute(name, args);
    if (callId) await this.safe(() => this.store.finishToolCall(callId, { ok: r.success, cancelled: r.error?.code === "CANCELLED", outputRef: `op:${r.operationId}`, error: r.error ? `${r.error.code}: ${r.error.message}` : null, durationMs: Date.now() - t0, retryCount: Math.max(0, (r.metadata.attempts ?? 1) - 1) }));
    return r;
  }

  /** One file_changed event per file, even when a batch changed several files at once. */
  async files(changed: string[], revision: number, o: { stepId?: string | null; batchId?: string | null } = {}) {
    for (const path of changed) {
      await this.safe(() => this.store.addMessage(this.runId, { role: "agent", type: "file_changed", content: path, stepId: o.stepId ?? null, metadata: { revision, batchId: o.batchId ?? null } }));
      await this.c?.emit("file_changed", { path, revision, batchId: o.batchId ?? null }).catch(() => undefined);
    }
  }
  checkpoint(cp: Parameters<AgentStore["checkpoint"]>[1]) { return this.safe(() => this.store.checkpoint(this.runId, cp)); }
  usage(u: Parameters<AgentStore["recordUsage"]>[1]) { return this.safe(() => this.store.recordUsage(this.runId, u)); }
  finish(status: RunStatus, p: { failureReason?: string | null; finalSummaryStatus?: string; metadata?: unknown } = {}) {
    return this.safe(() => this.store.updateRun(this.runId, { status, stage: status, stepId: null, ...p }));
  }
}
