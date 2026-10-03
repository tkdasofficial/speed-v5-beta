// Internal backend tool system — shared contract (spec §3/§4). Server-only; never exposed to the browser.
import type { z } from "zod";
import type { MemoryFileStore } from "../../sandbox/workspace/workspace";

export const ERROR_CODES = [
  "INVALID_ARGUMENT", "PERMISSION_DENIED", "PROJECT_NOT_FOUND", "FILE_NOT_FOUND", "DIRECTORY_NOT_FOUND", "COMMAND_FAILED",
  "BUILD_FAILED", "TEST_FAILED", "TYPECHECK_FAILED", "LINT_FAILED", "DEPENDENCY_FAILED", "PREVIEW_FAILED", "DEPLOYMENT_FAILED",
  "INTEGRATION_FAILED", "TIMEOUT", "CANCELLED", "CONFLICT", "RESOURCE_LIMIT", "SECURITY_BLOCKED", "UNKNOWN_ERROR",
  "PREREQUISITE_FAILED", "CONFIRMATION_REQUIRED", "LOOP_DETECTED", "UNKNOWN_TOOL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type Permission =
  | "project:read" | "project:write" | "project:delete" | "build:run" | "preview:manage" | "git:read" | "git:write"
  | "network:fetch" | "integration:read" | "integration:write" | "database:read" | "database:write" | "env:read" | "env:write"
  | "task:manage" | "logs:read" | "logs:write" | "orchestrate";

export type Category =
  | "workspace" | "discovery" | "search" | "analysis" | "execution" | "verification" | "preview" | "git" | "build" | "state"
  | "dependencies" | "environment" | "transform" | "recovery" | "snapshots" | "integrations" | "planning" | "cleanup"
  | "security" | "assets" | "database" | "api" | "logs" | "knowledge" | "orchestration";

export interface StateChange { kind: "file" | "revision" | "settings" | "build" | "preview" | "task" | "snapshot" | "integration" | "database" | "git" | "log" | "knowledge"; target: string; detail?: string }

export interface ToolResult<D = unknown> {
  success: boolean;
  operationId: string;
  toolName: string;
  data: D | null;
  error: { code: ErrorCode; message: string; retryable: boolean; details?: unknown } | null;
  warnings: string[];
  metadata: Record<string, unknown> & { durationMs?: number; attempts?: number };
  stateChanges: StateChange[];
  nextRecommendedAction: string | null;
}

/** What a handler returns; the normalizer turns it into a ToolResult. */
export interface HandlerOutput<D = unknown> { data: D; warnings?: string[]; stateChanges?: StateChange[]; next?: string | null; metadata?: Record<string, unknown> }

export class ToolFailure extends Error {
  constructor(public code: ErrorCode, message: string, public retryable = false, public details?: unknown, public next: string | null = null) { super(message); }
}

export interface ToolEnv {
  readonly userId: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly workspaceId: string;
  readonly operationId: string;
  /** Plan/read-only sessions reject every tool that is not read-only. */
  readonly readOnly: boolean;
  /** Whether the caller already confirmed destructive operations for this request. */
  readonly confirmed: boolean;
  signal: AbortSignal;
  /** Lazily loaded working copy of the project files; writes are committed once per session. */
  files(): Promise<MemoryFileStore>;
  markDirty(path: string): void;
  revision(): Promise<number>;
  /** Persists pending file changes as one revision. */
  commit(label: string): Promise<{ revision: number; changed: string[] }>;
  /** Drops the cached working copy so the next read sees committed state (after rollbacks/imports). */
  invalidate(): void;
  settings(): Promise<Record<string, string | number | boolean>>;
  patchSettings(p: Record<string, string | number | boolean>): Promise<void>;
  /** Nested execution for orchestration tools (shares the session). */
  run(toolName: string, args: Record<string, unknown>): Promise<ToolResult>;
  log(message: string): void;
}

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  category: Category;
  description: string;
  purpose: string;
  /** Free-text keywords used by capability lookup. */
  capabilities: string[];
  inputSchema: S;
  outputSchema?: z.ZodTypeAny;
  requiredPermissions: Permission[];
  projectScoped: boolean;
  readOnly: boolean;
  destructive: boolean;
  requiresConfirmation: boolean;
  /** Names of prerequisite checks (see prerequisites.ts). */
  prerequisites: string[];
  timeoutMs: number;
  retryPolicy: { maxAttempts: number; backoffMs: number };
  supportsParallelExecution: boolean;
  idempotent: boolean;
  handler: (args: z.infer<S>, env: ToolEnv) => Promise<HandlerOutput>;
}
