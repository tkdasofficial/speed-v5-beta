// Shared sandbox-level types.
export type SandboxId = string;
export type SandboxPhase = "idle" | "initializing" | "ready" | "suspended" | "disposing" | "disposed" | "error";
export interface SandboxInfo { id: SandboxId; projectId: string; phase: SandboxPhase; createdAt: number; updatedAt: number }
export type LifecycleTransition =
  | { from: "idle"; to: "initializing" }
  | { from: "initializing"; to: "ready" | "error" }
  | { from: "ready"; to: "suspended" | "disposing" | "error" }
  | { from: "suspended"; to: "ready" | "disposing" }
  | { from: "error"; to: "disposing" | "initializing" }
  | { from: "disposing"; to: "disposed" };
