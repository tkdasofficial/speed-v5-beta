// Typed sandbox errors.
export type SandboxErrorCode = "NOT_FOUND" | "ALREADY_EXISTS" | "INVALID_PATH" | "FORBIDDEN" | "INVALID_STATE" | "NOT_IMPLEMENTED";
export class SandboxError extends Error {
  constructor(public readonly code: SandboxErrorCode, message: string) { super(message); this.name = "SandboxError"; }
}
/** Thrown by capabilities that belong to a later phase (execution, storage, builds). */
export class NotImplementedError extends SandboxError {
  constructor(feature: string) { super("NOT_IMPLEMENTED", `${feature} is not available yet`); }
}
