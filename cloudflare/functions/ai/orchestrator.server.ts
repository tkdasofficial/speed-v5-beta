// AI orchestration: maps logical modes (speed/flash/heavy × quick/balanced/deep) to the configured model chains.
// Server-only. Model IDs, routing rules and provider keys never leave the Worker. Models are configured in ./models.ts.
import { envStr } from "../context";
import { chainFor, isNemotron, MAX_OUTPUT_TOKENS, PROVIDERS, type ModelTarget } from "./models";

export type AiModel = "speed" | "flash" | "heavy";
export type AiDepth = "quick" | "balanced" | "deep";
type Msg = { role: "system" | "user" | "assistant"; content: string };

const SPECIALIST: Record<"omni" | "safety", ModelTarget> = {
  omni: { provider: "nvidia", id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" },
  safety: { provider: "nvidia", id: "nvidia/nemotron-3.5-content-safety" },
};

// Depth changes real orchestration: context window, reasoning, output budget, planning and a verification pass.
const DEPTH: Record<AiDepth, { history: number; maxTokens: number; think: boolean; verify: boolean; guide: string }> = {
  quick: { history: 6, maxTokens: MAX_OUTPUT_TOKENS, think: false, verify: false, guide: "Answer directly and concisely. Skip planning unless essential." },
  balanced: { history: 16, maxTokens: MAX_OUTPUT_TOKENS, think: true, verify: false, guide: "Briefly plan, then answer. Check your work where it matters." },
  deep: { history: 30, maxTokens: MAX_OUTPUT_TOKENS, think: true, verify: true, guide: "Plan thoroughly step by step, consider edge cases, then give a complete, carefully verified answer." },
};

export class AiError extends Error {}
/** A real provider failure (rate limit, timeout, 5xx, outage, connection, bad response): the chain moves to the next model. */
class ProviderError extends Error {}

// A hung provider must surface as an error, never an endless "Thinking…".
const FIRST_BYTE_MS = 170_000, IDLE_MS = 30_000;

type CallOpts = { maxTokens: number; think: boolean; firstByteMs?: number };

/** Provider-specific request shaping (reasoning flags differ per provider). */
function body(t: ModelTarget, messages: Msg[], o: CallOpts) {
  if (isNemotron(t)) {
    const msgs = messages.map((m, i) => (i === 0 && m.role === "system" ? { ...m, content: `${m.content} ${o.think ? "/think" : "/no_think"}` } : m));
    return { model: t.id, messages: msgs, max_tokens: o.maxTokens, stream: true, chat_template_kwargs: { enable_thinking: o.think }, ...(o.think ? {} : { temperature: 0.3 }) };
  }
  if (t.provider === "groq") return { model: t.id, messages, max_tokens: o.maxTokens, stream: true, reasoning_effort: o.think ? "medium" : "low" };
  return { model: t.id, messages, max_tokens: o.maxTokens, stream: true };
}

async function call(t: ModelTarget, messages: Msg[], opts: CallOpts) {
  const key = envStr(PROVIDERS[t.provider].secret);
  if (!key) throw new ProviderError(`${t.provider} is not configured`);
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(), opts.firstByteMs ?? FIRST_BYTE_MS);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), IDLE_MS); };
  let res: Response;
  try {
    res = await fetch(PROVIDERS[t.provider].url, {
      signal: ctl.signal,
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body(t, messages, opts)),
    });
  } catch {
    clearTimeout(timer);
    throw new ProviderError(ctl.signal.aborted ? "timeout" : "connection failed");
  }
  if (!res.ok) {
    clearTimeout(timer);
    await res.body?.cancel().catch(() => undefined);
    throw new ProviderError(`HTTP ${res.status}`);
  }
  // Streamed server-side so long generations never hit idle timeouts; only final text is kept.
  let out = "", buf = "";
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  for (;;) {
    bump();
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch { clearTimeout(timer); throw new ProviderError("timeout"); }
    const { done, value } = chunk;
    if (done) { clearTimeout(timer); break; }
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      const s = l.trim();
      if (!s.startsWith("data:") || s === "data: [DONE]") continue;
      try { out += (JSON.parse(s.slice(5)) as { choices?: { delta?: { content?: string | null } }[] }).choices?.[0]?.delta?.content ?? ""; } catch { /* partial */ }
    }
  }
  return out.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export type ChainResult<T> = { value: T; text: string; used: ModelTarget; failed: { model: string; reason: string }[] };

/**
 * Runs the role's chain: primary, then the common fallbacks in order. Moves on only on a real provider failure
 * or a response `accept` rejects; never loops back. All failing → one clear AiError.
 */
async function callChain<T>(chain: ModelTarget[], messages: Msg[], opts: CallOpts, accept: (text: string) => T | null): Promise<ChainResult<T>> {
  const failed: { model: string; reason: string }[] = [];
  for (const t of chain) {
    try {
      const text = await call(t, messages, opts);
      const value = text ? accept(text) : null;
      if (value === null) throw new ProviderError("invalid or empty response");
      if (failed.length) console.warn(`[ai] fell back to ${t.provider}/${t.id} after: ${failed.map((f) => `${f.model} (${f.reason})`).join(", ")}`);
      return { value, text, used: t, failed };
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      console.error(`[ai] ${t.provider}/${t.id} failed: ${e.message}`);
      failed.push({ model: `${t.provider}/${t.id}`, reason: e.message });
    }
  }
  throw new AiError("All AI models are unavailable right now. Try again in a moment.");
}

const usedLabel = (t: ModelTarget) => `${t.provider}/${t.id}`;

/** Content-safety specialist; returns false only when the input is clearly flagged unsafe. Fails open on specialist errors. */
async function isSafe(text: string) {
  try {
    const out = await call(SPECIALIST.safety, [{ role: "user", content: text.slice(0, 4000) }], { maxTokens: 64, think: false, firstByteMs: 10_000 });
    return !/"?user safety"?\s*:\s*"?unsafe/i.test(out);
  } catch (e) {
    console.error("[ai] safety specialist failed:", (e as Error).message);
    return true;
  }
}

const PLAN_RULES = " PLAN MODE IS ON: only discuss and plan. Do not build, write code files, create, edit or delete files, or claim any change was made. Reply with a clear plan: goal, approach, steps, files likely affected, and open questions. End by telling the user to turn Plan off when they want it built.";

const hasMedia = (t: string) => /https?:\/\/\S+\.(png|jpe?g|gif|webp|mp4|mov|wav|mp3)(\?\S*)?/i.test(t);
const nonEmpty = (t: string) => (t ? t : null);

export async function runAgent(input: { model: AiModel; depth: AiDepth; plan?: boolean; history: Msg[]; projectName: string }) {
  const d = DEPTH[input.depth];
  const last = input.history[input.history.length - 1]?.content ?? "";
  const safe = isSafe(last);
  // Multimodal input is tried on the omni specialist first; the role's chain still backs it up.
  const chain = hasMedia(last) ? [SPECIALIST.omni, ...chainFor(input.model)] : chainFor(input.model);
  const system = `You are Speed, an AI software agent helping build the project "${input.projectName}". ${d.guide}${input.plan ? PLAN_RULES : ""}`;
  const messages: Msg[] = [{ role: "system", content: system }, ...input.history.slice(-d.history)];
  const opts = { maxTokens: d.maxTokens, think: d.think };
  const [first, ok] = await Promise.all([callChain(chain, messages, opts, nonEmpty), safe]);
  if (!ok) return "I can't help with that request.";
  let answer = first.value;
  if (d.verify) {
    // The verification pass stays on the model that answered; it never switches providers after success.
    const reviewed = await call(first.used, [
      ...messages,
      { role: "assistant", content: answer },
      { role: "user", content: "Review your answer above for errors, gaps or missed requirements. Reply with only the final corrected answer (or the same answer if it is already correct)." },
    ], opts).catch(() => "");
    if (reviewed) answer = reviewed;
  }
  return answer.slice(0, 20000);
}

// ---- Agent loop: message → actions → message … ----
export type AgentActionKind = "read" | "create" | "edit" | "delete" | "think" | "check" | "tool";
export type AgentStepAction = { kind: AgentActionKind; path?: string; content?: string; find?: string; replace?: string; note?: string; name?: string; args?: Record<string, unknown> };
const KINDS: AgentActionKind[] = ["read", "create", "edit", "delete", "think", "check", "tool"];
/** Internal tools that change files or build; stripped in plan mode. */
const WRITE_TOOLS = new Set(["create_file", "edit_file", "patch_file", "delete_file", "rename_file", "move_file", "rollback_change", "build_project", "build_static"]);
const WRITE_KINDS: AgentActionKind[] = ["create", "edit", "delete", "check"];

const LOOP_RULES = `You are a codebase editing agent working in a loop. Each turn reply with ONLY one JSON object, no prose:
{"message": "1-3 short sentences to the user: what you found/did and what's next", "actions": [...], "done": false}
Actions run on the project's real files; their results come back to you next turn.
Call internal tools as {"kind":"tool","name":"<tool>","args":{...}}. Tools:
DISCOVER: list_files{dir?}, list_directories, get_file_tree, file_exists{path}, get_file_metadata{path}
SEARCH (line numbers): search_text{query, mode?:"exact"|"fuzzy"|"regex", ext?:["css"], dir?}, search_filename{query}, find_html_elements{selector:"button.hero-cta"|"#id"|"nav"}, find_css_selectors{selector:".hero-cta"}, find_js_symbols{name}, find_references{name}, find_imports{path?}, find_exports{path?}
INSPECT: read_file{path}, read_file_range{path,start,end}, get_file_outline{path}, get_code_context{path,line,radius?}
UNDERSTAND: analyze_file_dependencies{path}, get_dependency_graph, find_related_files{path}, find_asset_references{path?}, find_broken_references
EDIT (targeted): edit_file{path,find,replace,reason} (find must be exact and unique), patch_file{path,edits:[{find,replace}],reason}, create_file{path,content,reason} (new files or full rewrite only when needed), delete_file{path} (refuses while referenced), rename_file{path,name}, move_file{path,to}
VALIDATE: validate_project, validate_html|validate_css|validate_javascript|validate_json{path}, validate_references, validate_assets
BUILD: build_project (validates .local, builds into a staged output, swaps .output only on success; a failed build keeps the last good .output), get_build_status, get_build_logs
ERRORS: get_errors, get_error_context{path,line}, find_related_error_files{path}, classify_error{message}
CHANGES: get_changed_files, get_change_diff{path?|change?}, rollback_change{change?} (undo your own bad edit before retrying)
PREVIEW: check_preview (verifies built assets resolve), capture_preview_errors (runtime script errors)
Also allowed: {"kind":"think","note":"short plan"}.
RULES:
1. Never guess a file location when the codebase can be searched. Search before editing; read the relevant lines before modifying.
2. .local is the source of truth (paths are relative to it). .output is generated and read-only — never edit it; change .local and rebuild.
3. Make the smallest possible change: touch only the files needed, preserve unrelated code, styles and behaviour; no refactors or renames unless required. CSS-only requests change only CSS.
4. If HTML and JS/CSS must change together, confirm the relationship (selectors, ids, imports) first.
5. Validate before building when possible; always read the actual build errors. Fix the root cause with a targeted edit on the reported file/line — never regenerate the whole project for a localized error.
6. Each repair must be based on the latest real error. After repeated failure, stop and explain the remaining error.
7. Files you change are built automatically at the end of the turn if you didn't call build_project; you only see that result next turn.
8. Two project types. Static site (default): index.html at the root, relative paths, plain HTML/CSS/JS (ES modules via relative .js imports or full CDN URLs), no npm. React + Vite (when the user asks for React/TypeScript/Vite or package.json already lists vite): keep real React + TypeScript with package.json (react, react-dom, vite, @vitejs/plugin-react, typescript), vite.config.ts, tsconfig.json, root index.html loading /src/main.tsx and .tsx files under src/; create package.json and vite.config.ts first; npm imports are fine — a separate build runtime compiles it after your turn. Never convert a React/TypeScript request into a CDN or plain-JS site.
9. New project? Create the files directly (still keep them small and linked correctly), then build.
At most 8 actions per turn. When the work is complete and the last build passed, reply with "actions": [] and "done": true, and a short final summary of what the user can try in the preview.
If the user only asked a question, answer in "message" with "done": true. Keep messages concise; tool details stay internal.`;
const PLAN_LOOP = " PLAN MODE IS ON: only use read/search/inspect/understand/validate tools and think, never edit, create, delete or build. When you have a plan, put it in message and set done true.";

function parseStep(text: string): { message: string; actions: AgentStepAction[]; done: boolean } | null {
  const t = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(t.slice(a, b + 1)) as { message?: unknown; actions?: unknown; done?: unknown };
    const message = typeof o.message === "string" ? o.message.trim() : "";
    // Models often name the tool directly ({"kind":"create_file"} / {"tool":"x"} / {"type":"x"}); normalize to the contract.
    const norm = (raw: unknown): unknown => {
      if (!raw || typeof raw !== "object") return raw;
      const x = { ...(raw as Record<string, unknown>) };
      const k = (x["kind"] ?? x["type"] ?? x["action"]) as string | undefined;
      const tool = (x["tool"] ?? x["name"]) as string | undefined;
      if (typeof k === "string" && KINDS.includes(k as AgentActionKind)) return { ...x, kind: k };
      const name = typeof k === "string" && /_/.test(k) ? k : typeof tool === "string" ? tool : undefined;
      if (!name) return x;
      const { kind: _k, type: _t, action: _a, tool: _o, name: _n, args, ...rest } = x;
      return { kind: "tool", name, args: args && typeof args === "object" ? args : rest };
    };
    const actions = (Array.isArray(o.actions) ? o.actions.map(norm) : []).filter((x): x is AgentStepAction => !!x && typeof x === "object" && KINDS.includes((x as AgentStepAction).kind)).slice(0, 12)
      .map((x) => ({ kind: x.kind, ...(typeof x.path === "string" ? { path: x.path.slice(0, 400) } : {}), ...(typeof x.content === "string" ? { content: x.content.slice(0, 200000) } : {}), ...(typeof x.find === "string" ? { find: x.find } : {}), ...(typeof x.replace === "string" ? { replace: x.replace } : {}), ...(typeof x.note === "string" ? { note: x.note.slice(0, 500) } : {}), ...(typeof x.name === "string" ? { name: x.name.slice(0, 60) } : {}), ...(x.args && typeof x.args === "object" && !Array.isArray(x.args) ? { args: x.args } : {}) }));
    if (!message && !actions.length) return null;
    return { message: message || "Working on it.", actions, done: o.done === true };
  } catch { return null; }
}

export async function runAgentRound(input: { model: AiModel; depth: AiDepth; plan?: boolean; history: Msg[]; projectName: string; round: number; files: string[]; results: string; approvedPlan?: string }) {
  const d = DEPTH[input.depth];
  // Safety runs in parallel with the main call so it never adds latency.
  const safe = input.round === 0 && !input.approvedPlan ? isSafe(input.history[input.history.length - 1]?.content ?? "") : Promise.resolve(true);
  const system = `You are Speed, an AI software agent building the project "${input.projectName}". ${d.guide}\n${LOOP_RULES}${input.plan ? PLAN_LOOP : ""}`;
  const approved = input.approvedPlan ? `APPROVED PLAN (implement all of it; every listed file must exist, be linked and contain the requested design/behaviour):\n${input.approvedPlan}\n` : "";
  const state = `${approved}Turn ${input.round + 1}. Project files (${input.files.length}): ${input.files.length ? input.files.join(", ") : "(empty project)"}\n${input.results ? `Results of your last actions:\n${input.results}` : "No actions run yet."}\nReply with the JSON object only.`;
  const messages: Msg[] = [{ role: "system", content: system }, ...input.history.slice(-d.history), { role: "user", content: state }];
  const opts = { maxTokens: MAX_OUTPUT_TOKENS, think: d.think };
  // An unparseable reply counts as a provider failure, so the chain moves to the next model.
  const [res, ok] = await Promise.all([callChain(chainFor(input.model), messages, opts, parseStep), safe]);
  if (!ok) return { message: "I can't help with that request.", actions: [] as AgentStepAction[], done: true, usedModel: usedLabel(res.used), fallbacks: res.failed };
  const step = res.value;
  if (input.plan) step.actions = step.actions.filter((x) => !WRITE_KINDS.includes(x.kind) && !(x.kind === "tool" && WRITE_TOOLS.has(x.name ?? "")));
  if (!step.actions.length) step.done = true;
  return { ...step, message: step.message.slice(0, 4000), usedModel: usedLabel(res.used), fallbacks: res.failed };
}

// ---- Planning: one concise structured plan from the real project state, before anything is built ----
export type AgentPlan = { title: string; summary: string; create: string[]; modify: string[]; pages: string[]; design: string[]; functional: string[]; validation: string[] };
const PLAN_PROMPT = `You plan changes for a website project. Two project types: static site (plain HTML/CSS/JS, index.html at the root, relative paths, no build tools) and React + Vite (real React + TypeScript: package.json with react, react-dom, vite, @vitejs/plugin-react, typescript; vite.config.ts; tsconfig.json; root index.html loading /src/main.tsx; .tsx files under src/). A separate build runtime compiles React + Vite projects after editing, so never say they can't be built.
Reply with ONLY one JSON object, no prose:
{"type":"plan","title":"short title","summary":"1-2 sentences","create":["new file paths"],"modify":["existing file paths to change"],"pages":["pages/components/sections required"],"design":["design requirements"],"functional":["functional requirements"],"validation":["checks that prove the request is done"]}
Any request to build, create, make, design or change something ALWAYS returns a plan — even for an empty project (then "create" lists every file to add, including package.json and vite.config.ts for React requests). Only reply {"type":"answer","answer":"..."} when the user asked a pure question that needs no file changes at all.
Rules: base the plan on the real files shown; modify only files that exist; styling requests need a CSS file (or existing stylesheet) that is linked from the HTML; keep each list short (at most 8 items, each under 120 characters). React + Vite projects put index.html at the project ROOT (never public/index.html) and use src/main.tsx (never react-scripts / Create React App files).`;

const strs = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim().slice(0, 200)).slice(0, 12) : []);

export async function createPlan(input: { model: AiModel; depth: AiDepth; projectName: string; prompt: string; files: string[]; snippets: string; previous?: AgentPlan | undefined; feedback?: string | undefined }): Promise<({ answer: string } | { plan: AgentPlan }) & { usedModel?: string; fallbacks?: { model: string; reason: string }[] }> {
  const safe = input.previous ? Promise.resolve(true) : isSafe(input.prompt);
  const ctx = `Project "${input.projectName}". Files (${input.files.length}): ${input.files.join(", ") || "(empty project)"}\n${input.snippets ? `Relevant file contents:\n${input.snippets}` : ""}`;
  const messages: Msg[] = [
    { role: "system", content: PLAN_PROMPT },
    { role: "user", content: `${ctx}\n\nRequest: ${input.prompt}${input.previous ? `\n\nCurrent plan:\n${JSON.stringify(input.previous)}\n\nThe user wants this changed in the plan: ${input.feedback ?? ""}\nReturn the full updated plan.` : ""}` },
  ];
  const opts = { maxTokens: MAX_OUTPUT_TOKENS, think: false };
  const parse = (t: string) => {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)) as Record<string, unknown>; } catch { return null; }
  };
  let [res, ok] = await Promise.all([callChain(chainFor(input.model), messages, opts, parse), safe]);
  if (!ok) return { answer: "I can't help with that request." };
  let o = res.value;
  let meta = { usedModel: usedLabel(res.used), fallbacks: res.failed };
  // Safety net: a build/create request must never be answered with prose. Retry once demanding a plan.
  const wantsBuild = /\b(build|create|make|design|develop|generate|add|implement|code|write)\b/i.test(input.prompt);
  if (o["type"] === "answer" && wantsBuild && !input.previous) {
    res = await callChain(chainFor(input.model), [...messages, { role: "assistant", content: JSON.stringify(o) }, { role: "user", content: "That is a build request, not a question. Reply with the {\"type\":\"plan\",...} JSON object only — list every file to create." }], opts, parse);
    o = res.value;
    meta = { usedModel: usedLabel(res.used), fallbacks: [...meta.fallbacks, ...res.failed] };
  }
  if (o["type"] === "answer" && typeof o["answer"] === "string" && !input.previous && !wantsBuild) return { answer: o["answer"].slice(0, 8000), ...meta };
  const plan: AgentPlan = {
    title: typeof o["title"] === "string" ? o["title"].slice(0, 120) : "Implementation plan",
    summary: typeof o["summary"] === "string" ? o["summary"].slice(0, 600) : "",
    create: strs(o["create"]), modify: strs(o["modify"]).filter((f) => input.files.includes(f)), pages: strs(o["pages"]),
    design: strs(o["design"]), functional: strs(o["functional"]), validation: strs(o["validation"]),
  };
  // A file the plan "modifies" that doesn't exist yet is really a creation.
  for (const f of strs(o["modify"])) if (!input.files.includes(f) && !plan.create.includes(f)) plan.create.push(f);
  plan.create = normalizePlanPaths(plan.create, input.files);
  return { plan, ...meta };
}

/** Vite serves index.html from the project root; models often plan Create-React-App paths (public/index.html)
 *  that the builder correctly refuses to create. Map them to the real Vite paths. */
export function normalizePlanPaths(create: string[], existing: string[]): string[] {
  const all = [...create, ...existing];
  const vite = all.some((f) => /^vite\.config\.(ts|js|mts|mjs)$/.test(f) || /^src\/.+\.tsx$/.test(f) || f === "package.json");
  const out: string[] = [];
  for (let f of create) {
    f = f.replace(/^\.?\//, "");
    if (vite && f === "public/index.html") f = "index.html";
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

export function planText(p: AgentPlan) {
  const sec = (h: string, l: string[]) => (l.length ? `${h}:\n${l.map((x) => `- ${x}`).join("\n")}` : "");
  return [p.title, p.summary, sec("Create", p.create), sec("Modify", p.modify), sec("Pages/components", p.pages), sec("Design", p.design), sec("Functional", p.functional), sec("Validation", p.validation)].filter(Boolean).join("\n\n");
}
