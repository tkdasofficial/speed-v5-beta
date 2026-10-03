import type { SandboxInfo, SandboxPhase } from "../types/sandbox";
import { uid } from "./context";
export function initialState(projectId: string): SandboxInfo {
  const now = Date.now();
  return { id: uid("sbx"), projectId, phase: "idle", createdAt: now, updatedAt: now };
}
export const withPhase = (s: SandboxInfo, phase: SandboxPhase): SandboxInfo => ({ ...s, phase, updatedAt: Date.now() });
