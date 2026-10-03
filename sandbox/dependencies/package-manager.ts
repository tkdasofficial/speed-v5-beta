import type { PackageManagerName } from "../types/project";
import type { CommandSpec } from "../types/terminal";
export interface PackageManager { name: PackageManagerName; lockfile: string; installCommand(pkgs?: readonly string[], dev?: boolean): CommandSpec }
const make = (name: PackageManagerName, lockfile: string, add: string, devFlag: string): PackageManager => ({
  name, lockfile,
  installCommand: (pkgs = [], dev = false) => ({ program: name, args: pkgs.length ? [add, ...(dev ? [devFlag] : []), ...pkgs] : ["install"], cwd: "." }),
});
export const PACKAGE_MANAGERS: Record<PackageManagerName, PackageManager> = {
  bun: make("bun", "bun.lock", "add", "-d"),
  npm: make("npm", "package-lock.json", "install", "-D"),
  pnpm: make("pnpm", "pnpm-lock.yaml", "add", "-D"),
  yarn: make("yarn", "yarn.lock", "add", "-D"),
};
