// Live-data client — calls the Speed API Worker. Types come from the backend handlers (type-only import).
import type * as S from "../../../cloudflare/functions/api/sync";
import { endpoint } from "./index";

export const getSnapshot = endpoint<typeof S.getSnapshot>("getSnapshot");
export const getChangesSince = endpoint<typeof S.getChangesSince>("getChangesSince");
export const getRealtimeTicket = endpoint<typeof S.getRealtimeTicket>("getRealtimeTicket");
export const getEntitlementsFn = endpoint<typeof S.getEntitlementsFn>("getEntitlementsFn");
export const createProject = endpoint<typeof S.createProject>("createProject");
export const updateProject = endpoint<typeof S.updateProject>("updateProject");
export const deleteProject = endpoint<typeof S.deleteProject>("deleteProject");
export const listMessages = endpoint<typeof S.listMessages>("listMessages");
export const sendMessage = endpoint<typeof S.sendMessage>("sendMessage");
export const createTask = endpoint<typeof S.createTask>("createTask");
export const updateTask = endpoint<typeof S.updateTask>("updateTask");
export const deleteTask = endpoint<typeof S.deleteTask>("deleteTask");
export const updateProfile = endpoint<typeof S.updateProfile>("updateProfile");
export const setState = endpoint<typeof S.setState>("setState");
export const agentStep = endpoint<typeof S.agentStep>("agentStep");
