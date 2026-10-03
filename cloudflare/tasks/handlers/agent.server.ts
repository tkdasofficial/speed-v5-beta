// ai_agent tasks: the full agent workflow, running entirely on the server as one durable task.
// Phases (persisted in state, mirrored as `phase` events):
//   planning (Thinking → analyze → Creating Plan) → awaiting_approval (task parked, no alarm)
//   → building (Thinking → Action → … rounds) → validating → testing → completed
// Exits: denied (user denied the plan), cancelled (Stop), failed (errors / repair limit).
// Every action emits `action.started` before it runs and `action` (completed/failed) after, so the UI
// shows Processing only while the server is really doing the work, and rebuilds it from events on reload.
import type { Json, Message } from "@realtime/events";
import type { TaskHandler, TaskContext, StepResult } from "../registry";
import { FatalError } from "../registry";
import type { AgentPlan } from "../../functions/ai/orchestrator.server";
import type { MemoryFileStore } from "../../../sandbox/workspace/workspace";

const MAX_ROUNDS = 12;
const MAX_REPAIRS = 3; // failed checks inside the build loop before giving up
const MAX_FIX_ATTEMPTS = 3; // validation/test → fix → retest cycles
type Step = { kind: "read" | "create" | "edit" | "delete" | "think" | "check" | "tool"; path?: string; content?: string; find?: string; replace?: string; note?: string; name?: string; args?: Record<string, unknown> };
type Phase = "planning" | "awaiting" | "building" | "validating";
type State = {
  phase?: Phase; changed?: string[]; created?: string[]; lastCheck?: boolean | null; round?: number; results?: string; failedBuilds?: number;
  failedIds?: string[]; baseRevision?: number; mutated?: boolean; plan?: AgentPlan; planVersion?: number; decisionSeq?: number;
  feedback?: string; snippets?: string; fixAttempts?: number; validation?: string; test?: string; n?: number;
};
type P = { prompt?: string; model?: "speed" | "flash" | "heavy"; depth?: "quick" | "balanced" | "deep"; plan?: boolean; clientMessageId?: string };

/** Running / completed labels for one action ("Creating styles.css" → "Created styles.css"). */
function labels(name: string, target: string | null): { kind: string; running: string; done: string; failed: string } {
  const t = target ?? "";
  const v = (kind: string, ing: string, ed: string) => ({ kind, running: `${ing}${t ? ` ${t}` : ""}`, done: `${ed}${t ? ` ${t}` : ""}`, failed: `Couldn't ${ing.toLowerCase().replace(/ing$/, "")}${t ? ` ${t}` : ""}` });
  if (name === "create_file") return v("create", "Creating", "Created");
  if (name === "edit_file" || name === "patch_file") return v("edit", "Editing", "Edited");
  if (name === "delete_file") return v("delete", "Deleting", "Deleted");
  if (name === "rename_file" || name === "move_file") return v("edit", "Moving", "Moved");
  if (/^(read|get_file|get_code)/.test(name)) return v("read", "Reading", "Read");
  if (/^(search|find)_/.test(name)) return v("search", "Searching", "Searched");
  if (/^(list|get_file_tree|file_exists)/.test(name)) return v("read", "Exploring", "Explored");
  if (/^validate_/.test(name)) return v("check", "Validating", "Validated");
  if (/^build_/.test(name)) return { kind: "check", running: "Checking project", done: "Check passed", failed: "Check failed" };
  if (/rollback/.test(name)) return v("fix", "Undoing change", "Undid change");
  return v("inspect", "Inspecting", "Inspected");
}
function toTool(s: Step): { name: string; args: Record<string, unknown> } {
  switch (s.kind) {
    case "read": return { name: "read_file", args: { path: s.path } };
    case "create": return { name: "create_file", args: { path: s.path, content: s.content ?? "" } };
    case "edit": return { name: "edit_file", args: s.find === undefined && s.content !== undefined ? { path: s.path, content: s.content } : { path: s.path, find: s.find, replace: s.replace ?? "" } };
    case "delete": return { name: "delete_file", args: { path: s.path, force: true } };
    case "check": return { name: "build_project", args: {} };
    case "tool": return { name: s.name ?? "", args: s.args ?? {} };
    default: return { name: "", args: {} };
  }
}

async function saveMessage(c: TaskContext, role: "user" | "assistant", content: string): Promise<Message> {
  const { d1 } = await import("@backend/d1");
  const { publish } = await import("@realtime/publish.server");
  const pid = c.task.project_id!;
  await d1("INSERT OR IGNORE INTO conversations (id, project_id) VALUES (?, ?)", [pid, pid]);
  const [row] = await d1<{ id: string; created_at: string }>("INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?) RETURNING id, created_at", [crypto.randomUUID(), pid, role, content]);
  const m: Message = { id: row!.id, projectId: pid, role, content, createdAt: row!.created_at, version: 1 };
  await publish(c.task.user_id, "message", "upsert", m.id, 1, m);
  return m;
}
async function say(c: TaskContext, st: State, text: string, role: "user" | "assistant" = "assistant") {
  const m = await saveMessage(c, role, text);
  await c.emit("message", { messageId: m.id, round: st.round ?? 0 });
}
const phase = (c: TaskContext, name: string) => c.emit("phase", { phase: name });

/** Emits action.started, runs the work, then emits the completed/failed action with its real result. */
async function act<T>(c: TaskContext, st: State, a: { kind: string; running: string; done: string; failed?: string; round?: number }, work: () => Promise<{ ok: boolean; result?: T; error?: string; done?: string }> | { ok: boolean; result?: T; error?: string; done?: string }) {
  const id = `${c.task.id}-a${(st.n = (st.n ?? 0) + 1)}`;
  const round = a.round ?? st.round ?? 0;
  await c.emit("action.started", { id, round, kind: a.kind, title: a.running, target: null });
  let r: { ok: boolean; result?: T; error?: string; done?: string };
  try { r = await work(); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  await c.emit("action", { id, round, kind: a.kind, title: r.ok ? (r.done ?? a.done) : (a.failed ?? a.running), target: null, ok: r.ok, error: r.ok ? null : (r.error ?? "Failed").slice(0, 600) });
  return { id, ...r };
}

async function makeTools(store: MemoryFileStore) {
  const { AgentTools } = await import("../../../sandbox/intelligence/tools");
  const { validateProject } = await import("../../../sandbox/intelligence/validate");
  const { MemoryFileStore: MFS } = await import("../../../sandbox/workspace/workspace");
  const { movePath } = await import("../../../sandbox/filesystem/move");
  return new AgentTools({
    local: store, output: new MFS(), folders: () => store.folders(),
    write: (path, content) => { store.set({ path, content, encoding: "utf8", updatedAt: Date.now() }); },
    create: (path, content) => { if (store.get(path)) throw new Error(`File exists: ${path}`); store.set({ path, content, encoding: "utf8", updatedAt: Date.now() }); },
    remove: (path) => { store.delete(path); store.removeFolder(path); },
    move: (from, to) => { movePath(store, from, to); },
    build: () => { const v = validateProject(store); return v.errors.length ? { ok: false, errors: v.errors, warnings: v.warnings } : { ok: true, outputId: `rev`, files: store.list().length, warnings: v.warnings }; },
    lastOutput: () => null, outputStale: () => false, previewErrors: () => [], clearPreviewErrors: () => undefined,
  });
}

/** Stop takes effect while the model is still answering: poll the persisted cancel flag alongside the call. */
async function withCancel<T>(c: TaskContext, p: Promise<T>): Promise<T | null> {
  let poll: ReturnType<typeof setTimeout> | undefined;
  const watch = new Promise<null>((resolve) => { const tick = async () => { if (await c.cancelled().catch(() => false)) resolve(null); else poll = setTimeout(() => void tick(), 2000); }; poll = setTimeout(() => void tick(), 2000); });
  return Promise.race([p, watch]).finally(() => clearTimeout(poll));
}

async function end(c: TaskContext, st: State, status: "done" | "failed" | "denied", text: string, error?: string): Promise<StepResult> {
  await say(c, st, text);
  await phase(c, status === "done" ? "completed" : status);
  await c.emit("run.end", { status, ...(error ? { error } : {}), mutated: !!st.mutated, revision: st.baseRevision ?? 0 });
  // Successful builds of React + Vite projects start a runtime preview build (unchanged sources are skipped).
  if (status === "done" && c.task.project_id) {
    const { startBuild } = await import("@backend/build/pipeline.server");
    await startBuild(c.task.user_id, c.task.project_id).catch((e) => console.warn(`[build] auto preview skipped: ${(e as Error).message}`));
  }
  return { done: true, result: { status, mutated: !!st.mutated } };
}

// ---------------- planning ----------------
async function planStep(c: TaskContext, st: State, p: P): Promise<StepResult> {
  const pid = c.task.project_id!;
  const fs = await import("../../sandbox/fs.server");
  const { d1 } = await import("@backend/d1");
  await phase(c, "thinking");
  await c.progress(0.02, "Thinking");
  const { store } = await fs.loadStore(pid);
  const files = store.list().map((f) => f.path).sort();
  if (st.snippets === undefined) {
    // Inspect only the files that matter for a plan: small text sources, entry page first, capped context.
    const r = await act(c, st, { kind: "inspect", running: "Analyzing existing project", done: "Project analyzed" }, () => {
      const text = store.list().filter((f) => f.encoding === "utf8" && /\.(html?|css|js|mjs|json|md|txt|svg)$/i.test(f.path) && f.content.length < 60000)
        .sort((a, b) => (a.path === "index.html" ? -1 : b.path === "index.html" ? 1 : a.content.length - b.content.length)).slice(0, 8);
      let budget = 16000; const parts: string[] = [];
      for (const f of text) { if (budget <= 0) break; const s = f.content.slice(0, Math.min(4000, budget)); budget -= s.length; parts.push(`--- ${f.path}${f.content.length > s.length ? " (truncated)" : ""}\n${s}`); }
      return { ok: true, result: parts.join("\n"), done: files.length ? `Project analyzed · ${files.length} file${files.length === 1 ? "" : "s"}` : "Project analyzed · empty project" };
    });
    st.snippets = (r.result as string | undefined) ?? "";
  }
  if (await c.cancelled()) return { done: false, delayMs: 10 };
  await phase(c, "planning");
  await c.progress(0.08, "Creating Plan");
  const [proj] = await d1<{ name: string }>("SELECT name FROM projects WHERE id = ?", [pid]);
  const { createPlan } = await import("../../functions/ai/orchestrator.server");
  const out = await withCancel(c, createPlan({ model: p.model ?? "speed", depth: p.depth ?? "balanced", projectName: proj?.name ?? "project", prompt: p.prompt ?? "", files, snippets: st.snippets, previous: st.plan, feedback: st.feedback }));
  if (!out) return { done: false, delayMs: 10 };
  if (out.usedModel) await c.emit("model", { stage: "plan", model: out.usedModel, fallbacks: (out.fallbacks ?? []) as unknown as Json });
  if ("answer" in out) return end(c, st, "done", out.answer);
  st.plan = out.plan; st.planVersion = (st.planVersion ?? 0) + 1; delete st.feedback;
  await c.emit("plan", { version: st.planVersion, plan: out.plan as unknown as Json });
  await phase(c, "awaiting_approval");
  st.phase = "awaiting";
  return { done: false, wait: true };
}

async function decisionStep(c: TaskContext, st: State): Promise<StepResult> {
  const { d1 } = await import("@backend/d1");
  const [row] = await d1<{ seq: number; data: string }>("SELECT seq, data FROM task_events WHERE task_id = ? AND kind = 'plan.decision' AND seq > ? ORDER BY seq DESC LIMIT 1", [c.task.id, st.decisionSeq ?? 0]);
  if (!row) return { done: false, wait: true };
  st.decisionSeq = row.seq;
  const d = JSON.parse(row.data) as { decision: "approve" | "deny" | "edit"; feedback?: string | null };
  if (d.decision === "deny") return end(c, st, "denied", "Plan denied. No files were changed.");
  if (d.decision === "edit") {
    st.feedback = d.feedback ?? ""; st.phase = "planning";
    await say(c, st, st.feedback, "user");
    return { done: false, delayMs: 10 };
  }
  await c.emit("plan.approved", { version: st.planVersion ?? 1 });
  await phase(c, "thinking");
  await c.progress(0.12, "Thinking");
  await say(c, st, "I'll start building the project now.");
  await phase(c, "building");
  st.phase = "building"; st.round = 0; st.results = "";
  return { done: false, delayMs: 10 };
}

// ---------------- building ----------------
async function buildStep(c: TaskContext, st: State, p: P): Promise<StepResult> {
  const pid = c.task.project_id!;
  const round = st.round ?? 0;
  if (round >= MAX_ROUNDS) { st.phase = "validating"; return { done: false, delayMs: 10 }; }
  const fs = await import("../../sandbox/fs.server");
  const { d1 } = await import("@backend/d1");
  const prog = (label: string, frac = 0) => c.progress(0.15 + 0.6 * Math.min(1, (round + frac) / MAX_ROUNDS), label);
  await c.emit("step", { label: "Thinking", round });
  await prog("Thinking");

  const { store, revision } = await fs.loadStore(pid);
  const before = fs.snapshotStore(store);
  const hist = await d1<{ role: "user" | "assistant"; content: string }>(
    "SELECT role, content FROM (SELECT role, content, created_at, rowid AS r FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY created_at DESC, r DESC LIMIT 12) ORDER BY created_at, r", [pid]);
  const [proj] = await d1<{ name: string }>("SELECT name FROM projects WHERE id = ?", [pid]);
  const { runAgentRound, planText } = await import("../../functions/ai/orchestrator.server");
  const step = await withCancel(c, runAgentRound({ model: p.model ?? "speed", depth: p.depth ?? "balanced", plan: false, projectName: proj?.name ?? "project", round, files: store.list().map((f) => f.path).sort(), results: st.results ?? "", history: hist, ...(st.plan ? { approvedPlan: planText(st.plan) } : {}) }));
  if (!step) return { done: false, delayMs: 10 };
  await c.emit("model", { stage: "build", round, model: step.usedModel, fallbacks: step.fallbacks as unknown as Json });
  if (await c.cancelled()) return { done: false, delayMs: 10 };
  if (step.message && (step.actions.length || !step.done)) await say(c, st, step.message);

  const { WRITE_TOOLS, BUILD_TOOLS, formatToolResult } = await import("../../../sandbox/intelligence/tools");
  const tools = await makeTools(store);
  await c.emit("step", { label: "Working", round });
  const log: string[] = [];
  let built: boolean | null = null, wrote = false, stopped = false;
  const failedIds = st.failedIds ?? [];
  const created = new Set(st.created ?? []);
  for (const s of step.actions as Step[]) {
    // Cancellation is honoured between actions: no new file change starts after Stop.
    if (await c.cancelled()) { stopped = true; break; }
    if (s.kind === "think") { await act(c, st, { kind: "think", running: "Thinking", done: s.note ? `Planned: ${s.note.slice(0, 120)}` : "Planned next step", round }, () => ({ ok: true })); log.push("think: noted"); continue; }
    const { name, args } = toTool(s);
    if (BUILD_TOOLS.has(name)) {
      const r = await act(c, st, { ...labels(name, null), round }, () => {
        const res = tools.run(name, args);
        log.push(formatToolResult(name, res));
        const ok = res.success && (res.data as { ok: boolean }).ok;
        return { ok, ...(ok ? {} : { error: formatToolResult(name, res).slice(0, 600) }) };
      });
      built = r.ok; if (!r.ok) failedIds.push(r.id);
      continue;
    }
    const target = typeof args["path"] === "string" ? (args["path"] as string) : typeof args["query"] === "string" ? `"${args["query"] as string}"` : typeof args["selector"] === "string" ? (args["selector"] as string) : null;
    // A file in a folder that doesn't exist yet also creates the folder: shown as its own action.
    if (name === "create_file" && target && target.includes("/")) {
      const dir = target.slice(0, target.lastIndexOf("/"));
      const exists = store.folders().includes(dir) || store.list().some((f) => f.path.startsWith(`${dir}/`));
      if (!exists) await act(c, st, { kind: "create", running: `Creating ${dir}/`, done: `Created ${dir}/`, round }, () => { store.addFolder(dir); return { ok: true }; });
    }
    const L = labels(name, target);
    const r = await act(c, st, { kind: L.kind, running: L.running, done: L.done, failed: L.failed, round }, () => {
      const res = tools.run(name, args);
      log.push(formatToolResult(name, res));
      return res.success ? { ok: true } : { ok: false, error: res.error.message };
    });
    if (!r.ok) failedIds.push(r.id);
    if (r.ok && WRITE_TOOLS.has(name)) { wrote = true; if (name === "create_file" && target && !before.files.has(target)) created.add(target); }
  }
  st.created = [...created].slice(0, 200);
  if (wrote && built === null && !stopped) {
    const r = await act(c, st, { kind: "check", running: "Checking project", done: "Check passed", failed: "Check failed", round }, () => {
      const res = tools.run("build_project");
      log.push(`(automatic) ${formatToolResult("build_project", res)}`);
      const ok = res.success && (res.data as { ok: boolean }).ok;
      return { ok, ...(ok ? {} : { error: formatToolResult("build_project", res).slice(0, 600) }) };
    });
    built = r.ok; if (!r.ok) failedIds.push(r.id);
  }
  // Persist the round's changes as one revision (conflicts retry the whole round from fresh files).
  if (wrote) {
    await prog("Saving changes", 0.9);
    const r = await fs.commit(pid, revision, before, store, { taskId: c.task.id, label: step.message.slice(0, 80) });
    if (r.changed.length) {
      st.mutated = true;
      st.changed = [...new Set([...(st.changed ?? []), ...r.changed])].slice(0, 200);
      const { publish } = await import("@realtime/publish.server");
      await publish(c.task.user_id, "filerev", "upsert", `${pid}:${r.revision}`, r.revision, { id: `${pid}:${r.revision}`, projectId: pid, revision: r.revision, changed: r.changed.slice(0, 200), version: r.revision });
      await c.emit("files", { revision: r.revision, changed: r.changed.slice(0, 50) });
    }
  }
  if (stopped) return { done: false, delayMs: 10 };
  if (built !== null) st.lastCheck = built;
  if (built === true) { if (failedIds.length) await c.emit("fixed", { ids: failedIds }); st.failedIds = []; st.failedBuilds = 0; }
  else st.failedIds = failedIds.slice(-50);
  if (built === false && (st.failedBuilds = (st.failedBuilds ?? 0) + 1) >= MAX_REPAIRS) {
    return end(c, st, "failed", `Not finished. The project check still fails after ${MAX_REPAIRS} repair attempts:\n\n${log.filter((l) => /error/i.test(l)).slice(-1)[0]?.slice(0, 800) ?? "see the failed steps above."}`, `Stopped after ${MAX_REPAIRS} failed repair attempts.`);
  }
  st.results = log.join("\n").slice(0, 40000);
  st.round = round + 1;
  if (step.done && built !== false) {
    // A pure answer with no file work and nothing changed ends here; real builds go through validation.
    if (!st.mutated && !st.changed?.length) return end(c, st, "done", step.message || "Done. No files were changed.");
    st.phase = "validating";
    return { done: false, delayMs: 10 };
  }
  if (step.done && built === false) st.results += "\nYou said done, but the check failed — fix the errors above with targeted edits.";
  return { done: false, delayMs: 50 };
}

// ---------------- validating + testing ----------------
async function validateStep(c: TaskContext, st: State): Promise<StepResult> {
  const pid = c.task.project_id!;
  const fs = await import("../../sandbox/fs.server");
  const { store } = await fs.loadStore(pid);
  const tools = await makeTools(store);
  const { formatToolResult } = await import("../../../sandbox/intelligence/tools");
  const { validateProject } = await import("../../../sandbox/intelligence/validate");
  await phase(c, "validating");
  await c.progress(0.8, "Validating");
  const plan = st.plan;
  const changed = new Set(st.changed ?? []);
  const v = await act(c, st, { kind: "check", running: "Validating requirements", done: "Requirements verified", failed: "Validation failed" }, () => {
    const issues: string[] = [];
    // Vite keeps index.html at the root, so a planned CRA-style public/index.html is satisfied by it.
    const exists = (f: string) => !!store.get(f) || (f === "public/index.html" && !!store.get("index.html"));
    for (const f of plan?.create ?? []) if (!exists(f)) issues.push(`Planned file ${f} was not created.`);
    for (const f of plan?.modify ?? []) if (!store.get(f)) issues.push(`Planned file ${f} is missing.`); else if (!changed.has(f)) issues.push(`Planned change to ${f} was not made.`);
    if (!store.get("index.html") && store.list().some((f) => /\.html?$/.test(f.path))) issues.push("index.html is missing at the project root.");
    // Every stylesheet / script must be linked from some page, otherwise the requested design/behaviour never shows.
    const pages = store.list().filter((f) => /\.html?$/.test(f.path)).map((f) => f.content).join("\n");
    for (const f of store.list()) {
      if (!/\.(css|js)$/.test(f.path) || !changed.has(f.path)) continue;
      const base = f.path.split("/").pop()!;
      const usedByOther = store.list().some((o) => o.path !== f.path && o.content.includes(base));
      if (!pages.includes(base) && !usedByOther) issues.push(`${f.path} is not linked from any page.`);
    }
    const proj = validateProject(store);
    for (const e of proj.errors.slice(0, 10)) { const d = e as unknown as { path?: string; line?: number; message?: string }; issues.push(`${d.path ? `${d.path}${d.line ? `:${d.line}` : ""}: ` : ""}${d.message ?? JSON.stringify(e).slice(0, 300)}`); };
    const refs = tools.run("validate_references", {});
    if (!refs.success) issues.push(refs.error.message);
    else if (((refs.data as { errors?: unknown[] })?.errors?.length ?? 0) > 0) issues.push(formatToolResult("validate_references", refs).slice(0, 800));
    return issues.length ? { ok: false, result: issues, error: issues.slice(0, 6).join("\n") } : { ok: true, result: [] };
  });
  let issues = (v.result as string[] | undefined) ?? [];
  st.validation = v.ok ? "Passed" : "Failed";
  if (v.ok) {
    // Testing: the Sandbox-only architecture has no terminal/browser runtime yet, so the test is the transactional
    // static build (validate → stage → verify). Speed Runtime can replace this step with a real build + run later.
    await phase(c, "testing");
    await c.progress(0.9, "Testing");
    const t = await act(c, st, { kind: "check", running: "Building and testing project", done: "Build test passed", failed: "Build test failed" }, () => {
      const res = tools.run("build_project");
      const ok = res.success && (res.data as { ok: boolean }).ok;
      return ok ? { ok: true } : { ok: false, error: formatToolResult("build_project", res).slice(0, 800) };
    });
    st.test = t.ok ? "Passed" : "Failed";
    if (!t.ok) issues = [t.error ?? "Build test failed"];
  }
  if (!issues.length) {
    const created = (st.created ?? []).filter((f) => store.get(f));
    const modified = (st.changed ?? []).filter((f) => !created.includes(f) && store.get(f));
    const deleted = (st.changed ?? []).filter((f) => !store.get(f));
    const feats = [...(plan?.pages ?? []), ...(plan?.functional ?? []), ...(plan?.design ?? [])].slice(0, 8);
    const list = (h: string, l: string[]) => (l.length ? `${h}:\n${l.slice(0, 20).map((x) => `- ${x}`).join("\n")}` : "");
    const text = ["Build Complete", plan?.summary || plan?.title || "", list("Implemented", feats), list("Files created", created), list("Files modified", modified), list("Files deleted", deleted), `Validation: ${st.validation}\nBuild/Test: ${st.test ?? "Passed"}`].filter(Boolean).join("\n\n");
    return end(c, st, "done", text);
  }
  st.fixAttempts = (st.fixAttempts ?? 0) + 1;
  if (st.fixAttempts > MAX_FIX_ATTEMPTS) {
    return end(c, st, "failed", `Not finished. Validation still fails after ${MAX_FIX_ATTEMPTS} automatic fixes:\n\n${issues.slice(0, 6).map((i) => `- ${i}`).join("\n")}`, "Validation failed after automatic fixes.");
  }
  // Automatic fix: back to Thinking → Action with the real failures, then validate again.
  st.phase = "building";
  st.results = `VALIDATION FAILED (fix attempt ${st.fixAttempts}/${MAX_FIX_ATTEMPTS}). Fix exactly these problems with targeted edits, then set done:\n${issues.map((i) => `- ${i}`).join("\n")}`;
  st.round = Math.min(st.round ?? 0, MAX_ROUNDS - 2);
  await phase(c, "building");
  return { done: false, delayMs: 10 };
}

export const agentHandler: TaskHandler = {
  maxRetries: 3,
  async step(c) {
    const pid = c.task.project_id;
    if (!pid) throw new FatalError("A project is required");
    const p = c.payload as P;
    const st = c.state as State;
    if (!st.phase) {
      if (!p.prompt) throw new FatalError("A prompt is required");
      const fs = await import("../../sandbox/fs.server");
      st.baseRevision = await fs.ensureProject(c.task.user_id, pid);
      const um = await saveMessage(c, "user", p.prompt);
      await c.emit("run.start", { prompt: p.prompt.slice(0, 500), messageId: um.id, clientMessageId: p.clientMessageId ?? null, revision: st.baseRevision });
      st.phase = "planning";
    }
    switch (st.phase) {
      case "planning": return planStep(c, st, p);
      case "awaiting": return decisionStep(c, st);
      case "building": return buildStep(c, st, p);
      case "validating": return validateStep(c, st);
    }
  },
  async onCancel(c) {
    const st = c.state as State;
    await c.emit("phase", { phase: "cancelled" }).catch(() => undefined);
    await c.emit("run.end", { status: "stopped", mutated: !!st.mutated, revision: st.baseRevision ?? 0 });
  },
};
