// Agent D1 access (binding AGENT_DB). Stores agent runtime state only — references and summaries, never project code or secrets.
import { ctx } from "@backend/context";
import { AgentStore, type D1Like } from "./store";

export function agentStore(): AgentStore {
  const b = ctx().env["AGENT_DB"] as D1Like | undefined;
  if (!b) throw new Error("AGENT_DB binding missing");
  return new AgentStore(b);
}
export { safeJson } from "./store";
