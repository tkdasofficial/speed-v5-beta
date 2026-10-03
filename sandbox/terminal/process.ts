import type { ProcessSignal, ProcessStatus } from "../types/process";
import type { TerminalOutput } from "../types/terminal";
/** A running command inside a terminal. */
export interface TerminalProcess {
  readonly id: string;
  status(): ProcessStatus;
  onOutput(fn: (o: TerminalOutput) => void): () => void;
  signal(sig: ProcessSignal): void;
  wait(): Promise<ProcessStatus>;
}
