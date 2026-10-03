export type ProcessId = string;
export type ProcessSignal = "SIGINT" | "SIGTERM" | "SIGKILL";
export type ProcessStatus =
  | { state: "pending" }
  | { state: "running"; startedAt: number }
  | { state: "exited"; code: number; endedAt: number }
  | { state: "killed"; signal: ProcessSignal; endedAt: number };
export interface ProcessInfo { id: ProcessId; command: string; status: ProcessStatus; port?: number }
