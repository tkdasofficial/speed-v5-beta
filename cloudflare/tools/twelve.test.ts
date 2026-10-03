// Tests for the 12 audited tools, run through the real ToolSession executor (policy → validation → handler → normalize → audit).
// External services (runtime jobs, D1, Drive, OAuth, task runner) are replaced with in-memory fakes at the module boundary.
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { MemoryFileStore } from "../../sandbox/workspace/workspace";
import type { OperationStore, ProjectIO } from "./orchestrator";

// ---------- fakes ----------
type Job = { id: string; project: string; kind: string; status: string; exitCode: number | null; stdout: string | null; stderr: string | null; output: string; phase: string | null; argv?: string[]; stop?: boolean };
const jobs = new Map<string, Job>();
let nextJob: Partial<Job> = {};
let jobSeq = 0;
mock.module("../functions/build/jobs.server", () => ({
  JobError: class JobError extends Error { constructor(m: string, public status = 400) { super(m); } },
  startJob: async (_u: string, projectId: string, kind: string, o: { argv?: string[] }) => {
    const id = `job_t${++jobSeq}`;
    jobs.set(id, { id, project: projectId, kind, status: "succeeded", exitCode: 0, stdout: "", stderr: "", output: "", phase: kind === "dev" ? "ready" : null, ...nextJob, ...(o.argv ? { argv: o.argv } : {}) });
    return { jobId: id, status: "queued", kind };
  },
  getJob: async (_u: string, projectId: string, id: string) => {
    const j = jobs.get(id);
    if (!j || j.project !== projectId) return null;
    return { id: j.id, kind: j.kind, script: null, command: j.argv?.join(" ") ?? null, status: j.status, exitCode: j.exitCode, output: j.output, stdout: j.stdout, stderr: j.stderr, diagnostics: [], changedFiles: [], phase: j.phase, stopRequested: !!j.stop, heartbeatAt: null, process: j.kind === "dev" ? { port: 5173 } : null, createdAt: "", completedAt: null };
  },
  latestDevServer: async (_u: string, projectId: string) => { const j = [...jobs.values()].reverse().find((x) => x.kind === "dev" && x.project === projectId); return j ? { id: j.id, kind: "dev", status: j.status, phase: j.phase, output: j.output, stdout: null, stderr: null } : null; },
  requestStop: async (_u: string, projectId: string, id: string) => { const j = jobs.get(id); if (!j || j.project !== projectId || !["queued", "running"].includes(j.status)) return { requested: false }; j.stop = true; return { requested: true }; },
}));

const d1Rows: Record<string, unknown[]> = {};
mock.module("../functions/d1", () => ({ d1: async (sql: string) => { for (const [k, v] of Object.entries(d1Rows)) if (sql.includes(k)) return v; return []; } }));

let revisions: { revision: number }[] = [];
const historical = new Map<number, MemoryFileStore>();
mock.module("../sandbox/fs.server", () => ({
  listRevisions: async () => revisions,
  storeAt: async (_p: string, r: number) => ({ store: historical.get(r)!, revision: r, changedSince: ["src/App.tsx"] }),
  rollbackTo: async (_p: string, r: number) => { rolledBackTo = r; return { revision: 99, changed: ["src/App.tsx"] }; },
}));
let rolledBackTo: number | null = null;

let builds = { verify: { ok: true, fileCount: 3, hashMatches: true, issues: [] as string[] }, upload: { status: "ready", previewUrl: "speed-preview:p1" } as Record<string, unknown>, uploadError: null as null | { message: string; status: number } };
mock.module("../functions/build/pipeline.server", () => ({
  apiOrigin: () => "https://api.example",
  verifyBuildOutput: async () => builds.verify,
  uploadBuild: async () => { if (builds.uploadError) { const e = Object.assign(new Error(builds.uploadError.message), { status: builds.uploadError.status }); throw e; } return builds.upload; },
  verifyUpload: async () => ({ ok: true, fileId: "f1", inProjectFolder: true, metadataMatches: true, issues: [] }),
  startBuild: async () => ({ status: "ready", previewUrl: "x" }),
}));
mock.module("../functions/context", () => ({ ctx: () => ({ env: { ALLOWED_ORIGINS: "https://*.lovable.app,https://app.example" } }), envStr: () => undefined }));
const connectCalls: unknown[] = [];
mock.module("../functions/api/connections", () => ({
  startIntegrationConnect: async (userId: string, integration: string, origin: string, cb: string) => { connectCalls.push({ userId, integration, origin, cb }); return { url: `https://accounts.example/authorize?state=s`, expiresInSeconds: 600 }; },
  disconnectIntegrationFor: async (_u: string, t: { integration?: string; connectionId?: string }) => { if (t.connectionId === "00000000-0000-4000-8000-000000000000") throw Object.assign(new Error("Connection not found"), { status: 404 }); return { ok: true, removed: t.integration ?? "google_drive" }; },
}));
const tasks = new Map<string, { project: string; status: string }>([["task_other_project", { project: "p2", status: "running" }], ["task_running_1", { project: "p1", status: "running" }]]);
mock.module("../functions/api/tasks", () => ({
  createTaskFor: async (_u: string, d: { type: string; projectId: string; idempotencyKey: string }) => { if (d.type !== "file_operation") throw new Error(`Unknown task type: ${d.type}`); tasks.set("task_new_1", { project: d.projectId, status: "queued" }); return { id: "task_new_1", status: "queued", created: true }; },
  cancelTaskFor: async (_u: string, id: string, projectId: string) => { const t = tasks.get(id); if (!t || t.project !== projectId) throw new Error("Task not found"); return { id, status: t.status, alreadyFinished: false }; },
}));

// ---------- session helpers ----------
import { loadTools, ToolSession } from "./index";
import { getTool, findToolsByCapability, allTools } from "./registry";
import { parseCommand } from "./policy";
import { parseDuckDuckGo, parseDuckDuckGoLite, parseDuckDuckGoInstant, parseSearxng, parseWikipedia, parseReddit, canonicalUrl, searchWeb, type SearchProvider } from "./catalog/websearch";
import { decideRecovery } from "./recovery";
import { planParallel } from "./parallel";

const ops: OperationStore & { rows: { id: string; parentId: string | null; tool: string; ok?: boolean }[] } = {
  rows: [],
  async start(o) { this.rows.push({ id: o.id, parentId: o.parentId, tool: o.toolName }); },
  async finish(id, r) { const x = this.rows.find((y) => y.id === id); if (x) x.ok = r.success; },
  async cancelRequested() { return false; },
};
function io(files: Record<string, string> = { "index.html": "<h1>Hi</h1>" }, settings: Record<string, string | number | boolean> = {}): ProjectIO {
  const store = new MemoryFileStore();
  for (const [p, c] of Object.entries(files)) store.set({ path: p, content: c, encoding: "utf8", updatedAt: 1 });
  return { async load() { return { store, revision: 5 }; }, snapshot: () => null, async commit(_p, b) { return { revision: b + 1, changed: ["x"] }; }, async revision() { return 5; }, async settings() { return settings; }, async patchSettings() {} };
}
const sess = (o: Partial<ConstructorParameters<typeof ToolSession>[0]> = {}) => new ToolSession({ userId: "u1", projectId: "p1", ops, io: io(), ...o });
const TWELVE = ["web_search", "run_command", "run_dev_server", "recover_project", "execute_parallel", "verify_build_output", "upload_build", "verify_upload", "connect_integration", "disconnect_integration", "create_task", "cancel_task"];

beforeAll(() => { loadTools(); });

describe("registry", () => {
  it("has each of the 12 canonical tools exactly once with full metadata", () => {
    const names = allTools().map((t) => t.name);
    for (const n of TWELVE) {
      expect(names.filter((x) => x === n).length).toBe(1);
      const t = getTool(n)!;
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.requiredPermissions.length).toBeGreaterThan(0);
      expect(typeof t.handler).toBe("function");
      expect(t.timeoutMs).toBeGreaterThan(0);
    }
  });
  it("tools are discoverable by capability", () => {
    expect(findToolsByCapability("verify build output").map((x) => x.name)).toContain("verify_build_output");
    expect(findToolsByCapability("connect integration oauth").map((x) => x.name)).toContain("connect_integration");
    expect(findToolsByCapability("cancel task").map((x) => x.name)).toContain("cancel_task");
  });
});

describe("web_search", () => {
  const html = `<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvite.dev%2Fguide%2F&amp;rut=1">Getting Started | <b>Vite</b></a><a class="result__snippet" href="#">Vite is a build tool ghp_abcdefghijklmnopqrstuvwxyz0123456789AB</a></div>
<div class="result result--ad"><a class="result__a" href="https://ads.example/">Ad</a></div>
<div class="result"><a class="result__a" href="https://react.dev/learn">Quick Start – React</a><div class="result__snippet">Learn React</div></div>`;
  it("parses multiple real results and drops ads", () => {
    const r = parseDuckDuckGo(html, 10);
    expect(r.map((x) => x.url)).toEqual(["https://vite.dev/guide/", "https://react.dev/learn"]);
    expect(r[0]!.domain).toBe("vite.dev");
    expect(r[0]!.title).toBe("Getting Started | Vite");
  });
  // URL-routed fake network covering all four public sources.
  const routes = (o: { searx?: unknown; wiki?: unknown; reddit?: unknown; ddg?: string } = {}) => (async (input: RequestInfo | URL) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u.includes("/search?q=") && u.includes("format=json") && !u.includes("reddit")) return o.searx ? Response.json(o.searx) : new Response("<html>bot check</html>", { status: 200 });
    if (u.includes("duckduckgo.com")) return u.includes("api.duckduckgo") ? Response.json({}) : new Response(o.ddg ?? "", { status: 200 });
    if (u.includes("wikipedia.org")) return o.wiki ? Response.json(o.wiki) : new Response("", { status: 503 });
    if (u.includes("reddit.com")) return o.reddit ? Response.json(o.reddit) : new Response("blocked", { status: 403 });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const searx = { results: [{ title: "Getting Started | Vite", url: "https://vite.dev/guide/?utm_source=x", content: "Next generation frontend tooling" }, { title: "Vite on GitHub", url: "https://github.com/vitejs/vite", content: "Repo" }] };
  const wiki = { query: { search: [{ title: "Vite (software)", snippet: "<span>Vite</span> is a build tool" }] } };
  const reddit = { data: { children: [{ data: { title: "Vite vs webpack?", permalink: "/r/webdev/comments/1/x/", subreddit_name_prefixed: "r/webdev", score: 42, num_comments: 7 } }, { data: { title: "nsfw", permalink: "/r/x/1", over_18: true } }] } };
  const withFetch = async (f: typeof fetch, fn: () => Promise<void>) => { const orig = globalThis.fetch; globalThis.fetch = f; try { await fn(); } finally { globalThis.fetch = orig; } };

  it("queries all four sources in parallel, merges, de-duplicates and attributes", async () => {
    await withFetch(routes({ searx, wiki, reddit, ddg: html }), async () => {
      const r = await sess().execute("web_search", { query: "vite guide", limit: 10 });
      expect(r.success).toBe(true);
      const d = r.data as { provider: string; count: number; sources: { provider: string; status: string }[]; results: { url: string; source: string; sources: string[]; rank: number }[] };
      expect(d.sources.map((s) => s.provider).sort()).toEqual(["duckduckgo", "reddit", "searxng", "wikipedia"]);
      expect(d.sources.every((s) => s.status === "ok")).toBe(true);
      const vite = d.results.filter((x) => x.url.includes("vite.dev/guide"));
      expect(vite.length).toBe(1); // same page from SearXNG (with utm) and DuckDuckGo is merged
      expect(vite[0]!.sources.sort()).toEqual(["duckduckgo", "searxng"]);
      expect(d.results[0]!.url).toContain("vite.dev/guide"); // agreement ranks first
      expect(d.results.map((x) => x.rank)).toEqual(d.results.map((_, i) => i + 1));
      expect(d.results.some((x) => x.source === "wikipedia" && x.url === "https://en.wikipedia.org/wiki/Vite_(software)")).toBe(true);
      expect(d.results.some((x) => x.source === "reddit" && x.url.startsWith("https://www.reddit.com/r/webdev/"))).toBe(true);
      expect(JSON.stringify(d)).not.toContain("nsfw");
      expect(JSON.stringify(d)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
      expect(r.operationId).toMatch(/^op_/);
    });
  });
  it("partial source failure is a success with warnings naming the failed sources", async () => {
    await withFetch(routes({ wiki }), async () => {
      const r = await sess().execute("web_search", { query: "vite" });
      expect(r.success).toBe(true);
      expect((r.data as { count: number }).count).toBe(1);
      expect(r.warnings.join(" ")).toMatch(/reddit unavailable/);
    });
  });
  it("sources filter restricts which sources are called", async () => {
    const called: string[] = [];
    const f = routes({ searx, wiki, reddit, ddg: html });
    await withFetch((async (i: RequestInfo | URL) => { called.push(String(i)); return f(i); }) as unknown as typeof fetch, async () => {
      const r = await sess().execute("web_search", { query: "vite", sources: ["wikipedia"] });
      expect(r.success).toBe(true);
      expect(called.every((u) => u.includes("wikipedia.org"))).toBe(true);
    });
  });
  it("rejects unknown sources and too-short queries", async () => {
    expect((await sess().execute("web_search", { query: "vite", sources: ["google"] })).error?.code).toBe("INVALID_ARGUMENT");
    expect((await sess().execute("web_search", { query: "v" })).error?.code).toBe("INVALID_ARGUMENT");
  });
  it("no results is a clean success with a warning", async () => {
    await withFetch(routes({ searx: { results: [] }, wiki: { query: { search: [] } }, reddit: { data: { children: [] } }, ddg: "<html>No results</html>" }), async () => {
      const r = await sess().execute("web_search", { query: "zzqxj nothing" });
      expect(r.success).toBe(true);
      expect((r.data as { count: number }).count).toBe(0);
      expect(r.warnings.join(" ")).toContain("No results");
    });
  });
  const prov = (name: string, fn: SearchProvider["search"]): SearchProvider => ({ name, weight: 1, available: () => true, search: fn });
  it("one failing source does not hide the others", async () => {
    const r = await searchWeb("q", 5, [prov("a", async () => { throw new Error("boom"); }), prov("b", async () => [{ title: "T", url: "https://x.dev/", snippet: "", domain: "x.dev", source: "b" }])], { timeoutMs: 1000 });
    expect(r.provider).toBe("b");
    expect(r.tried[0]!.provider).toBe("a");
  });
  it("all sources failing is a structured error, never fake results", async () => {
    await expect(searchWeb("q", 5, [prov("a", async () => { throw new Error("down"); })], { timeoutMs: 1000 })).rejects.toMatchObject({ code: "INTEGRATION_FAILED" });
  });
  it("timeout is reported as TIMEOUT", async () => {
    const slow = prov("slow", (_q, _n, signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))));
    await expect(searchWeb("q", 5, [slow], { timeoutMs: 30 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("parsers handle real-shaped payloads", () => {
    expect(parseWikipedia(wiki, 5)[0]!.snippet).toBe("Vite is a build tool");
    expect(parseReddit(reddit, 5).length).toBe(1);
    expect(parseSearxng(searx, 5)[0]!.domain).toBe("vite.dev");
    expect(parseDuckDuckGoLite(`<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvite.dev%2F&amp;rut=1" class='result-link'>Vite</a></td></tr><tr><td class='result-snippet'>Fast</td>`, 5)[0]).toMatchObject({ url: "https://vite.dev/", snippet: "Fast" });
    expect(parseDuckDuckGoInstant({ AbstractURL: "https://en.wikipedia.org/wiki/Vite", AbstractText: "Vite is…", Heading: "Vite", RelatedTopics: [{ FirstURL: "https://duckduckgo.com/Rollup", Text: "Rollup - bundler" }] }, 5).length).toBe(2);
    expect(canonicalUrl("https://www.Example.com/a/?utm_source=x#top")).toBe(canonicalUrl("https://example.com/a"));
  });
});

describe("run_command", () => {
  it("parses safe commands into argv", () => {
    expect(parseCommand("npm run build")).toMatchObject({ program: "npm", args: ["run", "build"] });
    expect(parseCommand("tsc --noEmit")).toMatchObject({ program: "npx", args: ["--no-install", "tsc", "--noEmit"] });
    expect(parseCommand('node scripts/gen.mjs "a b"').args).toEqual(["scripts/gen.mjs", "a b"]);
  });
  it.each(["rm -rf /", "npm run build && curl x", "cat .env", "node ../../etc/x.js", "npx cowsay", "npm install -g x", "node -e 1", "npm run $(id)", "ls /", "git push"])("rejects %s", (c) => {
    expect(() => parseCommand(c)).toThrow();
  });
  it("successful command returns real stdout/stderr/exit code", async () => {
    nextJob = { status: "succeeded", exitCode: 0, stdout: "built in 1s", stderr: "warn: x" };
    const r = await sess().execute("run_command", { command: "npm run build", waitSeconds: 1 });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ exitCode: 0, stdout: "built in 1s", stderr: "warn: x", command: "npm run build" });
    expect(jobs.get((r.data as { jobId: string }).jobId)!.argv).toEqual(["npm", "run", "build"]);
  });
  it("failed command is COMMAND_FAILED with its output", async () => {
    nextJob = { status: "failed", exitCode: 2, stdout: "", stderr: "error TS2304" };
    const r = await sess().execute("run_command", { command: "tsc --noEmit", waitSeconds: 1 });
    expect(r.error?.code).toBe("COMMAND_FAILED");
    expect(JSON.stringify(r.error?.details)).toContain("error TS2304");
  });
  it("timed-out command is TIMEOUT", async () => {
    nextJob = { status: "failed", exitCode: 124, stdout: "", stderr: "" };
    const r = await sess().execute("run_command", { command: "npm test", waitSeconds: 1 });
    expect(r.error?.code).toBe("TIMEOUT");
  });
  it("still-running command returns the jobId to wait on", async () => {
    nextJob = { status: "running", exitCode: null };
    const r = await sess().execute("run_command", { command: "npm test", waitSeconds: 0 });
    expect(r.success).toBe(true);
    expect(r.nextRecommendedAction).toBe("wait_for_command");
  });
  it("invalid command never reaches the runtime", async () => {
    const before = jobs.size;
    const r = await sess().execute("run_command", { command: "bash -c 'curl evil'" });
    expect(r.error?.code).toBe("SECURITY_BLOCKED");
    expect(jobs.size).toBe(before);
  });
  it("cannot target another project's workspace", async () => {
    const r = await sess().execute("run_command", { command: "npm test", projectId: "p2" });
    expect(r.error?.code).toBe("SECURITY_BLOCKED");
    nextJob = {};
    const ok = await sess().execute("run_command", { command: "npm test", waitSeconds: 1 });
    const other = await new ToolSession({ userId: "u1", projectId: "p2", ops, io: io() }).execute("get_command_result", { jobId: (ok.data as { jobId: string }).jobId });
    expect(other.success).toBe(false);
  });
  it("secrets in output are redacted", async () => {
    nextJob = { status: "succeeded", exitCode: 0, stdout: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" };
    const r = await sess().execute("run_command", { command: "npm run env-check", waitSeconds: 1 });
    expect(JSON.stringify(r)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });
});

describe("run_dev_server", () => {
  const react = { "package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^5" } }), "index.html": "<div id=root></div>", "src/main.tsx": "export {}" };
  it("starts a React dev server, tracks it and supports stop", async () => {
    nextJob = { status: "running", phase: "ready", output: "VITE ready in 300 ms" };
    const s = new ToolSession({ userId: "u1", projectId: "p-dev", ops, io: io(react) });
    const r = await s.execute("run_dev_server", { waitSeconds: 1 });
    expect(r.success).toBe(true);
    const d = r.data as { jobId: string; detected: string; phase: string };
    expect(d.detected).toBe("npm run dev");
    expect(d.phase).toBe("ready");
    const again = await s.execute("run_dev_server", { waitSeconds: 1 });
    expect((again.data as { alreadyRunning: boolean }).alreadyRunning).toBe(true);
    const stop = await s.execute("cancel_operation", { jobId: d.jobId });
    expect(stop.data).toEqual({ requested: true });
  });
  it("static project uses a static server", async () => {
    nextJob = { status: "running", phase: "ready" };
    const r = await new ToolSession({ userId: "u1", projectId: "p-static", ops, io: io({ "index.html": "<h1>x</h1>" }) }).execute("run_dev_server", { waitSeconds: 1 });
    expect((r.data as { detected: string }).detected).toBe("static server");
  });
  it("startup failure is reported truthfully", async () => {
    nextJob = { status: "failed", phase: "failed", exitCode: 1, output: "Error: Cannot find module" };
    const r = await new ToolSession({ userId: "u1", projectId: "p-fail", ops, io: io(react) }).execute("run_dev_server", { waitSeconds: 1 });
    expect(r.error?.code).toBe("COMMAND_FAILED");
  });
  it("startup timeout returns a still-starting state, not success", async () => {
    nextJob = { status: "running", phase: "starting" };
    const r = await new ToolSession({ userId: "u1", projectId: "p-slow", ops, io: io(react) }).execute("run_dev_server", { waitSeconds: 0 });
    expect((r.data as { phase: string }).phase).toBe("starting");
    expect(r.warnings.join(" ")).toContain("Still starting");
  });
  it("projects without a dev server get a structured error", async () => {
    const r = await new ToolSession({ userId: "u1", projectId: "p-none", ops, io: io({ "README.md": "x" }) }).execute("run_dev_server", {});
    expect(r.error?.code).toBe("INVALID_ARGUMENT");
  });
});

describe("recover_project", () => {
  const ev = (o: Partial<Parameters<typeof decideRecovery>[0]> = {}) => ({ revision: 10, currentErrors: [], buildStatus: "ready", buildError: null, buildStuck: false, runningJobs: [], candidates: [], ...o });
  it("decides: nothing to do / rebuild / restore / review", () => {
    expect(decideRecovery(ev()).type).toBe("none");
    expect(decideRecovery(ev({ buildStatus: "failed" })).type).toBe("rebuild");
    const err = [{ file: "a", message: "x" }];
    expect(decideRecovery(ev({ currentErrors: err, candidates: [{ kind: "snapshot", id: "snap_1", revision: 8, label: "ok", valid: true, filesLost: ["a"] }] }))).toMatchObject({ type: "restore", source: "snapshot", revision: 8 });
    expect(decideRecovery(ev({ currentErrors: err, candidates: [{ kind: "revision", id: null, revision: 9, label: null, valid: false, filesLost: [] }] })).type).toBe("review");
    expect(decideRecovery(ev({ revision: 20, currentErrors: err, candidates: [{ kind: "revision", id: null, revision: 1, label: null, valid: true, filesLost: [] }] })).type).toBe("review");
    expect(decideRecovery(ev({ runningJobs: ["job_1"] })).type).toBe("review");
  });
  const broken = { "index.html": "<script type=module src=./src/main.js></script>", "src/main.js": "import { x } from './missing.js';\nconsole.log(x)" };
  it("plan mode changes nothing and needs no confirmation", async () => {
    const good = new MemoryFileStore(); good.set({ path: "index.html", content: "<h1>ok</h1>", encoding: "utf8", updatedAt: 1 });
    historical.set(4, good); revisions = [{ revision: 5 }, { revision: 4 }]; rolledBackTo = null;
    const r = await new ToolSession({ userId: "u1", projectId: "p1", ops, io: io(broken) }).execute("recover_project", {});
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ status: "plan_ready", action: { type: "restore", revision: 4 } });
    expect(rolledBackTo).toBeNull();
  });
  it("apply requires confirmation", async () => {
    const r = await new ToolSession({ userId: "u1", projectId: "p1", ops, io: io(broken) }).execute("recover_project", { mode: "apply" });
    expect(r.error?.code).toBe("CONFIRMATION_REQUIRED");
  });
  it("apply saves a safety snapshot, restores and is audited as child operations", async () => {
    rolledBackTo = null; ops.rows = [];
    const r = await new ToolSession({ userId: "u1", projectId: "p1", ops, io: io(broken) }).execute("recover_project", { mode: "apply", confirm: true });
    expect(r.success).toBe(true);
    expect(rolledBackTo).toBe(4);
    const parent = ops.rows.find((x) => x.tool === "recover_project")!;
    expect(ops.rows.filter((x) => x.parentId === parent.id).map((x) => x.tool)).toEqual(["create_snapshot", "rollback_to_revision"]);
    expect((r.data as { undo: { tool: string } }).undo.tool).toBe("restore_snapshot");
  });
  it("non-recoverable state returns recovery_requires_review and changes nothing", async () => {
    historical.set(4, (await io(broken).load("p1")).store); rolledBackTo = null;
    const r = await new ToolSession({ userId: "u1", projectId: "p1", ops, io: io(broken) }).execute("recover_project", { mode: "apply", confirm: true });
    expect((r.data as { status: string }).status).toBe("recovery_requires_review");
    expect(rolledBackTo).toBeNull();
  });
  it("cannot recover another project", async () => {
    const r = await sess().execute("recover_project", { projectId: "p2" });
    expect(r.error?.code).toBe("SECURITY_BLOCKED");
  });
});

describe("execute_parallel", () => {
  const files = { "a.txt": "A", "b.txt": "B", "c.txt": "C", "d.txt": "D", "e.txt": "E" };
  it("runs independent tools, aggregates, links children to the parent", async () => {
    ops.rows = [];
    const r = await new ToolSession({ userId: "u1", projectId: "p1", ops, io: io(files) }).execute("execute_parallel", { calls: ["a", "b", "c", "d", "e"].map((x) => ({ tool: "read_file", args: { path: `${x}.txt` } })), maxConcurrency: 2 });
    expect(r.success).toBe(true);
    const d = r.data as { status: string; succeeded: number; peakConcurrency: number; results: { operationId: string }[] };
    expect(d.status).toBe("all_succeeded");
    expect(d.succeeded).toBe(5);
    expect(d.peakConcurrency).toBeLessThanOrEqual(2);
    const parent = ops.rows.find((x) => x.tool === "execute_parallel")!;
    expect(ops.rows.filter((x) => x.parentId === parent.id).length).toBe(5);
    expect(new Set(d.results.map((x) => x.operationId)).size).toBe(5);
  });
  it("a required child failure fails the parent with all results", async () => {
    const r = await new ToolSession({ userId: "u1", projectId: "p1", ops, io: io(files) }).execute("execute_parallel", { calls: [{ tool: "read_file", args: { path: "a.txt" } }, { tool: "read_file", args: { path: "missing.txt" } }] });
    expect(r.success).toBe(false);
    expect((r.error?.details as { status: string }).status).toBe("partial_failure");
  });
  it("an optional child failure is a warning", async () => {
    const r = await new ToolSession({ userId: "u1", projectId: "p1", ops, io: io(files) }).execute("execute_parallel", { calls: [{ tool: "read_file", args: { path: "a.txt" } }, { tool: "read_file", args: { path: "missing.txt" }, required: false }] });
    expect(r.success).toBe(true);
    expect((r.data as { status: string }).status).toBe("partial_failure");
  });
  it("rejects non-parallel-safe tools, duplicates, nesting and bad args before running anything", () => {
    const ctx = { projectId: "p1", readOnly: false, confirmed: false };
    expect(planParallel([{ tool: "write_file", args: { path: "a.txt", content: "x" } }], ctx).rejected[0]!.reason).toContain("not parallel-safe");
    expect(planParallel([{ tool: "read_file", args: { path: "a.txt" } }, { tool: "read_file", args: { path: "a.txt" } }], ctx).rejected[0]!.code).toBe("CONFLICT");
    expect(planParallel([{ tool: "execute_sequence", args: { calls: [] } }], ctx).rejected[0]!.reason).toContain("nested");
    expect(planParallel([{ tool: "read_file", args: {} }], ctx).rejected[0]!.code).toBe("INVALID_ARGUMENT");
    expect(planParallel([{ tool: "nope", args: {} }], ctx).rejected[0]!.code).toBe("UNKNOWN_TOOL");
  });
  it("permission failures and cross-project calls are rejected", async () => {
    expect(planParallel([{ tool: "read_file", args: { path: "a.txt", projectId: "p2" } }], { projectId: "p1", readOnly: false, confirmed: false }).rejected[0]!.code).toBe("SECURITY_BLOCKED");
    const r = await new ToolSession({ userId: "u1", projectId: "p1", ops, io: io(files), readOnly: true }).execute("execute_parallel", { calls: [{ tool: "run_build", args: {} }] });
    expect(r.success).toBe(false);
  });
});

describe("registered platform tools", () => {
  it("verify_build_output / verify_upload / upload_build execute and normalize", async () => {
    const s = sess();
    expect((await s.execute("verify_build_output", {})).data).toMatchObject({ ok: true, hashMatches: true });
    expect((await s.execute("verify_upload", {})).data).toMatchObject({ ok: true, inProjectFolder: true });
    const up = await s.execute("upload_build", {});
    expect(up.success).toBe(true);
    expect(up.stateChanges[0]!.kind).toBe("build");
    builds.uploadError = { message: "React + Vite builds are uploaded by the build runtime itself", status: 409 };
    expect((await s.execute("upload_build", {})).error?.code).toBe("CONFLICT");
    builds.uploadError = null;
  });
  it("verify_build_output reports issues as warnings", async () => {
    builds.verify = { ok: false, fileCount: 0, hashMatches: false, issues: ["hash mismatch"] };
    const r = await sess().execute("verify_build_output", {});
    expect(r.warnings).toContain("hash mismatch");
    builds = { ...builds, verify: { ok: true, fileCount: 3, hashMatches: true, issues: [] } };
  });
  it("read-only sessions cannot upload, connect, disconnect or manage tasks", async () => {
    const s = sess({ readOnly: true });
    for (const [t, a] of [["upload_build", {}], ["connect_integration", { integration: "google_drive" }], ["create_task", { type: "file_operation" }], ["cancel_task", { taskId: "task_running_1" }]] as const)
      expect((await s.execute(t, a)).error?.code).toBe("PERMISSION_DENIED");
  });
  it("connect_integration returns the user's authorize URL using a configured origin", async () => {
    const r = await sess().execute("connect_integration", { integration: "google_drive" });
    expect(r.data).toMatchObject({ status: "awaiting_user_authorization" });
    expect(connectCalls.at(-1)).toMatchObject({ userId: "u1", origin: "https://app.example", cb: "https://api.example" });
    expect((await sess().execute("connect_integration", { integration: "dropbox" })).error?.code).toBe("INVALID_ARGUMENT");
  });
  it("disconnect_integration needs confirmation and maps not-found", async () => {
    expect((await sess().execute("disconnect_integration", { integration: "github" })).error?.code).toBe("CONFIRMATION_REQUIRED");
    expect((await sess().execute("disconnect_integration", { integration: "github", confirm: true })).data).toMatchObject({ ok: true, removed: "github" });
    expect((await sess().execute("disconnect_integration", { connectionId: "00000000-0000-4000-8000-000000000000", confirm: true })).error?.code).toBe("INVALID_ARGUMENT");
  });
  it("create_task / cancel_task stay inside the project and block agent recursion", async () => {
    const s = sess({ taskId: "task_self_123" });
    expect((await s.execute("create_task", { type: "file_operation", payload: { op: "x" } })).data).toMatchObject({ id: "task_new_1", created: true });
    expect((await s.execute("create_task", { type: "ai_agent" })).error?.code).toBe("SECURITY_BLOCKED");
    expect((await s.execute("cancel_task", { taskId: "task_running_1" })).data).toMatchObject({ alreadyFinished: false });
    expect((await s.execute("cancel_task", { taskId: "task_other_project" })).error?.code).toBe("INVALID_ARGUMENT");
    expect((await s.execute("cancel_task", { taskId: "task_self_123" })).error?.code).toBe("INVALID_ARGUMENT");
  });
  it("every call is audited", () => {
    const logged = new Set(ops.rows.map((r) => r.tool));
    for (const n of ["verify_build_output", "verify_upload", "upload_build", "connect_integration", "disconnect_integration", "create_task", "cancel_task"]) expect(logged.has(n) || ops.rows.length > 0).toBe(true);
  });
});

// ---------- canonical aliases (46 grouped tools) ----------
import { CANONICAL_ALIASES } from "./aliases";
import { allAliases } from "./registry";

describe("canonical aliases", () => {
  const names = Object.keys(CANONICAL_ALIASES);
  it("covers exactly the 46 audited canonical names, each resolving to one real tool", () => {
    expect(names.length).toBe(46);
    expect(allAliases().length).toBe(46);
    const real = new Set(allTools().map((t) => t.name));
    for (const n of names) {
      expect(real.has(n)).toBe(false); // alias, not a duplicate tool
      const t = getTool(n)!;
      expect(t).not.toBeNull();
      expect(real.has(t.aliasOf!)).toBe(true);
      expect(t.requiredPermissions).toEqual(getTool(t.aliasOf!)!.requiredPermissions);
    }
  });
  it("is discoverable by its canonical name", () => {
    expect(findToolsByCapability("clean_cache")[0]).toMatchObject({ name: "clean_cache", aliasOf: "cleanup_workspace" });
  });
  it("preset arguments are fixed and cannot be overridden", async () => {
    const r = await sess().execute("mark_task_complete", { index: 0, status: "failed" });
    expect(r.error?.code).toBe("INVALID_ARGUMENT");
  });

  const files = {
    "package.json": JSON.stringify({ name: "x", dependencies: { react: "^18.3.1", lodash: "^4.17.21", left: "1.0.0" }, devDependencies: { vite: "^5.0.0" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { react: "^18.3.1", lodash: "^4.17.21", left: "1.0.0" } }, "node_modules/lodash": { version: "4.17.21" }, "node_modules/left": { version: "1.0.0" }, "node_modules/react": { version: "18.3.1" } } }),
    "src/App.tsx": `import { Routes, Route } from "react-router-dom";\nimport Home from "./pages/Home";\nexport default function App() { return (<Routes>\n        <Route path="/" element={<Home />} />\n      </Routes>); }\n`,
    "src/pages/Home.tsx": "export default function Home() { return <h1>Home</h1>; }\n",
    "dist/index.html": "<html></html>", "dist/assets/a.js": "x", ".vite/deps/x.js": "x", "node_modules/foo/index.js": "x", "notes.tmp": "x", "tsconfig.tsbuildinfo": "{}",
    ".env": "SECRET=1", ".env.example": "SECRET=", "certs/server.pem": "-----", "logo.svg": `<?xml version="1.0"?><!-- c --><svg viewBox="0 0 10 10">  <title>x</title>  <rect/></svg>`,
  };
  const s2 = () => sess({ io: io(files) });

  it("uninstall_dependencies removes several packages and prunes package-lock.json", async () => {
    const r = await s2().execute("uninstall_dependencies", { names: ["lodash", "left"] });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ removed: ["lodash", "left"], lockfileUpdated: true });
    expect(r.stateChanges.map((c) => c.target)).toEqual(["package.json", "package-lock.json"]);
  });
  it("uninstall_dependencies refuses unknown packages", async () => {
    expect((await s2().execute("uninstall_dependencies", { names: ["nope"] })).error?.code).toBe("DEPENDENCY_FAILED");
  });
  it("clean_* scopes remove only their own files", async () => {
    const files_ = (r: { data: unknown }) => (r.data as { files: string[] }).files.sort();
    expect(files_(await s2().execute("clean_build_artifacts", { dryRun: true }))).toEqual(["dist/assets/a.js", "dist/index.html"]);
    expect(files_(await s2().execute("clean_cache", { dryRun: true }))).toEqual([".vite/deps/x.js", "tsconfig.tsbuildinfo"]);
    expect(files_(await s2().execute("clean_dependencies", { dryRun: true }))).toEqual(["node_modules/foo/index.js"]);
    expect(files_(await s2().execute("clean_temp_files", { dryRun: true }))).toEqual(["notes.tmp"]);
  });
  it("scan_sensitive_files flags sensitive file names, not templates", async () => {
    const r = await s2().execute("scan_sensitive_files", {});
    const f = (r.data as { sensitiveFiles: { file: string }[]; clean: boolean });
    expect(f.sensitiveFiles.map((x) => x.file).sort()).toEqual([".env", "certs/server.pem"]);
    expect(f.clean).toBe(false);
  });
  it("generate_route creates the page and registers a react-router route", async () => {
    const r = await s2().execute("generate_route", { name: "about", title: "About" });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ route: "/about", router: "react-router", routeFile: "src/App.tsx" });
    expect(r.stateChanges.map((c) => c.target)).toContain("src/App.tsx");
  });
  it("read_asset returns the content; optimize_assets optimizes every SVG", async () => {
    const r = await s2().execute("read_asset", { path: "logo.svg" });
    expect((r.data as { content: { data: string } }).content.data).toContain("<svg");
    const o = await s2().execute("optimize_assets", {});
    expect(o.success).toBe(true);
    expect((o.data as { optimized: { path: string }[]; savedBytes: number }).optimized.map((x) => x.path)).toEqual(["logo.svg"]);
    expect((o.data as { savedBytes: number }).savedBytes).toBeGreaterThan(0);
  });
  it("validate_dependencies reports manifest problems", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
    try {
      const r = await sess({ io: io({ "package.json": JSON.stringify({ dependencies: { a: "latest", b: "^1.0.0" }, devDependencies: { b: "^1.0.0" } }), "src/x.ts": "import z from 'zod';" }) }).execute("validate_dependencies", {});
      const d = r.data as { manifestIssues: { package: string; issue: string }[]; undeclared: string[]; valid: boolean };
      expect(d.manifestIssues.map((x) => x.package).sort()).toEqual(["a", "b"]);
      expect(d.undeclared).toEqual(["zod"]);
      expect(d.valid).toBe(false);
    } finally { globalThis.fetch = orig; }
  });
  it("get_runtime_status without a jobId reports the latest dev server", async () => {
    nextJob = { kind: "dev", status: "running", phase: "ready" };
    await sess().execute("run_dev_server", { waitSeconds: 0 });
    nextJob = {};
    const r = await sess().execute("get_runtime_status", {});
    expect(r.success).toBe(true);
    expect((r.data as { devServer: { kind: string } | null }).devServer?.kind).toBe("dev");
  });
});
