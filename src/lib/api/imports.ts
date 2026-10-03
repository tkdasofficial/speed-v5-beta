// Project import client — every call goes to the Speed API Worker.
import type * as I from "../../../cloudflare/functions/api/imports";
import { endpoint } from "./index";

export const importInspectUrl = endpoint<typeof I.importInspectUrl>("importInspectUrl");
export const importFromUrl = endpoint<typeof I.importFromUrl>("importFromUrl");
export const importGithubRepo = endpoint<typeof I.importGithubRepo>("importGithubRepo");
export const importLocalStart = endpoint<typeof I.importLocalStart>("importLocalStart");
export const importLocalBatch = endpoint<typeof I.importLocalBatch>("importLocalBatch");
export const importLocalFinish = endpoint<typeof I.importLocalFinish>("importLocalFinish");
export const importLocalAbort = endpoint<typeof I.importLocalAbort>("importLocalAbort");
export const listProjectFiles = endpoint<typeof I.listProjectFiles>("listProjectFiles");
export const getProjectFile = endpoint<typeof I.getProjectFile>("getProjectFile");
