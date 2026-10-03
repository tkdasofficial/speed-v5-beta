// Tool system bootstrap: registers every catalog once. Import this (not the catalogs) to use the system.
import { registerTool, allTools } from "./registry";
import { fileTools } from "./catalog/files";
import { coreTools } from "./catalog/core";
import type { ToolDefinition } from "./types";

let loaded = false;
export function loadTools() {
  if (loaded) return allTools();
  for (const t of [...fileTools, ...coreTools] as unknown as ToolDefinition[]) registerTool(t);
  loaded = true;
  return allTools();
}
export { ToolSession } from "./orchestrator";
