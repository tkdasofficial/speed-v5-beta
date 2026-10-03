import { SandboxError } from "../utils/errors";
import type { SandboxPhase } from "../types/sandbox";
const ALLOWED: Record<SandboxPhase, readonly SandboxPhase[]> = {
  idle: ["initializing"],
  initializing: ["ready", "error"],
  ready: ["suspended", "disposing", "error"],
  suspended: ["ready", "disposing"],
  error: ["disposing", "initializing"],
  disposing: ["disposed"],
  disposed: [],
};
export const canTransition = (from: SandboxPhase, to: SandboxPhase): boolean => ALLOWED[from].includes(to);
export function assertTransition(from: SandboxPhase, to: SandboxPhase): void {
  if (!canTransition(from, to)) throw new SandboxError("INVALID_STATE", `Cannot go from ${from} to ${to}`);
}
