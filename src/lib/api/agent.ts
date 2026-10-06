// Agent Core client. Types come from the backend handlers (type-only import).
import type * as A from "../../../cloudflare/functions/api/agent";
import { endpoint } from "./index";

export const agentStart = endpoint<typeof A.agentStart>("agentStart");
export const agentRun = endpoint<typeof A.agentRun>("agentRun");
export const agentRuns = endpoint<typeof A.agentRuns>("agentRuns");
export const agentSteps = endpoint<typeof A.agentSteps>("agentSteps");
export const agentMessages = endpoint<typeof A.agentMessages>("agentMessages");
export const agentToolCalls = endpoint<typeof A.agentToolCalls>("agentToolCalls");
export const agentResult = endpoint<typeof A.agentResult>("agentResult");
export const agentCancel = endpoint<typeof A.agentCancel>("agentCancel");
export const agentResume = endpoint<typeof A.agentResume>("agentResume");
