import type { FileStore } from "../types/filesystem";
import type { PackageManagerName } from "../types/project";
import { PACKAGE_MANAGERS } from "./package-manager";
/** Detects the package manager from whichever lockfile is present in the workspace. */
export function detectPackageManager(store: FileStore): PackageManagerName | null {
  for (const pm of Object.values(PACKAGE_MANAGERS)) if (store.get(pm.lockfile)) return pm.name;
  return null;
}
