// Agent Tool Registry: the authoritative runtime catalog over the existing tools. Metadata only — handlers stay in
// tools/catalog/*, and every execution still goes through the ToolOrchestrator.
import type { z } from "zod";
import { allAliases, allTools, disabledTools, getTool } from "../tools/registry";
import { loadTools, toolCatalog } from "../tools/index";
import type { ToolDefinition } from "../tools/types";

export const REGISTRY_VERSION = "1.0.0";
export interface RegistryEntry {
  tool_id: string; tool_name: string; category: string; family: string; description: string;
  input_schema: Record<string, string>; output_schema: Record<string, string> | null; permissions: string[];
  handler: string; enabled: boolean; version: string; risk_level: "low" | "medium" | "high";
  timeout_ms: number; retry_policy: { maxAttempts: number; backoffMs: number }; alias_of: string | null; status: "ok" | "invalid";
}

/** Compact JSON-like shape of a zod schema (field → type), enough for inspection without shipping zod internals. */
export function describeSchema(s: z.ZodTypeAny | undefined): Record<string, string> {
  if (!s) return {};
  let d = (s as unknown as { _def: { typeName: string; shape?: () => Record<string, z.ZodTypeAny>; schema?: z.ZodTypeAny; innerType?: z.ZodTypeAny } })._def;
  while (d.typeName === "ZodEffects" && d.schema) d = (d.schema as unknown as { _def: typeof d })._def;
  if (d.typeName !== "ZodObject" || !d.shape) return { value: d.typeName.replace(/^Zod/, "").toLowerCase() };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.shape())) {
    let t = v as unknown as { _def: typeof d; isOptional(): boolean };
    const opt = t.isOptional();
    while (t._def.innerType) t = t._def.innerType as unknown as typeof t;
    out[k] = `${t._def.typeName.replace(/^Zod/, "").toLowerCase()}${opt ? "?" : ""}`;
  }
  return out;
}

const risk = (t: ToolDefinition): RegistryEntry["risk_level"] => (t.destructive || t.requiresConfirmation ? "high" : t.readOnly ? "low" : "medium");

function entry(t: ToolDefinition, aliasOf: string | null): RegistryEntry {
  const target = aliasOf ? getTool(aliasOf) : t;
  return {
    tool_id: `tool.${t.name}`, tool_name: t.name, category: t.category, family: (toolCatalog.get(aliasOf ?? t.name) ?? "catalog/unknown").split("#")[1] ?? t.category,
    description: t.description, input_schema: describeSchema(t.inputSchema), output_schema: t.outputSchema ? describeSchema(t.outputSchema) : null,
    permissions: [...t.requiredPermissions], handler: aliasOf ? `alias → ${aliasOf}` : `${toolCatalog.get(t.name) ?? "?"}:${t.name}`,
    enabled: !disabledTools.has(t.name) && !(aliasOf && disabledTools.has(aliasOf)), version: REGISTRY_VERSION, risk_level: risk(t),
    timeout_ms: t.timeoutMs, retry_policy: t.retryPolicy, alias_of: aliasOf, status: typeof target?.handler === "function" ? "ok" : "invalid",
  };
}

export function buildRegistry(): RegistryEntry[] {
  loadTools();
  const real = allTools().map((t) => entry(t, null));
  const aliases = allAliases().map((a) => { const t = getTool(a.name)!; return entry(t, (t.aliasOf ?? a.target) as string); });
  return [...real, ...aliases];
}

/** Validation: unique ids/names, resolvable handlers, object schemas, write tools declare permissions, nothing dropped. */
export function validateRegistry(entries: RegistryEntry[] = buildRegistry()) {
  const errors: string[] = [];
  const ids = new Set<string>(); const names = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.tool_id)) errors.push(`duplicate id ${e.tool_id}`); ids.add(e.tool_id);
    if (names.has(e.tool_name)) errors.push(`duplicate name ${e.tool_name}`); names.add(e.tool_name);
    if (e.status !== "ok") errors.push(`unresolved handler ${e.tool_name}`);
    if (e.risk_level !== "low" && !e.permissions.length) errors.push(`${e.tool_name} writes without permissions`);
    if (!e.alias_of && !toolCatalog.has(e.tool_name)) errors.push(`${e.tool_name} has no source catalog`);
  }
  const sourceCount = [...toolCatalog.keys()].length;
  const realCount = entries.filter((e) => !e.alias_of).length;
  if (sourceCount !== realCount) errors.push(`registry has ${realCount} tools but source defines ${sourceCount}`);
  return { ok: !errors.length, errors, tools: realCount, aliases: entries.length - realCount, total: entries.length };
}

export const registryToolId = (name: string) => `tool.${getTool(name)?.name ?? name}`;
