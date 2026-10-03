// Task-type registry. Any feature registers a handler; the worker runs it step by step and owns the lifecycle.
import type { Json } from "@realtime/events";
import type { TaskRow } from "./store.server";

export interface TaskContext {
  task: TaskRow;
  payload: Record<string, unknown>;
  /** Handler-owned resumable state, persisted after every step. */
  state: Record<string, unknown>;
  emit(kind: string, data?: Json): Promise<void>;
  progress(value: number, step?: string): Promise<void>;
  /** True once the user asked to cancel; handlers check between units of work. */
  cancelled(): Promise<boolean>;
}
/** `wait` parks the task in `awaiting_approval` (no alarm) until a user decision re-queues it. */
export type StepResult = { done: false; delayMs?: number; wait?: false } | { done: false; wait: true } | { done: true; result?: Json };
export interface TaskHandler {
  /** Runs one bounded unit of work (well under the worker time limit). Throw RetryableError for transient failures. */
  step(c: TaskContext): Promise<StepResult>;
  onCancel?(c: TaskContext): Promise<void>;
  maxRetries?: number;
}

export class RetryableError extends Error {}
export class FatalError extends Error {}

const handlers = new Map<string, () => Promise<TaskHandler>>();
export function registerTaskType(type: string, load: () => Promise<TaskHandler>) { handlers.set(type, load); }
export const isTaskType = (t: string) => handlers.has(t);
export async function handlerFor(type: string): Promise<TaskHandler | null> { const l = handlers.get(type); return l ? l() : null; }

// Built-in task types. New features add one line here.
registerTaskType("ai_agent", async () => (await import("./handlers/agent.server")).agentHandler);
registerTaskType("file_operation", async () => (await import("./handlers/file-op.server")).fileOpHandler);
