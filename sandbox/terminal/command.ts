import type { CommandSpec } from "../types/terminal";
/** Parses a simple command line (whitespace + quotes) into a CommandSpec. */
export function parseCommand(line: string, cwd = "."): CommandSpec {
  const tokens = line.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
  const [program = "", ...args] = tokens;
  return { program, args, cwd };
}
export const formatCommand = (c: CommandSpec): string => [c.program, ...c.args].join(" ");
