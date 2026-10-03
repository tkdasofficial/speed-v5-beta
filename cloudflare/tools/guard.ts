// Tool loop prevention (spec §19) + result normalization (spec §17). Pure, unit-testable.
import type { ErrorCode, HandlerOutput, ToolResult } from "./types";
import { ToolFailure } from "./types";
import { redact } from "./policy";

export const LIMITS = { maxOperationsPerSession: 120, maxSameCall: 3, maxSameError: 3, maxSessionMs: 10 * 60_000, maxDepth: 3, maxParallel: 6 };

/** Tracks repeated identical calls / repeated identical failures with no state change in between. */
export class LoopGuard {
  private calls = new Map<string, number>();
  private errors = new Map<string, number>();
  private total = 0;
  private readonly started = Date.now();
  private stateVersion = 0;
  private lastSeen = new Map<string, number>();

  check(tool: string, args: unknown) {
    if (++this.total > LIMITS.maxOperationsPerSession) throw new ToolFailure("LOOP_DETECTED", `Operation limit (${LIMITS.maxOperationsPerSession}) reached for this request`, false, undefined, "diagnose_failure");
    if (Date.now() - this.started > LIMITS.maxSessionMs) throw new ToolFailure("TIMEOUT", "This request has run too long", false);
    const key = `${tool}:${stable(args)}`;
    // Identical calls only count as a loop when nothing changed in the project since the previous identical call.
    if (this.lastSeen.get(key) !== this.stateVersion) this.calls.set(key, 0);
    this.lastSeen.set(key, this.stateVersion);
    const n = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, n);
    if (n > LIMITS.maxSameCall) throw new ToolFailure("LOOP_DETECTED", `${tool} was called ${n} times with the same arguments and no change — change strategy`, false, undefined, "diagnose_failure");
  }
  recordError(tool: string, code: ErrorCode, message: string) {
    const key = `${tool}:${code}:${message.slice(0, 200)}:${this.stateVersion}`;
    const n = (this.errors.get(key) ?? 0) + 1;
    this.errors.set(key, n);
    return n >= LIMITS.maxSameError;
  }
  stateChanged() { this.stateVersion++; }
  get operations() { return this.total; }
}

export function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

const RETRYABLE: ErrorCode[] = ["TIMEOUT", "INTEGRATION_FAILED", "CONFLICT"];

export function normalizeSuccess(operationId: string, toolName: string, out: HandlerOutput, durationMs: number, attempts: number): ToolResult {
  return {
    success: true, operationId, toolName, data: scrub(out.data) ?? null, error: null, warnings: out.warnings ?? [],
    metadata: { ...(out.metadata ?? {}), durationMs, attempts }, stateChanges: out.stateChanges ?? [], nextRecommendedAction: out.next ?? null,
  };
}

export function normalizeError(operationId: string, toolName: string, e: unknown, durationMs: number, attempts: number): ToolResult {
  const f = toFailure(e);
  return {
    success: false, operationId, toolName, data: null,
    error: { code: f.code, message: redact(f.message).slice(0, 2000), retryable: f.retryable || RETRYABLE.includes(f.code), ...(f.details !== undefined ? { details: scrub(f.details) } : {}) },
    warnings: [], metadata: { durationMs, attempts }, stateChanges: [], nextRecommendedAction: f.next ?? defaultNext(f.code),
  };
}

export function toFailure(e: unknown): ToolFailure {
  if (e instanceof ToolFailure) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (e && typeof e === "object" && "issues" in e) return new ToolFailure("INVALID_ARGUMENT", ((e as { issues: { path: (string | number)[]; message: string }[] }).issues).map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; "));
  if ((e as Error)?.name === "AbortError" || /aborted/i.test(msg)) return new ToolFailure("CANCELLED", "Operation cancelled");
  if (/changed elsewhere|conflict/i.test(msg)) return new ToolFailure("CONFLICT", msg, true);
  if (/No such file|not found/i.test(msg)) return new ToolFailure("FILE_NOT_FOUND", msg);
  if (/traversal|escapes|Protected|FORBIDDEN/i.test(msg)) return new ToolFailure("SECURITY_BLOCKED", msg);
  if (/already exists|File exists/i.test(msg)) return new ToolFailure("CONFLICT", msg);
  return new ToolFailure("UNKNOWN_ERROR", msg);
}

function defaultNext(c: ErrorCode): string | null {
  switch (c) {
    case "BUILD_FAILED": return "analyze_build_failure";
    case "TYPECHECK_FAILED": return "fix_type_error";
    case "LINT_FAILED": return "fix_lint_error";
    case "DEPENDENCY_FAILED": return "fix_dependency_error";
    case "FILE_NOT_FOUND": return "search_files";
    case "PREVIEW_FAILED": return "diagnose_failure";
    case "LOOP_DETECTED": return "diagnose_failure";
    default: return null;
  }
}

/** Results never carry secrets back to the model or the audit log. */
export function scrub<T>(v: T): T {
  if (v === undefined) return v;
  try { return JSON.parse(redact(JSON.stringify(v))) as T; } catch { return v; }
}
