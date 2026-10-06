// Agent Core tests: grouping, batching, registry, progress messages, context, D1 persistence (real SQLite running the
// Agent D1 migration), tool-call recording, per-file events, checkpoints, redaction, disabled tools and run authorization.
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { analyzeTask, groupTasks } from "./grouping";
import { progressMessage } from "./messages";
import { buildContext, selectRelevantFiles } from "./context";
import { AgentStore, type D1Like } from "./store";
import { AgentRun, argsRef } from "./run.server";
import { buildRegistry, validateRegistry } from "./registry";
import { loadTools, ToolSession } from "../tools/index";
import { disabledTools } from "../tools/registry";
import { MemoryFileStore } from "../../sandbox/workspace/workspace";
import type { OperationStore, ProjectIO } from "../tools/orchestrator";

/** SQLite with the D1 prepare/bind/all surface, loaded with the real Agent D1 migration. */
function agentDb(): D1Like & { raw: Database } {
  const raw = new Database(":memory:");
  raw.exec(readFileSync(`${import.meta.dir}/../migrations-agent/001_agent.sql`, "utf8"));
  return { raw, prepare: (sql: string) => ({ bind: (...p: unknown[]) => ({ all: async <T>() => ({ results: raw.query(sql).all(...(p as never[])) as T[] }) }) }) };
}
const E2E = "Update the homepage title, change the primary button text, and modify the footer link.";

beforeAll(() => { loadTools(); });

describe("task grouping and batching", () => {
  it("splits the end-to-end request into three low-risk tasks in one batch", () => {
    const t = analyzeTask(E2E);
    expect(t.map((x) => x.text)).toEqual(["Update the homepage title", "change the primary button text", "modify the footer link"]);
    expect(t.every((x) => x.risk === "low")).toBe(true);
    const b = groupTasks(t);
    expect(b).toHaveLength(1);
    expect(b[0]!.kind).toBe("grouped");
    expect(b[0]!.taskIds).toEqual(["t1", "t2", "t3"]);
  });
  it("keeps risky work in its own batch", () => {
    const b = groupTasks(analyzeTask("Change the header text, add login with a database, and change the button color"));
    expect(b.map((x) => x.taskIds)).toEqual([["t1"], ["t2"], ["t3"]]);
    expect(b[1]!.risk).toBe("high");
  });
  it("caps a grouped batch at six tasks", () => {
    const b = groupTasks(analyzeTask(Array.from({ length: 8 }, (_, i) => `- change text ${i}`).join("\n")));
    expect(b.map((x) => x.taskIds.length)).toEqual([6, 2]);
  });
});

describe("dynamic progress messages", () => {
  it("never claims success for a failed step", () => {
    expect(progressMessage({ type: "build", ok: false, error: "Unexpected token" })).toBe("Build failed: Unexpected token");
    expect(progressMessage({ type: "applied", files: ["src/a.tsx"], ok: false, error: "conflict" })).toContain("Couldn't save");
    expect(progressMessage({ type: "complete", changed: 2, ok: false })).not.toContain("Done");
  });
  it("uses the real file names and varies wording", () => {
    const a = progressMessage({ type: "apply", files: ["src/Header.tsx", "src/Button.tsx", "src/Footer.tsx", "src/styles.css"] });
    expect(a).toBe("Applying changes to 4 files: Header.tsx, Button.tsx, Footer.tsx and 1 more.");
    expect(progressMessage({ type: "read", files: ["a.ts"] }, 0)).not.toBe(progressMessage({ type: "read", files: ["a.ts"] }, 1));
  });
});

describe("context system", () => {
  const files = [
    { path: "index.html", content: "<title>Old</title>" }, { path: "src/components/Footer.tsx", content: "<a href='/x'>link</a>" },
    { path: "src/components/Hero.tsx", content: "<button>Go</button>" }, { path: "src/utils/math.ts", content: "export const add=1" },
    { path: "logo.png", content: "", encoding: "base64" },
  ];
  it("selects only relevant files", () => {
    const sel = selectRelevantFiles(files, analyzeTask(E2E)).map((f) => f.path);
    expect(sel).toContain("src/components/Footer.tsx");
    expect(sel).toContain("src/components/Hero.tsx");
    expect(sel).toContain("index.html");
    expect(sel).not.toContain("src/utils/math.ts");
    expect(sel).not.toContain("logo.png");
  });
  it("respects the snippet budget", () => {
    const c = buildContext({ request: E2E, projectId: "p", projectName: "x", files: [{ path: "index.html", content: "title ".repeat(5000) }], tasks: analyzeTask(E2E), stage: "planning", snippetBudget: 100 });
    expect(c.relevantFiles[0]!.snippet.length).toBe(100);
  });
});

describe("tool registry", () => {
  it("registers every source tool once with resolvable handlers", () => {
    const r = validateRegistry();
    expect(r.errors).toEqual([]);
    expect(r.tools).toBeGreaterThanOrEqual(146);
    const e = buildRegistry().find((x) => x.tool_name === "update_file")!;
    expect(e.handler).toBe("catalog/files:update_file");
    expect(e.input_schema["path"]).toBe("string");
    expect(e.enabled).toBe(true);
  });
  it("refuses a disabled tool at execution", async () => {
    const ops: OperationStore = { async start() {}, async finish() {}, async cancelRequested() { return false; } };
    const store = new MemoryFileStore(); store.set({ path: "a.txt", content: "x", encoding: "utf8", updatedAt: 1 });
    const io: ProjectIO = { async load() { return { store, revision: 1 }; }, snapshot: () => null, async commit(_p, b) { return { revision: b + 1, changed: [] }; }, async revision() { return 1; }, async settings() { return {}; }, async patchSettings() {} };
    disabledTools.add("read_file");
    try {
      const r = await new ToolSession({ userId: "u", projectId: "p", ops, io }).execute("read_file", { path: "a.txt" });
      expect(r.success).toBe(false);
      expect(r.error?.code).toBe("PERMISSION_DENIED");
      expect(buildRegistry().find((x) => x.tool_name === "read_file")!.enabled).toBe(false);
    } finally { disabledTools.delete("read_file"); }
  });
});

describe("Agent D1 persistence", () => {
  it("records a run with ordered steps, messages, checkpoints and usage", async () => {
    const db = agentDb(); const s = new AgentStore(db);
    await s.createRun({ runId: "r1", projectId: "p", userId: "u", taskText: E2E });
    const a = await s.addStep("r1", { type: "analyze", name: "Analyze" });
    const b = await s.addStep("r1", { type: "batch", name: "b1", batchId: "b1", status: "pending" });
    await s.finishStep(a, { status: "succeeded" });
    const steps = await s.steps("r1") as { step_id: string; sequence: number; status: string; duration_ms: number | null }[];
    expect(steps.map((x) => [x.step_id, x.sequence, x.status])).toEqual([[a, 1, "succeeded"], [b, 2, "pending"]]);
    expect(steps[0]!.duration_ms).not.toBeNull();
    await s.addMessage("r1", { role: "agent", type: "progress", content: "one" });
    await s.addMessage("r1", { role: "agent", type: "progress", content: "two" });
    expect((await s.messages("r1", 1) as { content: string }[]).map((m) => m.content)).toEqual(["two"]);
    await s.checkpoint("r1", { type: "batch", state: { round: 1 }, completed: ["index.html"], pending: ["b1"], next: "building" });
    expect((await s.latestCheckpoint("r1") as { next_action: string }).next_action).toBe("building");
    await s.recordUsage("r1", { provider: "groq", model: "m", requestType: "final_summary", inputTokens: 10, outputTokens: 5, latencyMs: 20, status: "succeeded" });
    expect((await s.usage("r1") as { total_tokens: number }[])[0]!.total_tokens).toBe(15);
    await s.updateRun("r1", { status: "completed", finalSummaryStatus: "generated" });
    const run = await s.getRun("r1") as { status: string; completed_at: string | null };
    expect(run.status).toBe("completed"); expect(run.completed_at).not.toBeNull();
  });
  it("redacts secrets and never stores file contents in tool arguments", async () => {
    const db = agentDb(); const s = new AgentStore(db);
    await s.createRun({ runId: "r2", projectId: "p", userId: "u", taskText: "use key sk_live_abcdefghijklmnopqrstuvwxyz123" });
    expect(((await s.getRun("r2")) as { task_text: string }).task_text).toContain("[REDACTED]");
    const ref = argsRef({ path: "src/a.ts", content: "const SECRET='x'".repeat(20), find: "a", edits: [1, 2] });
    expect(JSON.parse(ref)).toEqual({ path: "src/a.ts", content: "<320 chars>", find: "<1 chars>", edits: "<2 items>" });
    await s.addMessage("r2", { role: "agent", type: "error", content: "token ghp_" + "a".repeat(40) });
    expect(((await s.messages("r2")) as { content: string }[])[0]!.content).toBe("token [REDACTED]");
  });
});

describe("AgentRun recorder", () => {
  it("records tool calls and emits one file event per file in a batch", async () => {
    const db = agentDb(); const store = new AgentStore(db);
    const events: { kind: string; data: unknown }[] = [];
    const c = { emit: async (kind: string, data: unknown) => { events.push({ kind, data }); } } as never;
    const ar = new AgentRun(store, "r3", c);
    await ar.start({ projectId: "p", userId: "u", taskText: E2E });
    const sid = await ar.step({ type: "edit", name: "Round 1", batchId: "b1" });
    const fake = { execute: async (name: string) => ({ success: name !== "verify_project", operationId: "op_1", toolName: name, data: null, error: name === "verify_project" ? { code: "BUILD_FAILED" as const, message: "x", retryable: false } : null, warnings: [], metadata: { attempts: 2 }, stateChanges: [], nextRecommendedAction: null }) };
    await ar.tool(fake, "update_file", { path: "index.html", find: "a", replace: "b" }, { stepId: sid, batchId: "b1" });
    await ar.tool(fake, "verify_project", {}, { stepId: sid, batchId: "b1" });
    const calls = await store.toolCalls("r3") as { tool_name: string; tool_id: string; status: string; output_reference: string; retry_count: number; batch_id: string }[];
    expect(calls.map((x) => [x.tool_name, x.tool_id, x.status, x.output_reference, x.retry_count, x.batch_id])).toEqual([
      ["update_file", "tool.update_file", "succeeded", "op:op_1", 1, "b1"], ["verify_project", "tool.verify_project", "failed", "op:op_1", 1, "b1"]]);
    await ar.files(["src/Header.tsx", "src/Button.tsx", "src/Footer.tsx", "src/styles.css"], 7, { stepId: sid, batchId: "b1" });
    expect(events.filter((e) => e.kind === "file_changed").map((e) => (e.data as { path: string }).path)).toEqual(["src/Header.tsx", "src/Button.tsx", "src/Footer.tsx", "src/styles.css"]);
    const fileMsgs = (await store.messages("r3") as { message_type: string }[]).filter((m) => m.message_type === "file_changed");
    expect(fileMsgs).toHaveLength(4);
  });
  it("local progress creates no AI usage rows", async () => {
    const db = agentDb(); const store = new AgentStore(db);
    const ar = new AgentRun(store, "r4", { emit: async () => {} } as never);
    await ar.start({ projectId: "p", userId: "u", taskText: "x" });
    for (let i = 0; i < 5; i++) await ar.progress({ type: "verify" });
    expect(await store.usage("r4")).toEqual([]);
  });
  it("recording failures never break the run", async () => {
    const broken = new AgentStore({ prepare: () => { throw new Error("db down"); } } as never);
    const ar = new AgentRun(broken, "r5", null);
    const fake = { execute: async () => ({ success: true, operationId: "op", toolName: "read_file", data: 1, error: null, warnings: [], metadata: {}, stateChanges: [], nextRecommendedAction: null }) };
    expect((await ar.tool(fake, "read_file", { path: "a" })).success).toBe(true);
  });
});

describe("run authorization", () => {
  it("rejects reading another user's run", async () => {
    const db = agentDb(); const store = new AgentStore(db);
    await store.createRun({ runId: "r6", projectId: "p", userId: "owner", taskText: "x" });
    mock.module("@security/authorize.server", () => ({ requireUser: async () => ({ id: "intruder" }) }));
    mock.module("./db.server", () => ({ agentStore: () => store }));
    const api = await import("../functions/api/agent");
    await expect(api.agentSteps({ runId: "r6" })).rejects.toThrow("Run not found");
    mock.module("@security/authorize.server", () => ({ requireUser: async () => ({ id: "owner" }) }));
    expect(await api.agentSteps({ runId: "r6" })).toEqual([]);
  });
});
