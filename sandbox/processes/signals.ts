import type { ProcessSignal } from "../types/process";
export const SIGNALS: readonly ProcessSignal[] = ["SIGINT", "SIGTERM", "SIGKILL"];
/** Conventional exit code for a process terminated by a signal. */
export const signalExitCode = (s: ProcessSignal): number => ({ SIGINT: 130, SIGTERM: 143, SIGKILL: 137 })[s];
