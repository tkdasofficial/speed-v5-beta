// Pre-flight for execute_parallel (pure, unit-tested): every call is checked before any call runs.
import { getTool } from "./registry";
import { checkPolicy, grantedPermissions } from "./policy";
import { ToolFailure } from "./types";

const ORCHESTRATORS = new Set(["execute_parallel", "execute_sequence", "retry_operation", "recover_project"]);
const RESOURCE_KEYS = ["path", "from", "to", "dir", "name", "id", "jobId", "operationId"];

export interface ParallelCall { tool: string; args: Record<string, unknown>; required?: boolean }
export interface Rejection { index: number; tool: string; code: "UNKNOWN_TOOL" | "INVALID_ARGUMENT" | "PERMISSION_DENIED" | "SECURITY_BLOCKED" | "CONFLICT" | "CONFIRMATION_REQUIRED"; reason: string }

/** Resources a call writes (file paths, ids…), so two writers of the same thing never run concurrently. */
function resources(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of RESOURCE_KEYS) if (typeof args[k] === "string") out.push(`${k === "from" || k === "to" ? "path" : k}:${String(args[k]).replace(/^\.?\/+/, "")}`);
  if (Array.isArray(args["paths"])) for (const p of args["paths"]) if (typeof p === "string") out.push(`path:${p}`);
  return out;
}

export function planParallel(calls: ParallelCall[], ctx: { projectId: string; readOnly: boolean; confirmed: boolean }) {
  const rejected: Rejection[] = [];
  const writes = new Map<string, number>();
  const seen = new Map<string, number>();
  calls.forEach((c, index) => {
    const tool = getTool(c.tool);
    if (!tool) return rejected.push({ index, tool: c.tool, code: "UNKNOWN_TOOL", reason: "unknown tool (use exact tool names)" });
    if (ORCHESTRATORS.has(tool.name)) return rejected.push({ index, tool: c.tool, code: "INVALID_ARGUMENT", reason: "orchestration tools cannot be nested in execute_parallel" });
    if (!tool.supportsParallelExecution) return rejected.push({ index, tool: c.tool, code: "INVALID_ARGUMENT", reason: "tool is not parallel-safe; use execute_sequence" });
    try { checkPolicy({ tool, args: c.args, projectId: ctx.projectId, readOnly: ctx.readOnly, confirmed: ctx.confirmed, granted: grantedPermissions(ctx.readOnly) }); }
    catch (e) { const f = e as ToolFailure; return rejected.push({ index, tool: c.tool, code: (f.code as Rejection["code"]) ?? "PERMISSION_DENIED", reason: f.message }); }
    const { confirm: _c, projectId: _p, ...rest } = c.args;
    const parsed = tool.inputSchema.safeParse(rest);
    if (!parsed.success) return rejected.push({ index, tool: c.tool, code: "INVALID_ARGUMENT", reason: parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ").slice(0, 300) });
    const key = `${tool.name}:${JSON.stringify(rest)}`;
    if (seen.has(key)) return rejected.push({ index, tool: c.tool, code: "CONFLICT", reason: `duplicate of call #${seen.get(key)}` });
    seen.set(key, index);
    if (!tool.readOnly) {
      for (const r of resources(rest)) {
        if (writes.has(r)) return rejected.push({ index, tool: c.tool, code: "CONFLICT", reason: `writes ${r} which call #${writes.get(r)} also writes` });
        writes.set(r, index);
      }
    }
    return undefined;
  });
  return { rejected };
}
