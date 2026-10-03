// Tool system bootstrap: registers every catalog once. Import this (not the catalogs) to use the system.
import { registerTool, allTools } from "./registry";
import { fileTools } from "./catalog/files";
import { coreTools } from "./catalog/core";
import { gitTools } from "./catalog/git";
import { depTools, envTools } from "./catalog/deps";
import { stateTools, planningTools, knowledgeTools } from "./catalog/state";
import { logTools, securityTools, cleanupTools, recoveryTools, integrationTools, orchestrationTools } from "./catalog/ops";
import { transformTools, assetTools } from "./catalog/transform";
import { execTools } from "./catalog/exec";
import type { ToolDefinition } from "./types";

let loaded = false;
export function loadTools() {
  if (loaded) return allTools();
  for (const t of [...fileTools, ...coreTools, ...gitTools, ...depTools, ...envTools, ...stateTools, ...planningTools, ...knowledgeTools, ...logTools, ...securityTools, ...cleanupTools, ...recoveryTools, ...integrationTools, ...orchestrationTools, ...transformTools, ...assetTools, ...execTools] as unknown as ToolDefinition[]) registerTool(t);
  loaded = true;
  return allTools();
}
export { ToolSession } from "./orchestrator";
