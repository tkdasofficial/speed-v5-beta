export type SandboxPermission = "fs:read" | "fs:write" | "terminal:run" | "deps:install" | "process:manage";
export interface PermissionSet { has(p: SandboxPermission): boolean }
export function permissionSet(granted: readonly SandboxPermission[]): PermissionSet {
  const s = new Set(granted);
  return { has: (p) => s.has(p) };
}
