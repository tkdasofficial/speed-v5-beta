export type TerminalId = string;
export interface CommandSpec { program: string; args: readonly string[]; cwd: string; env?: Readonly<Record<string, string>> }
export type TerminalOutput = { stream: "stdout" | "stderr"; data: string; at: number };
export interface TerminalSessionInfo { id: TerminalId; cols: number; rows: number; createdAt: number }
