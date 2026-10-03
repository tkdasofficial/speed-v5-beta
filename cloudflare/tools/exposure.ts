// Tool exposure (spec §1 "do not expose all tools"): each agent phase sees only the categories it needs.
// Anything else stays reachable only through find_tools → the orchestrator still decides what runs.
import { z } from "zod";
import { allTools } from "./registry";
import type { Category, ToolDefinition } from "./types";

export type AgentPhase = "planning" | "building" | "validating";

const PHASES: Record<AgentPhase, Category[]> = {
  planning: ["discovery", "search", "analysis", "knowledge", "planning"],
  building: ["workspace", "transform", "dependencies", "environment", "snapshots", "planning", "knowledge", "recovery", "orchestration"],
  validating: ["verification", "build", "execution", "preview", "logs", "recovery", "security"],
};
/** Always visible: the minimum the agent needs to read and navigate in every phase. */
const ALWAYS = new Set(["read_file", "list_files", "search_files", "find_tools", "describe_tool"]);

export function toolsForPhase(phase: AgentPhase, readOnly = false): ToolDefinition[] {
  const cats = new Set(PHASES[phase]);
  return allTools().filter((t) => (cats.has(t.category) || ALWAYS.has(t.name)) && (!readOnly || t.readOnly));
}

function argSig(s: z.ZodTypeAny): string {
  const shape = s instanceof z.ZodObject ? (s.shape as Record<string, z.ZodTypeAny>) : null;
  if (!shape) return "";
  return Object.entries(shape).map(([k, v]) => `${k}${v.isOptional() || v instanceof z.ZodDefault ? "?" : ""}`).join(",");
}

/** Compact catalog for the system prompt: `name{args} — description`. */
export function catalogText(phase: AgentPhase, readOnly = false): string {
  const byCat = new Map<string, string[]>();
  for (const t of toolsForPhase(phase, readOnly)) {
    const line = `${t.name}{${argSig(t.inputSchema)}}${t.requiresConfirmation ? "!" : ""} — ${t.description.slice(0, 110)}`;
    byCat.set(t.category, [...(byCat.get(t.category) ?? []), line]);
  }
  return [...byCat].map(([c, l]) => `${c.toUpperCase()}:\n${l.join("\n")}`).join("\n");
}
