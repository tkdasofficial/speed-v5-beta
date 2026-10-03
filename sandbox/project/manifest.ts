import type { FileStore } from "../types/filesystem";
import type { ProjectManifest } from "../types/project";
const rec = (v: unknown): Record<string, string> => (v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string> : {});
/** Reads package.json from the workspace root (.local/package.json). */
export function readManifest(store: FileStore): ProjectManifest | null {
  const f = store.get("package.json");
  if (!f) return null;
  try {
    const j = JSON.parse(f.content) as Record<string, unknown>;
    return { name: String(j["name"] ?? ""), version: String(j["version"] ?? "0.0.0"), dependencies: rec(j["dependencies"]), devDependencies: rec(j["devDependencies"]), scripts: rec(j["scripts"]) };
  } catch { return null; }
}
