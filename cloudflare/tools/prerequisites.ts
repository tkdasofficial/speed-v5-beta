// Prerequisite engine (spec §11): checked before every execution; failures tell the agent which tool resolves them.
import type { ToolDefinition, ToolEnv } from "./types";
import { ToolFailure } from "./types";

type Check = (env: ToolEnv) => Promise<void>;

const checks: Record<string, Check> = {
  has_files: async (env) => {
    if (!(await env.files()).list().length) throw new ToolFailure("PREREQUISITE_FAILED", "The project has no files yet", false, undefined, "generate_file");
  },
  build_config: async (env) => {
    const s = await env.files();
    const pkg = s.get("package.json");
    if (pkg) {
      try { const j = JSON.parse(pkg.content) as { scripts?: Record<string, string> }; if (!j.scripts?.["build"]) throw new Error(); }
      catch { throw new ToolFailure("PREREQUISITE_FAILED", "package.json is invalid or has no build script", false, undefined, "update_project_config"); }
      return;
    }
    if (!s.get("index.html")) throw new ToolFailure("PREREQUISITE_FAILED", "No build configuration: add index.html (static) or package.json with a build script", false, undefined, "generate_file");
  },
  verified_build: async (env) => {
    const st = await env.settings();
    if (st["buildStatus"] !== "ready" && st["buildStatus"] !== "unchanged" && !st["staticFileId"]) throw new ToolFailure("PREREQUISITE_FAILED", "No verified build exists yet", false, undefined, "run_production_build");
  },
  repo_linked: async (env) => {
    const { d1 } = await import("@backend/d1");
    const [r] = await d1<{ full_name: string }>("SELECT full_name FROM project_repos WHERE project_id = ? AND user_id = ?", [env.projectId, env.userId]);
    if (!r) throw new ToolFailure("PREREQUISITE_FAILED", "No GitHub repository is linked to this project", false, undefined, "connect_integration");
  },
  github_auth: async (env) => {
    const { getGithubAccessToken } = await import("@security/github.server");
    try { await getGithubAccessToken(env.userId); } catch { throw new ToolFailure("PREREQUISITE_FAILED", "GitHub is not connected (or needs reconnecting)", false, undefined, "connect_integration"); }
  },
  database_connected: async (env) => {
    const st = await env.settings();
    if (typeof st["supabaseProjectRef"] !== "string" || !st["supabaseProjectRef"]) throw new ToolFailure("PREREQUISITE_FAILED", "No database is configured for this project — connect Supabase and set supabaseProjectRef via update_integration_config", false, undefined, "update_integration_config");
  },
};

export async function checkPrerequisites(tool: ToolDefinition, env: ToolEnv) {
  for (const p of tool.prerequisites) {
    const c = checks[p];
    if (!c) throw new ToolFailure("UNKNOWN_ERROR", `Unknown prerequisite ${p}`);
    await c(env);
  }
}
export const PREREQUISITES = Object.keys(checks);
