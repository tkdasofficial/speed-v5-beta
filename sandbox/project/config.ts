import type { FileStore } from "../types/filesystem";
import type { ProjectConfig } from "../types/project";
import { detectPackageManager } from "../dependencies/lockfile";
import { readManifest } from "./manifest";
/** Derives project configuration from workspace files. */
export function resolveConfig(store: FileStore): ProjectConfig {
  const m = readManifest(store);
  const deps = { ...m?.dependencies, ...m?.devDependencies };
  const framework = deps["@tanstack/react-start"] ? "tanstack-start" : deps["next"] ? "next" : deps["vite"] ? "vite" : undefined;
  const build = m?.scripts["build"] !== undefined ? "build" : undefined;
  return { name: m?.name || "project", packageManager: detectPackageManager(store) ?? "bun", outputDir: ".output", ...(framework ? { framework } : {}), ...(build ? { buildCommand: build } : {}) };
}
