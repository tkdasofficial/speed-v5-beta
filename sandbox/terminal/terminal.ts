import { NotImplementedError, SandboxError } from "../utils/errors";
import type { CommandPolicy } from "../security/command-policy";
import type { CommandSpec } from "../types/terminal";
import type { TerminalProcess } from "./process";
import { TerminalSession } from "./session";
/** Executes commands; implemented by the execution phase. */
export interface CommandExecutor { run(cmd: CommandSpec, session: TerminalSession): TerminalProcess }
export const unavailableExecutor: CommandExecutor = { run() { throw new NotImplementedError("Command execution"); } };
export class Terminal {
  readonly session = new TerminalSession();
  constructor(private readonly policy: CommandPolicy, private readonly executor: CommandExecutor = unavailableExecutor) {}
  run(cmd: CommandSpec): TerminalProcess {
    const d = this.policy.evaluate(cmd);
    if (!d.allowed) throw new SandboxError("FORBIDDEN", d.reason);
    return this.executor.run(cmd, this.session);
  }
}
