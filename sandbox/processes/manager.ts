import { NotImplementedError, SandboxError } from "../utils/errors";
import type { ProcessInfo, ProcessSignal } from "../types/process";
import type { CommandSpec } from "../types/terminal";
import { formatCommand } from "../terminal/command";
import type { TerminalProcess } from "../terminal/process";
import type { ProcessRunner } from "./runner";
/** Registry of sandbox processes. Without a runner, start() reports the capability as unavailable. */
export class ProcessManager {
  private procs = new Map<string, { cmd: string; proc: TerminalProcess }>();
  constructor(private readonly runner?: ProcessRunner) {}
  start(cmd: CommandSpec): ProcessInfo {
    if (!this.runner) throw new NotImplementedError("Process execution");
    const proc = this.runner.start(cmd);
    this.procs.set(proc.id, { cmd: formatCommand(cmd), proc });
    return { id: proc.id, command: formatCommand(cmd), status: proc.status() };
  }
  signal(id: string, sig: ProcessSignal): void {
    const p = this.procs.get(id);
    if (!p) throw new SandboxError("NOT_FOUND", `No process ${id}`);
    p.proc.signal(sig);
  }
  list(): ProcessInfo[] { return [...this.procs].map(([id, p]) => ({ id, command: p.cmd, status: p.proc.status() })); }
}
