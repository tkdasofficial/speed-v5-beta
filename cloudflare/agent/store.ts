// Agent D1 persistence over any D1-compatible database (production: AGENT_DB binding; tests: SQLite shim).
// Stores references, redacted summaries and small JSON only — never project source, raw large outputs or secrets.
import { scrub } from "../tools/guard";

export interface D1Like {
  prepare(sql: string): { bind(...p: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results?: T[] }> } };
}
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
export const safeJson = (v: unknown, max = 8_000) => { const s = JSON.stringify(scrub(v ?? {})); return s.length > max ? JSON.stringify({ truncated: true, preview: s.slice(0, max - 60) }) : s; };
const clip = (s: string | null | undefined, n = 2000) => (s == null ? null : (scrub(s) as string).slice(0, n));

export type RunStatus = "queued" | "running" | "verifying" | "completed" | "failed" | "cancelled";

export class AgentStore {
  constructor(private db: D1Like) {}
  private async q<T = Record<string, unknown>>(sql: string, p: unknown[] = []) {
    return (await this.db.prepare(sql).bind(...p.map((x) => (x === undefined ? null : x))).all<T>()).results ?? [];
  }

  async createRun(r: { runId: string; projectId: string; userId: string; taskText: string; parentRunId?: string | null; metadata?: unknown }) {
    await this.q("INSERT OR IGNORE INTO agent_runs (run_id, project_id, user_id, parent_run_id, task_text, status, started_at, metadata_json) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)",
      [r.runId, r.projectId, r.userId, r.parentRunId ?? null, clip(r.taskText, 4000), now(), safeJson(r.metadata)]);
  }
  async updateRun(runId: string, p: { status?: RunStatus; stage?: string; stepId?: string | null; failureReason?: string | null; finalSummaryStatus?: string; metadata?: unknown }) {
    const sets: string[] = ["updated_at = ?"]; const v: unknown[] = [now()];
    if (p.status) { sets.push("status = ?"); v.push(p.status); if (p.status === "completed") { sets.push("completed_at = ?"); v.push(now()); } if (p.status === "failed") { sets.push("failed_at = ?"); v.push(now()); } }
    if (p.stage) { sets.push("current_stage = ?"); v.push(p.stage); }
    if (p.stepId !== undefined) { sets.push("current_step_id = ?"); v.push(p.stepId); }
    if (p.failureReason !== undefined) { sets.push("failure_reason = ?"); v.push(clip(p.failureReason, 2000)); }
    if (p.finalSummaryStatus) { sets.push("final_summary_status = ?"); v.push(p.finalSummaryStatus); }
    if (p.metadata !== undefined) { sets.push("metadata_json = ?"); v.push(safeJson(p.metadata)); }
    await this.q(`UPDATE agent_runs SET ${sets.join(", ")} WHERE run_id = ?`, [...v, runId]);
  }
  async addStep(runId: string, s: { type: string; name: string; description?: string; batchId?: string | null; parentStepId?: string | null; status?: string; inputRef?: string | null; metadata?: unknown }) {
    const id = uid("st");
    await this.q(`INSERT INTO agent_steps (step_id, run_id, parent_step_id, sequence, step_type, name, description, status, batch_id, started_at, input_reference, metadata_json)
      SELECT ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ? FROM agent_steps WHERE run_id = ?`,
      [id, runId, s.parentStepId ?? null, s.type, s.name.slice(0, 200), clip(s.description ?? null, 1000), s.status ?? "running", s.batchId ?? null, s.status === "pending" ? null : now(), s.inputRef ?? null, safeJson(s.metadata), runId]);
    return id;
  }
  async finishStep(stepId: string, p: { status: "succeeded" | "failed" | "skipped" | "cancelled" | "running"; error?: string | null; outputRef?: string | null; metadata?: unknown }) {
    await this.q(`UPDATE agent_steps SET status = ?, error = ?, output_reference = COALESCE(?, output_reference), started_at = COALESCE(started_at, ?),
      completed_at = CASE WHEN ? = 'running' THEN NULL ELSE ? END,
      duration_ms = CASE WHEN ? = 'running' THEN NULL ELSE CAST((julianday(?) - julianday(COALESCE(started_at, ?))) * 86400000 AS INTEGER) END,
      metadata_json = COALESCE(?, metadata_json) WHERE step_id = ?`,
      [p.status, clip(p.error ?? null), p.outputRef ?? null, now(), p.status, now(), p.status, now(), now(), p.metadata === undefined ? null : safeJson(p.metadata), stepId]);
  }
  async addMessage(runId: string, m: { role: "user" | "agent" | "system"; type: string; content: string; stepId?: string | null; metadata?: unknown }) {
    const id = uid("msg");
    await this.q(`INSERT INTO agent_messages (message_id, run_id, step_id, role, message_type, content, sequence, metadata_json)
      SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, ? FROM agent_messages WHERE run_id = ?`,
      [id, runId, m.stepId ?? null, m.role, m.type, clip(m.content, 6000), safeJson(m.metadata), runId]);
    return id;
  }
  async startToolCall(runId: string, t: { toolName: string; toolId: string; stepId?: string | null; batchId?: string | null; inputRef: string; metadata?: unknown }) {
    const id = uid("tc");
    await this.q("INSERT INTO agent_tool_calls (tool_call_id, run_id, step_id, batch_id, tool_id, tool_name, status, input_reference, started_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)",
      [id, runId, t.stepId ?? null, t.batchId ?? null, t.toolId, t.toolName, clip(t.inputRef, 1000), now(), safeJson(t.metadata)]);
    return id;
  }
  async finishToolCall(id: string, r: { ok: boolean; cancelled?: boolean; outputRef?: string | null; error?: string | null; durationMs: number; retryCount: number }) {
    await this.q("UPDATE agent_tool_calls SET status = ?, output_reference = ?, error = ?, completed_at = ?, duration_ms = ?, retry_count = ? WHERE tool_call_id = ?",
      [r.cancelled ? "cancelled" : r.ok ? "succeeded" : "failed", clip(r.outputRef ?? null, 1000), clip(r.error ?? null), now(), r.durationMs, r.retryCount, id]);
  }
  async checkpoint(runId: string, c: { stepId?: string | null; type: string; state: unknown; completed: unknown[]; pending: unknown[]; next: string | null }) {
    const id = uid("cp");
    await this.q("INSERT INTO agent_checkpoints (checkpoint_id, run_id, step_id, checkpoint_type, state_json, completed_actions_json, pending_actions_json, next_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, runId, c.stepId ?? null, c.type, safeJson(c.state, 6000), safeJson(c.completed.slice(-100), 6000), safeJson(c.pending.slice(0, 100), 4000), c.next]);
    return id;
  }
  async recordUsage(runId: string, u: { stepId?: string | null; provider: string; model: string; requestType: string; inputTokens?: number | null; outputTokens?: number | null; latencyMs: number; status: "succeeded" | "failed"; metadata?: unknown }) {
    const total = u.inputTokens != null && u.outputTokens != null ? u.inputTokens + u.outputTokens : null;
    await this.q("INSERT INTO agent_usage (id, run_id, step_id, provider, model, request_type, input_tokens, output_tokens, total_tokens, latency_ms, status, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [uid("use"), runId, u.stepId ?? null, u.provider, u.model, u.requestType, u.inputTokens ?? null, u.outputTokens ?? null, total, u.latencyMs, u.status, safeJson(u.metadata)]);
  }

  getRun(runId: string) { return this.q("SELECT * FROM agent_runs WHERE run_id = ?", [runId]).then((r) => r[0] ?? null); }
  steps(runId: string) { return this.q("SELECT * FROM agent_steps WHERE run_id = ? ORDER BY sequence", [runId]); }
  messages(runId: string, since = 0) { return this.q("SELECT * FROM agent_messages WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT 500", [runId, since]); }
  toolCalls(runId: string) { return this.q("SELECT * FROM agent_tool_calls WHERE run_id = ? ORDER BY started_at, rowid LIMIT 1000", [runId]); }
  latestCheckpoint(runId: string) { return this.q("SELECT * FROM agent_checkpoints WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [runId]).then((r) => r[0] ?? null); }
  usage(runId: string) { return this.q("SELECT * FROM agent_usage WHERE run_id = ? ORDER BY created_at", [runId]); }
  listRuns(userId: string, projectId: string, limit = 20) { return this.q("SELECT run_id, status, current_stage, task_text, final_summary_status, created_at, completed_at, failed_at FROM agent_runs WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT ?", [userId, projectId, limit]); }
}
