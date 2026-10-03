import type { TerminalProcess } from "../terminal/process";
import type { CommandSpec } from "../types/terminal";
/** Launches long-running processes (dev servers, watchers). Implemented by the execution phase. */
export interface ProcessRunner { start(cmd: CommandSpec): TerminalProcess }
