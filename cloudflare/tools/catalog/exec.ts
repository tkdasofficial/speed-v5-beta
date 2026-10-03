// Execution tools: every command really runs in the isolated GitHub Actions runtime (functions/build/jobs.server.ts).
// Tools start an async job and return its jobId; get_command_result / wait_for_command read the real outcome.
import { defineTool } from "../registry";
import { z, ToolFailure } from "./util";
import { resolveCommand } from "../policy";
import type { ToolEnv } from "../types";

type Kind = "install" | "build" | "typecheck" | "lint" | "test" | "format" | "script";
async function start(env: ToolEnv, kind: Kind, script?: string) {
  const j = await import("../../functions/build/jobs.server");
  try {
    const r = await j.startJob(env.userId, env.projectId!, kind, { ...(script ? { script } : {}), operationId: env.operationId });
    return { data: { ...r, note: "Runs asynchronously in an isolated runtime; call wait_for_command with this jobId." }, stateChanges: [{ kind: "task" as const, target: r.jobId, detail: `${kind} queued` }], next: "wait_for_command" };
  } catch (e) {
    if (e instanceof j.JobError) throw new ToolFailure(e.status === 409 ? "CONFLICT" : e.status === 503 ? "INTEGRATION_FAILED" : "EXECUTION_FAILED", e.message, e.status >= 500);
    throw e;
  }
}
const ex = (name: string, kind: Kind, description: string, capabilities: string[]) => defineTool({
  name, category: "execution", description, capabilities, readOnly: kind !== "format" && kind !== "install", requiredPermissions: ["project:execute"], timeoutMs: 20_000,
  inputSchema: z.object({}), handler: async (_a, env) => start(env, kind),
});

async function read(env: ToolEnv, jobId: string) {
  const { getJob } = await import("../../functions/build/jobs.server");
  const r = await getJob(env.userId, env.projectId!, jobId);
  if (!r) throw new ToolFailure("NOT_FOUND", `No command ${jobId} in this project`);
  return r;
}
const done = (s: string) => s === "succeeded" || s === "failed" || s === "expired";
const shape = (r: Awaited<ReturnType<typeof read>>) => ({ ...r, output: (r.output ?? "").slice(-8000) });

export const execTools = [
  ex("install_dependencies", "install", "Run npm install in the isolated runtime and save the resulting package-lock.json.", ["npm install", "lockfile"]),
  ex("run_build", "build", "Run the real production build (vite build / npm run build) to check it compiles. Does not publish; use run_production_build to update the preview.", ["compile", "build check"]),
  ex("run_typecheck", "typecheck", "Run the TypeScript compiler (tsc --noEmit) and return file/line diagnostics.", ["tsc", "type errors"]),
  ex("run_linter", "lint", "Run ESLint with the project's config and return diagnostics.", ["eslint", "lint"]),
  ex("run_tests", "test", "Run the project's test script (npm test) and return the real output.", ["vitest", "jest", "tests"]),
  ex("run_formatter", "format", "Run Prettier over the project and save the reformatted files as one revision.", ["prettier"]),
  defineTool({
    name: "run_script", category: "execution", description: "Run one package.json script (npm run <script>) in the isolated runtime.", requiredPermissions: ["project:execute"], timeoutMs: 20_000,
    inputSchema: z.object({ script: z.string().regex(/^[a-z0-9:_-]{1,60}$/i) }),
    handler: async (a, env) => {
      const { loadStore } = await import("../../sandbox/fs.server");
      const pkg = (await env.files()).get("package.json"); void loadStore;
      const scripts = pkg ? ((JSON.parse(pkg.content) as { scripts?: Record<string, string> }).scripts ?? {}) : {};
      if (!scripts[a.script]) throw new ToolFailure("NOT_FOUND", `package.json has no "${a.script}" script (has: ${Object.keys(scripts).join(", ") || "none"})`);
      return start(env, "script", a.script);
    },
  }),
  defineTool({
    name: "run_command", category: "execution", description: "Run a shell-style command. Only safe, known commands are accepted (npm install/build/test/lint, tsc, npm run <script>, npm install <pkg>, git status/diff/log); each maps to its dedicated tool.", requiredPermissions: ["project:execute"], capabilities: ["terminal", "shell"],
    inputSchema: z.object({ command: z.string().min(1).max(200) }),
    handler: async (a) => { const m = resolveCommand(a.command); return { data: { resolvedTool: m.tool, args: m.args ?? {} }, next: m.tool }; },
  }),
  defineTool({
    name: "get_command_result", category: "execution", description: "Status, exit code, output tail and diagnostics of a command job.",
    inputSchema: z.object({ jobId: z.string().regex(/^job_\w+$/) }),
    handler: async (a, env) => ({ data: shape(await read(env, a.jobId)) }),
  }),
  defineTool({
    name: "wait_for_command", category: "execution", description: "Wait (up to ~50s) for a command job to finish and return its real result. Call again if still running.", timeoutMs: 60_000,
    inputSchema: z.object({ jobId: z.string().regex(/^job_\w+$/), seconds: z.number().int().min(1).max(50).default(45) }),
    handler: async (a, env) => {
      const until = Date.now() + a.seconds * 1000;
      let r = await read(env, a.jobId);
      while (!done(r.status) && Date.now() < until && !env.signal?.aborted) { await new Promise((x) => setTimeout(x, 3000)); r = await read(env, a.jobId); }
      if (r.status === "failed") return { data: shape(r), warnings: [`${r.kind} failed with exit code ${r.exitCode}`], next: r.diagnostics.length ? "read_file" : "diagnose_failure" };
      return { data: shape(r), ...(done(r.status) ? {} : { next: "wait_for_command" }) };
    },
  }),
  defineTool({
    name: "run_dev_server", category: "execution", description: "There is no long-running dev server; this builds the project and opens a live preview session instead.", requiredPermissions: ["project:execute"],
    inputSchema: z.object({}),
    handler: async () => ({ data: { note: "Use run_production_build, then open_preview." }, next: "run_production_build" }),
  }),
];
