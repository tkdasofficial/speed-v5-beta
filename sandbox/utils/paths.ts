import { SandboxError } from "./errors";
import type { WorkspacePath } from "../types/filesystem";
/** Normalizes a workspace path and rejects escapes outside the workspace root. */
export function normalizePath(input: string): WorkspacePath {
  const parts: string[] = [];
  for (const seg of input.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (!parts.length) throw new SandboxError("INVALID_PATH", `Path escapes workspace: ${input}`); parts.pop(); continue; }
    parts.push(seg);
  }
  if (!parts.length) throw new SandboxError("INVALID_PATH", "Empty path");
  return parts.join("/");
}
export const dirname = (p: WorkspacePath): string => p.split("/").slice(0, -1).join("/");
export const basename = (p: WorkspacePath): string => p.split("/").pop() ?? p;
export const joinPath = (...parts: string[]): WorkspacePath => normalizePath(parts.join("/"));
export const isWithin = (child: WorkspacePath, parent: WorkspacePath): boolean => child === parent || child.startsWith(`${parent}/`);
