import type { FileChange } from "../types/filesystem";
import type { SandboxPhase } from "../types/sandbox";
import type { TerminalOutput } from "../types/terminal";
/** Events the sandbox engine emits to the application. */
export type SandboxEvent =
  | { type: "phase"; phase: SandboxPhase }
  | { type: "fs.changed"; changes: readonly FileChange[] }
  | { type: "output.ready"; id: string }
  | { type: "output.failed"; error: string }
  | { type: "terminal.output"; terminalId: string; output: TerminalOutput };
export type SandboxEventListener = (e: SandboxEvent) => void;
export class EventBus {
  private ls = new Set<SandboxEventListener>();
  on(fn: SandboxEventListener): () => void { this.ls.add(fn); return () => { this.ls.delete(fn); }; }
  emit(e: SandboxEvent): void { for (const fn of this.ls) fn(e); }
}
