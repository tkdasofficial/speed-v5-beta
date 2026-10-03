import { SandboxError } from "../utils/errors";
import type { Terminal } from "../terminal/terminal";
import type { TerminalProcess } from "../terminal/process";
import type { PackageManager } from "./package-manager";
import { isValidPackageName } from "./registry";
/** Builds and runs an install command through the terminal (requires an executor). */
export function installDependencies(terminal: Terminal, pm: PackageManager, pkgs: readonly string[] = [], dev = false): TerminalProcess {
  const bad = pkgs.find((p) => !isValidPackageName(p.replace(/@[^@/]+$/, "")));
  if (bad) throw new SandboxError("INVALID_PATH", `Invalid package name: ${bad}`);
  return terminal.run(pm.installCommand(pkgs, dev));
}
