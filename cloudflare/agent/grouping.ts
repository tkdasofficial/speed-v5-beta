// Task analysis + grouping (pure). Splits one request into sub-tasks, classifies risk, and batches compatible small edits.
export type TaskKind = "copy" | "style" | "link" | "content" | "structure" | "dependency" | "delete" | "logic";
export type Risk = "low" | "medium" | "high";
export interface SubTask { id: string; text: string; kind: TaskKind; risk: Risk; hints: string[] }
export interface Batch { id: string; taskIds: string[]; kind: "grouped" | "single"; risk: Risk; label: string }

const VERB = "(?:update|change|modify|add|remove|delete|rename|replace|make|set|fix|create|move|edit|use|show|hide|insert|turn|swap|build|implement|install)";
const MAX_BATCH = 6;

/** Splits a request into individual instructions (lines, bullets, numbering, ";", ", and <verb>", " and <verb>"). */
export function splitTasks(text: string): string[] {
  const parts = text
    .split(/\n+|;\s*|(?:^|\s)\d+[.)]\s+|(?:^|\n)\s*[-*•]\s+/)
    .flatMap((p) => p.split(new RegExp(`,?\\s+(?:and|then|also)\\s+(?=${VERB}\\b)|,\\s+(?=${VERB}\\b)`, "i")))
    .map((s) => s.trim().replace(/^(?:and|then|also)\s+/i, "").replace(/[.,]+$/, "").trim())
    .filter((s) => s.length > 2);
  return parts.length ? parts : [text.trim()].filter(Boolean);
}

const HINTS: [RegExp, string[]][] = [
  [/\b(home ?page|landing|home|hero)\b/i, ["index", "home", "app", "hero", "landing"]],
  [/\btitle\b/i, ["index.html", "title", "hero", "header"]],
  [/\bbutton|cta\b/i, ["button", "cta", "hero"]],
  [/\bfooter\b/i, ["footer"]],
  [/\bheader|nav(bar|igation)?\b/i, ["header", "nav"]],
  [/\b(colou?r|style|font|css|theme|spacing)\b/i, [".css", "style", "theme"]],
  [/\bform\b/i, ["form"]],
];

export function classify(text: string): { kind: TaskKind; risk: Risk } {
  const t = text.toLowerCase();
  if (/\b(delete|remove)\b.*\b(file|page|folder|component|route)s?\b/.test(t)) return { kind: "delete", risk: "high" };
  if (/\b(install|dependency|package|npm|upgrade|library)\b/.test(t)) return { kind: "dependency", risk: "high" };
  if (/\b(auth|login|payment|database|api|backend|refactor|migrat|security|state management)\b/.test(t)) return { kind: "logic", risk: "high" };
  if (/\b(new page|create (a )?page|route|component|section|layout|restructure)\b/.test(t)) return { kind: "structure", risk: "medium" };
  if (/\b(colou?r|style|font|css|theme|spacing|padding|margin|size)\b/.test(t)) return { kind: "style", risk: "low" };
  if (/\b(link|href|url)\b/.test(t)) return { kind: "link", risk: "low" };
  if (/\b(text|title|heading|label|copy|wording|caption|button|placeholder)\b/.test(t)) return { kind: "copy", risk: "low" };
  return { kind: "content", risk: t.length > 160 ? "medium" : "low" };
}

export function analyzeTask(text: string): SubTask[] {
  return splitTasks(text).map((s, i) => {
    const c = classify(s);
    const hints = [...new Set(HINTS.filter(([re]) => re.test(s)).flatMap(([, h]) => h))];
    return { id: `t${i + 1}`, text: s.slice(0, 300), ...c, hints };
  });
}

/** Low-risk small edits share one batch (max 6); medium/high-risk work runs alone so failures stay isolated. */
export function groupTasks(tasks: SubTask[]): Batch[] {
  const batches: Batch[] = [];
  let open: Batch | null = null;
  for (const t of tasks) {
    if (t.risk === "low") {
      if (!open || open.taskIds.length >= MAX_BATCH) { open = { id: `b${batches.length + 1}`, taskIds: [], kind: "grouped", risk: "low", label: "" }; batches.push(open); }
      open.taskIds.push(t.id);
    } else {
      batches.push({ id: `b${batches.length + 1}`, taskIds: [t.id], kind: "single", risk: t.risk, label: "" });
    }
  }
  for (const b of batches) {
    if (b.kind === "grouped" && b.taskIds.length === 1) b.kind = "single";
    b.label = b.taskIds.map((id) => tasks.find((t) => t.id === id)!.text).join(" · ").slice(0, 200);
  }
  return batches;
}

export function batchPrompt(tasks: SubTask[], batches: Batch[]): string {
  return batches.map((b) => `${b.id} (${b.kind}, ${b.risk} risk): ${b.taskIds.map((id) => tasks.find((t) => t.id === id)!.text).join(" | ")}`).join("\n");
}
