// Background tasks + server codebase client. Types come from the backend handlers (type-only import).
import type * as T from "../../../cloudflare/functions/api/tasks";
import type * as F from "../../../cloudflare/functions/api/files";
import { endpoint } from "./index";

export const createBgTask = endpoint<typeof T.createBgTask>("createBgTask");
export const getBgTask = endpoint<typeof T.getBgTask>("getBgTask");
export const listBgTasks = endpoint<typeof T.listBgTasks>("listBgTasks");
export const bgTaskEvents = endpoint<typeof T.bgTaskEvents>("bgTaskEvents");
export const decideAgentPlan = endpoint<typeof T.decideAgentPlan>("decideAgentPlan");
export const startProject = endpoint<typeof T.startProject>("startProject");
export const cancelBgTask = endpoint<typeof T.cancelBgTask>("cancelBgTask");
export const sbTree = endpoint<typeof F.sbTree>("sbTree");
export const sbOp = endpoint<typeof F.sbOp>("sbOp");
export const sbImport = endpoint<typeof F.sbImport>("sbImport");
export const sbRevisions = endpoint<typeof F.sbRevisions>("sbRevisions");
export const sbCopyProject = endpoint<typeof F.sbCopyProject>("sbCopyProject");
import type * as B from "../../../cloudflare/functions/api/build";
export const startPreviewBuild = endpoint<typeof B.startPreviewBuild>("startPreviewBuild");
export const openPreviewSession = endpoint<typeof B.openPreviewSession>("openPreviewSession");
export const closePreviewSession = endpoint<typeof B.closePreviewSession>("closePreviewSession");
export const previewBuildStatus = endpoint<typeof B.previewBuildStatus>("previewBuildStatus");
