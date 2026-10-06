// Structured Agent context: only the files relevant to the task, plus stage/actions/results. Pure.
import type { SubTask } from "./grouping";

export interface FileLike { path: string; content: string; encoding?: string }
export interface AgentContext {
  request: string;
  project: { id: string; name: string; fileCount: number };
  tasks: SubTask[];
  stage: string;
  relevantFiles: { path: string; score: number; snippet: string }[];
  completedActions: string[];
  pendingActions: string[];
  build: string | null;
  verification: string | null;
  previousMessages: string[];
  checkpoint: Record<string, unknown> | null;
}

const TEXT = /\.(html?|css|scss|jsx?|tsx?|mjs|json|md|txt|svg|vue)$/i;
const STOP = new Set(["the", "and", "a", "an", "to", "of", "in", "on", "for", "with", "change", "update", "modify", "make", "set", "add", "text", "primary", "new", "it", "my"]);
const words = (t: string) => [...new Set(t.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])].filter((w) => !STOP.has(w));

/** Scores files by path hints and content keywords; never returns the whole project. */
export function selectRelevantFiles(files: FileLike[], tasks: SubTask[], limit = 8): { path: string; score: number }[] {
  const hints = tasks.flatMap((t) => t.hints);
  const kw = words(tasks.map((t) => t.text).join(" "));
  const scored = files.filter((f) => (f.encoding ?? "utf8") === "utf8" && TEXT.test(f.path) && f.content.length < 200_000 && !/(^|\/)(node_modules|dist|\.output)\//.test(f.path))
    .map((f) => {
      const p = f.path.toLowerCase(); const c = f.content.toLowerCase();
      let s = 0;
      for (const h of hints) if (p.includes(h)) s += 5;
      for (const w of kw) { if (p.includes(w)) s += 3; if (c.includes(w)) s += 1; }
      if (/(^|\/)(index\.html|app\.[jt]sx?|main\.[jt]sx?)$/.test(p)) s += 1;
      return { path: f.path, score: s };
    })
    .filter((x) => x.score > 1)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit);
}

export function buildContext(i: { request: string; projectId: string; projectName: string; files: FileLike[]; tasks: SubTask[]; stage: string; completed?: string[]; pending?: string[]; build?: string | null; verification?: string | null; previous?: string[]; checkpoint?: Record<string, unknown> | null; snippetBudget?: number }): AgentContext {
  const picked = selectRelevantFiles(i.files, i.tasks);
  let budget = i.snippetBudget ?? 16_000;
  const relevantFiles = picked.map((p) => {
    const f = i.files.find((x) => x.path === p.path)!;
    const snippet = budget > 0 ? f.content.slice(0, Math.min(4000, budget)) : "";
    budget -= snippet.length;
    return { ...p, snippet };
  });
  return {
    request: i.request, project: { id: i.projectId, name: i.projectName, fileCount: i.files.length }, tasks: i.tasks, stage: i.stage, relevantFiles,
    completedActions: i.completed ?? [], pendingActions: i.pending ?? [], build: i.build ?? null, verification: i.verification ?? null,
    previousMessages: (i.previous ?? []).slice(-6), checkpoint: i.checkpoint ?? null,
  };
}

export function contextSnippets(c: AgentContext): string {
  return c.relevantFiles.filter((f) => f.snippet).map((f) => `--- ${f.path}\n${f.snippet}`).join("\n");
}
