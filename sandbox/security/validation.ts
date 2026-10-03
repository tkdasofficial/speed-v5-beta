import { SandboxError } from "../utils/errors";
import { normalizePath } from "../utils/paths";
import type { SandboxPermission, PermissionSet } from "./permissions";
const BLOCKED = [/^\.git(\/|$)/, /(^|\/)\.env(\.|$)/];
/** Validates a path for a given operation; returns the normalized path. */
export function validatePath(path: string): string {
  const p = normalizePath(path);
  if (BLOCKED.some((r) => r.test(p))) throw new SandboxError("FORBIDDEN", `Protected path: ${p}`);
  return p;
}
export function requirePermission(perms: PermissionSet, p: SandboxPermission): void {
  if (!perms.has(p)) throw new SandboxError("FORBIDDEN", `Missing permission ${p}`);
}
