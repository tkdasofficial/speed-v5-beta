// ToolRegistry (spec §3): one central catalog. The agent never sees implementations — only names/args it is routed to.
import { z } from "zod";
import type { Category, ToolDefinition } from "./types";

const tools = new Map<string, ToolDefinition>();

type Def<S extends z.ZodTypeAny> = Omit<ToolDefinition<S>, "requiredPermissions" | "projectScoped" | "readOnly" | "destructive" | "requiresConfirmation" | "prerequisites" | "timeoutMs" | "retryPolicy" | "supportsParallelExecution" | "idempotent" | "purpose" | "capabilities"> &
  Partial<Pick<ToolDefinition<S>, "requiredPermissions" | "projectScoped" | "readOnly" | "destructive" | "requiresConfirmation" | "prerequisites" | "timeoutMs" | "retryPolicy" | "supportsParallelExecution" | "idempotent" | "purpose" | "capabilities">>;

/** Tool factory with shared defaults (category, permissions…) that keeps per-tool argument typing. */
export function group(defaults: Partial<Def<z.ZodTypeAny>> & { category: Category }) {
  return <S extends z.ZodTypeAny>(d: Omit<Def<S>, "category"> & { category?: Category }) => defineTool<S>({ ...defaults, ...d } as unknown as Def<S>);
}

/** Defines a tool with safe defaults: read-only, project-scoped, 20 s timeout, no retry. */
export function defineTool<S extends z.ZodTypeAny>(d: Def<S>): ToolDefinition<S> {
  const readOnly = d.readOnly ?? !(d.destructive ?? false);
  return {
    purpose: d.description,
    capabilities: [],
    requiredPermissions: [readOnly ? "project:read" : "project:write"],
    projectScoped: true,
    readOnly,
    destructive: false,
    requiresConfirmation: d.destructive ?? false,
    prerequisites: [],
    timeoutMs: 20_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    supportsParallelExecution: readOnly,
    idempotent: readOnly,
    ...d,
  } as ToolDefinition<S>;
}

export function validateTool(t: ToolDefinition): string[] {
  const e: string[] = [];
  if (!/^[a-z][a-z0-9_]{1,59}$/.test(t.name)) e.push(`bad name ${t.name}`);
  if (!t.description) e.push(`${t.name}: description required`);
  if (typeof t.handler !== "function") e.push(`${t.name}: handler required`);
  if (!(t.inputSchema instanceof z.ZodType)) e.push(`${t.name}: inputSchema must be a zod schema`);
  if (t.destructive && !t.requiresConfirmation && !t.requiredPermissions.some((p) => p.endsWith(":delete") || p.endsWith(":write"))) e.push(`${t.name}: destructive tools need a write/delete permission`);
  if (t.timeoutMs <= 0 || t.timeoutMs > 120_000) e.push(`${t.name}: timeout out of range`);
  return e;
}

export function registerTool(t: ToolDefinition) {
  const errs = validateTool(t);
  if (errs.length) throw new Error(`Invalid tool: ${errs.join("; ")}`);
  if (tools.has(t.name)) throw new Error(`Duplicate tool ${t.name}`);
  tools.set(t.name, t);
}
export const getTool = (name: string) => tools.get(name) ?? null;
export const allTools = () => [...tools.values()];
export const getToolsByCategory = (c: Category) => allTools().filter((t) => t.category === c);

/** Lightweight metadata for the agent: never the handler, only what it needs to call the tool. */
export function getToolMetadata(name: string) {
  const t = getTool(name);
  if (!t) return null;
  return { name: t.name, category: t.category, description: t.description, args: describeArgs(t.inputSchema), readOnly: t.readOnly, destructive: t.destructive, requiresConfirmation: t.requiresConfirmation };
}

function describeArgs(s: z.ZodTypeAny): string {
  const shape = s instanceof z.ZodObject ? (s.shape as Record<string, z.ZodTypeAny>) : null;
  if (!shape) return "{}";
  return `{${Object.entries(shape).map(([k, v]) => `${k}${v.isOptional() ? "?" : ""}`).join(", ")}}`;
}

/** Capability routing: scores tools by keyword overlap with the requested capability text. */
export function findToolsByCapability(capability: string, opts: { limit?: number; readOnly?: boolean } = {}) {
  const words = capability.toLowerCase().replace(/[^a-z0-9_ ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  const exact = getTool(capability.trim().toLowerCase().replace(/\s+/g, "_"));
  const scored = allTools()
    .filter((t) => !opts.readOnly || t.readOnly)
    .map((t) => {
      const hay = `${t.name.replace(/_/g, " ")} ${t.category} ${t.description} ${t.capabilities.join(" ")}`.toLowerCase();
      let s = 0;
      for (const w of words) { if (t.name.includes(w)) s += 3; if (hay.includes(w)) s += 1; }
      if (exact && t.name === exact.name) s += 100;
      return { t, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.limit ?? 6);
  return scored.map((x) => getToolMetadata(x.t.name)!);
}

export function _resetRegistryForTests() { tools.clear(); }
