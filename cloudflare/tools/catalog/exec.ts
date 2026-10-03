// Execution tools: every command really runs in the isolated GitHub Actions runtime (functions/build/jobs.server.ts).
// Tools start an async job and return its jobId; get_command_result / wait_for_command read the real outcome.
import { defineTool } from "../registry";
import { z, ToolFailure } from "./util";
import { parseCommand } from "../policy";
import type { ToolEnv } from "../types";

type Kind = "install" | "build" | "typecheck" | "lint" | "test" | "format" | "script" | "command" | "dev";
async function start(env: ToolEnv, kind: Kind, script?: string, extra: { argv?: string[]; timeoutSec?: number } = {}) {
  const j = await import("../../functions/build/jobs.server");
  try {
    const r = await j.startJob(env.userId, env.projectId!, kind, { ...(script ? { script } : {}), ...extra, operationId: env.operationId });
    return { data: { ...r, note: "Runs asynchronously in an isolated runtime; call wait_for_command with this jobId." }, stateChanges: [{ kind: "task" as const, target: r.jobId, detail: `${kind} queued` }], next: "wait_for_command" };
  } catch (e) {
    if (e instanceof j.JobError) throw new ToolFailure(e.status === 409 ? "CONFLICT" : e.status === 503 ? "INTEGRATION_FAILED" : "COMMAND_FAILED", e.message, e.status >= 500);
    throw e;
  }
}
const ex = (name: string, kind: Kind, description: string, capabilities: string[]) => defineTool({
  name, category: "execution", description, capabilities, readOnly: kind !== "format" && kind !== "install", requiredPermissions: ["build:run"], timeoutMs: 20_000,
  inputSchema: z.object({}), handler: async (_a, env) => start(env, kind),
});

async function read(env: ToolEnv, jobId: string) {
  const { getJob } = await import("../../functions/build/jobs.server");
  const r = await getJob(env.userId, env.projectId!, jobId);
  if (!r) throw new ToolFailure("INVALID_ARGUMENT", `No command ${jobId} in this project`);
  return r;
}
const done = (s: string) => s === "succeeded" || s === "failed" || s === "expired";
const shape = (r: Awaited<ReturnType<typeof read>>) => ({ ...r, output: (r.output ?? "").slice(-8000), stdout: r.stdout?.slice(-8000) ?? null, stderr: r.stderr?.slice(-8000) ?? null });
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((res) => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });
/** Polls a job until `stop(job)` holds or the deadline passes. */
async function poll(env: ToolEnv, jobId: string, ms: number, stop: (r: Awaited<ReturnType<typeof read>>) => boolean) {
  const until = Date.now() + ms;
  let r = await read(env, jobId);
  while (!stop(r) && Date.now() < until && !env.signal.aborted) { await pause(3000, env.signal); r = await read(env, jobId); }
  return r;
}

export const execTools = [
  ex("install_dependencies", "install", "Run npm install in the isolated runtime and save the resulting package-lock.json.", ["npm install", "lockfile"]),
  ex("run_build", "build", "Run the real production build (vite build / npm run build) to check it compiles. Does not publish; use run_production_build to update the preview.", ["compile", "build check"]),
  ex("run_typecheck", "typecheck", "Run the TypeScript compiler (tsc --noEmit) and return file/line diagnostics.", ["tsc", "type errors"]),
  ex("run_linter", "lint", "Run ESLint with the project's config and return diagnostics.", ["eslint", "lint"]),
  ex("run_tests", "test", "Run the project's test script (npm test) and return the real output.", ["vitest", "jest", "tests"]),
  ex("run_formatter", "format", "Run Prettier over the project and save the reformatted files as one revision.", ["prettier"]),
  defineTool({
    name: "run_script", category: "execution", description: "Run one package.json script (npm run <script>) in the isolated runtime.", requiredPermissions: ["build:run"], timeoutMs: 20_000,
    inputSchema: z.object({ script: z.string().regex(/^[a-z0-9:_-]{1,60}$/i) }),
    handler: async (a, env) => {
      const pkg = (await env.files()).get("package.json");
      const scripts = pkg ? ((JSON.parse(pkg.content) as { scripts?: Record<string, string> }).scripts ?? {}) : {};
      if (!scripts[a.script]) throw new ToolFailure("INVALID_ARGUMENT", `package.json has no "${a.script}" script (has: ${Object.keys(scripts).join(", ") || "none"})`);
      return start(env, "script", a.script);
    },
  }),
  defineTool({
    name: "run_command", category: "execution", requiredPermissions: ["build:run"], capabilities: ["terminal", "shell", "exec", "npx", "node"], timeoutMs: 115_000,
    description: "Execute one command in this project's isolated GitHub runtime workspace and return its real stdout, stderr and exit code. No shell: allowed programs are npm (install/ci/run/test/ls/outdated/view/why/audit…), npx/bare project tools (tsc, vite, eslint, prettier, vitest, jest…) and node <project file>. Dependencies are installed (without install scripts) first. Waits up to waitSeconds; if still running, returns the jobId for wait_for_command.",
    purpose: "Run an arbitrary safe command against the project's own files in a throwaway workspace.",
    inputSchema: z.object({ command: z.string().min(1).max(500), timeoutSeconds: z.number().int().min(5).max(600).default(300), waitSeconds: z.number().int().min(0).max(100).default(90) }),
    handler: async (a, env) => {
      const parsed = parseCommand(a.command);
      const started = await start(env, "command", undefined, { argv: [parsed.program, ...parsed.args], timeoutSec: a.timeoutSeconds });
      const jobId = started.data.jobId;
      const r = a.waitSeconds ? await poll(env, jobId, a.waitSeconds * 1000, (x) => done(x.status)) : await read(env, jobId);
      const data = { command: parsed.display, ...shape(r), jobId };
      if (!done(r.status)) return { data, warnings: ["Still running — call wait_for_command with this jobId."], stateChanges: started.stateChanges, next: "wait_for_command" };
      if (r.status !== "succeeded") throw new ToolFailure(r.exitCode === 124 ? "TIMEOUT" : "COMMAND_FAILED", `${parsed.display} ${r.status === "expired" ? "expired before finishing" : `exited with code ${r.exitCode}`}`, false, data, "diagnose_failure");
      return { data, stateChanges: started.stateChanges };
    },
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
    name: "run_dev_server", category: "execution", requiredPermissions: ["build:run"], capabilities: ["dev server", "npm run dev", "vite dev", "start server"], timeoutMs: 115_000, readOnly: false, idempotent: false, supportsParallelExecution: false,
    description: "Start the project's development server (npm run dev, Vite, or a static file server for plain HTML) as a tracked process in the isolated runtime. Waits for it to answer HTTP, returns the process jobId, startup logs and state. It runs at most 12 minutes; it is not the preview (use run_production_build + open_preview for that). Stop it with cancel via the jobId.",
    purpose: "Check that the dev server starts and capture its startup logs.",
    inputSchema: z.object({ startupTimeoutSeconds: z.number().int().min(15).max(180).default(90), waitSeconds: z.number().int().min(0).max(105).default(100) }),
    handler: async (a, env) => {
      const s = await env.files();
      const pkg = s.get("package.json");
      const p = pkg ? (JSON.parse(pkg.content) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }) : null;
      const hasVite = !!(p?.dependencies?.["vite"] ?? p?.devDependencies?.["vite"]);
      const how = p?.scripts?.["dev"] ? "npm run dev" : hasVite ? "vite" : s.get("index.html") ? "static server" : null;
      if (!how) throw new ToolFailure("INVALID_ARGUMENT", "This project has no dev script, no Vite dependency and no index.html, so there is no dev server to start.", false, { supported: false });
      const j = await import("../../functions/build/jobs.server");
      const current = await j.latestDevServer(env.userId, env.projectId);
      if (current && (current.status === "queued" || current.status === "running")) return { data: { ...shape(current), jobId: current.id, alreadyRunning: true }, warnings: ["A dev server is already running for this project."] };
      const started = await start(env, "dev", undefined, { timeoutSec: a.startupTimeoutSeconds });
      const jobId = started.data.jobId;
      const r = a.waitSeconds ? await poll(env, jobId, a.waitSeconds * 1000, (x) => done(x.status) || x.phase === "ready" || x.phase === "failed") : await read(env, jobId);
      const data = { detected: how, ...shape(r), jobId };
      if (r.phase === "failed" || r.status === "failed" || r.status === "expired") throw new ToolFailure("COMMAND_FAILED", `Dev server failed to start (${how})`, false, data, "diagnose_failure");
      if (r.phase !== "ready") return { data, warnings: ["Still starting — check again with get_command_result."], stateChanges: started.stateChanges, next: "get_command_result" };
      return { data, stateChanges: [{ kind: "task", target: jobId, detail: "dev server ready" }] };
    },
  }),
];
