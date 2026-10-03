import type { Logger } from "../utils/logger";
import { silentLogger } from "../utils/logger";
import type { PermissionSet } from "../security/permissions";
import { permissionSet } from "../security/permissions";
import type { CommandPolicy } from "../security/command-policy";
import { allowListPolicy } from "../security/command-policy";
let n = 0;
export const uid = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${(n++).toString(36)}`;
/** Dependencies shared by every sandbox module. */
export interface SandboxContext { projectId: string; userId: string; logger: Logger; permissions: PermissionSet; commandPolicy: CommandPolicy }
export function createContext(projectId: string, userId: string, overrides: Partial<Omit<SandboxContext, "projectId" | "userId">> = {}): SandboxContext {
  return {
    projectId, userId,
    logger: overrides.logger ?? silentLogger,
    permissions: overrides.permissions ?? permissionSet(["fs:read", "fs:write"]),
    commandPolicy: overrides.commandPolicy ?? allowListPolicy([]),
  };
}
