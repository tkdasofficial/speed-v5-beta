// Change tracking for agent edits: previous/current versions, reasons, diffs and per-change rollback.
export interface TrackedChange { id: number; kind: "add" | "modify" | "delete" | "rename"; path: string; from?: string; before: string | null; after: string | null; reason: string; at: number; rolledBack?: boolean }

export class ChangeTracker {
  private list: TrackedChange[] = [];
  private seq = 0;
  record(c: Omit<TrackedChange, "id" | "at">): TrackedChange { const x = { ...c, id: ++this.seq, at: Date.now() }; this.list.push(x); return x; }
  all(): TrackedChange[] { return this.list.filter((c) => !c.rolledBack); }
  get(id: number): TrackedChange | undefined { return this.list.find((c) => c.id === id); }
  last(): TrackedChange | undefined { return this.all().at(-1); }
  summary() {
    const s = { added: [] as string[], modified: [] as string[], deleted: [] as string[], renamed: [] as string[] };
    for (const c of this.all()) (c.kind === "add" ? s.added : c.kind === "modify" ? s.modified : c.kind === "delete" ? s.deleted : s.renamed).push(c.kind === "rename" ? `${c.from} → ${c.path}` : c.path);
    for (const k of Object.keys(s) as (keyof typeof s)[]) s[k] = [...new Set(s[k])];
    return s;
  }
}

/** Minimal unified line diff (LCS) — enough for the agent to see what changed. */
export function lineDiff(a: string, b: string, path: string, max = 120): string {
  const A = a.split("\n"), B = b.split("\n");
  if (A.length * B.length > 4_000_000) return `--- ${path}\n(file too large for a line diff: ${A.length} → ${B.length} lines)`;
  const n = A.length, m = B.length, dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [`--- ${path}`];
  let i = 0, j = 0;
  while ((i < n || j < m) && out.length < max) {
    if (i < n && j < m && A[i] === B[j]) { i++; j++; continue; }
    if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) { out.push(`+${j + 1}: ${B[j]}`); j++; }
    else { out.push(`-${i + 1}: ${A[i]}`); i++; }
  }
  return out.length === 1 ? `--- ${path}\n(no changes)` : out.join("\n");
}
