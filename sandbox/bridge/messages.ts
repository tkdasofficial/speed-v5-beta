import type { FileChange } from "../types/filesystem";
import type { CommandSpec } from "../types/terminal";
/** Requests the application can send to the sandbox engine. */
export type SandboxRequest =
  | { type: "fs.read"; path: string }
  | { type: "fs.write"; path: string; content: string }
  | { type: "fs.delete"; path: string }
  | { type: "fs.move"; from: string; to: string }
  | { type: "fs.tree" }
  | { type: "terminal.run"; command: CommandSpec };
export type SandboxResponse<T = unknown> = { ok: true; data: T } | { ok: false; code: string; message: string };
export type { FileChange };
