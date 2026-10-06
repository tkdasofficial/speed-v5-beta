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
import { buildArtifactTools, integrationControlTools, taskControlTools } from "./catalog/platform";
import { registerCanonicalAliases } from "./aliases";
import type { ToolDefinition } from "./types";

let loaded = false;
/** Catalog (source module) each production tool comes from — the handler reference shown by the Agent Tool Registry. */
export const toolCatalog = new Map<string, string>();
const CATALOGS: [string, readonly unknown[]][] = [
  ["catalog/files", fileTools], ["catalog/core", coreTools], ["catalog/git", gitTools], ["catalog/deps#dependencies", depTools], ["catalog/deps#environment", envTools],
  ["catalog/state#state", stateTools], ["catalog/state#planning", planningTools], ["catalog/state#knowledge", knowledgeTools], ["catalog/ops#logs", logTools],
  ["catalog/ops#security", securityTools], ["catalog/ops#cleanup", cleanupTools], ["catalog/ops#recovery", recoveryTools], ["catalog/ops#integrations", integrationTools],
  ["catalog/ops#orchestration", orchestrationTools], ["catalog/transform#transform", transformTools], ["catalog/transform#assets", assetTools], ["catalog/exec", execTools],
  ["catalog/platform#build", buildArtifactTools], ["catalog/platform#integrations", integrationControlTools], ["catalog/platform#tasks", taskControlTools],
];
export function loadTools() {
  if (loaded) return allTools();
  for (const [cat, list] of CATALOGS) for (const t of list as unknown as ToolDefinition[]) { registerTool(t); toolCatalog.set(t.name, cat); }
  registerCanonicalAliases();
  loaded = true;
  return allTools();
}
export { ToolSession } from "./orchestrator";
