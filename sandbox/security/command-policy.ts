import type { CommandSpec } from "../types/terminal";
export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };
export interface CommandPolicy { evaluate(cmd: CommandSpec): PolicyDecision }
/** Allow-list policy: only listed programs may run. */
export function allowListPolicy(programs: readonly string[]): CommandPolicy {
  const s = new Set(programs);
  return { evaluate: (c) => (s.has(c.program) ? { allowed: true } : { allowed: false, reason: `${c.program} is not allowed` }) };
}
