import { describe, it, expect, beforeAll } from "vitest";
import { MemoryFileStore } from "../../sandbox/workspace/workspace";
import { loadTools, ToolSession } from "./index";
import type { OperationStore, ProjectIO } from "./orchestrator";

const ops: OperationStore & { log: string[] } = { log: [], async start(o) { this.log.push(`start ${o.toolName}`); }, async finish(id, r) { this.log.push(`finish ${r.toolName} ${r.success}`); }, async cancelRequested() { return false; } };
function io(): ProjectIO & { commits: number } {
  const store = new MemoryFileStore();
  store.set({ path: "index.html", content: "<h1>Hi</h1>", encoding: "utf8", updatedAt: 1 });
  return { commits: 0, async load() { return { store, revision: 1 }; }, snapshot: () => null, async commit(_p, b) { this.commits++; return { revision: b + 1, changed: ["x"] }; }, async revision() { return 1; }, async settings() { return {}; }, async patchSettings() {} };
}
const sess = (o: Partial<ConstructorParameters<typeof ToolSession>[0]> = {}) => new ToolSession({ userId: "u", projectId: "p1", ops, io: io(), ...o });

beforeAll(() => { loadTools(); });

describe("tool system", () => {
  it("reads and edits files with structured results", async () => {
    const s = sess();
    const r = await s.execute("read_file", { path: "index.html" });
    expect(r.success).toBe(true);
    expect((r.data as { content: string }).content).toBe("<h1>Hi</h1>");
    const u = await s.execute("update_file", { path: "index.html", find: "Hi", replace: "Hello" });
    expect(u.success).toBe(true);
    expect(s.pendingChanges).toEqual(["index.html"]);
  });
  it("rejects other projects", async () => {
    const r = await sess().execute("read_file", { path: "index.html", projectId: "other" });
    expect(r.error?.code).toBe("SECURITY_BLOCKED");
  });
  it("blocks writes in read-only sessions", async () => {
    const r = await sess({ readOnly: true }).execute("write_file", { path: "a.txt", content: "x" });
    expect(r.error?.code).toBe("PERMISSION_DENIED");
  });
  it("requires confirmation for destructive tools", async () => {
    const s = sess();
    expect((await s.execute("delete_file", { path: "index.html" })).error?.code).toBe("CONFIRMATION_REQUIRED");
    expect((await s.execute("delete_file", { path: "index.html", confirm: true })).success).toBe(true);
  });
  it("refuses path traversal and secret files", async () => {
    const s = sess();
    expect((await s.execute("read_file", { path: "../etc/passwd" })).success).toBe(false);
    expect((await s.execute("write_file", { path: ".env", content: "K=1" })).success).toBe(false);
  });
  it("returns UNKNOWN_TOOL with suggestions", async () => {
    const r = await sess().execute("no_such_tool_xyz");
    expect(r.error?.code).toBe("UNKNOWN_TOOL");
  });
  it("detects repeated identical calls", async () => {
    const s = sess();
    let last;
    for (let i = 0; i < 5; i++) last = await s.execute("list_files", {});
    expect(last!.error?.code).toBe("LOOP_DETECTED");
  });
});
