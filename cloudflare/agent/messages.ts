// Dynamic Message Generator: local, context-aware progress text (no AI). Never reports success unless `ok` is true.
export type ProgressEvent =
  | { type: "inspect"; fileCount: number; projectName?: string }
  | { type: "identify"; files: string[]; taskCount: number }
  | { type: "read"; files: string[] }
  | { type: "plan"; batches: number; tasks: number }
  | { type: "apply"; files: string[]; batchLabel?: string | undefined }
  | { type: "applied"; files: string[]; ok: boolean; error?: string }
  | { type: "build"; ok?: boolean; error?: string }
  | { type: "test"; ok?: boolean; error?: string }
  | { type: "verify"; ok?: boolean; issues?: string[] }
  | { type: "fix"; attempt: number; max: number; issues: string[] }
  | { type: "retry"; what: string; attempt: number; max: number }
  | { type: "complete"; changed: number; ok: boolean };

const short = (p: string) => p.split("/").pop() ?? p;
function list(files: string[], max = 3) {
  const f = [...new Set(files)].map(short);
  if (!f.length) return "the project";
  if (f.length <= max) return f.length === 1 ? f[0]! : `${f.slice(0, -1).join(", ")} and ${f[f.length - 1]}`;
  return `${f.slice(0, max).join(", ")} and ${f.length - max} more`;
}
const pl = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** Picks a phrasing variant from a stable seed so consecutive messages don't repeat the same wording. */
const pick = (seed: number, opts: string[]) => opts[Math.abs(seed) % opts.length]!;
const firstLine = (s?: string) => (s ?? "").split("\n")[0]!.slice(0, 160);

export function progressMessage(e: ProgressEvent, seed = 0): string {
  switch (e.type) {
    case "inspect":
      return e.fileCount ? pick(seed, [`Inspecting ${e.projectName ?? "the project"} (${pl(e.fileCount, "file")}).`, `Looking through ${pl(e.fileCount, "file")} in ${e.projectName ?? "the project"}.`]) : "The project is empty, so I'll start from scratch.";
    case "identify":
      return e.files.length ? `Found ${pl(e.files.length, "relevant file")} for ${pl(e.taskCount, "change")}: ${list(e.files)}.` : `No existing file matches yet; I'll locate the right place for ${pl(e.taskCount, "change")}.`;
    case "read": return pick(seed, [`Reading ${list(e.files)}.`, `Opening ${list(e.files)} to see the current code.`]);
    case "plan":
      return e.batches < e.tasks ? `Grouped ${pl(e.tasks, "change")} into ${pl(e.batches, "batch", )} so related edits happen together.` : `Working through ${pl(e.tasks, "change")} one at a time.`;
    case "apply":
      return e.files.length > 1 ? `Applying changes to ${pl(e.files.length, "file")}: ${list(e.files)}.` : `Updating ${list(e.files)}${e.batchLabel ? ` — ${e.batchLabel.slice(0, 80)}` : ""}.`;
    case "applied":
      return e.ok ? pick(seed, [`Saved changes to ${list(e.files)}.`, `${list(e.files)} ${e.files.length === 1 ? "is" : "are"} updated.`]) : `Couldn't save ${list(e.files)}: ${firstLine(e.error)}`;
    case "build":
      return e.ok === undefined ? "Building the project to check the changes." : e.ok ? "Build passed." : `Build failed: ${firstLine(e.error)}`;
    case "test":
      return e.ok === undefined ? "Running the build test." : e.ok ? "Build test passed." : `Build test failed: ${firstLine(e.error)}`;
    case "verify":
      return e.ok === undefined ? "Verifying the changes." : e.ok ? "Verification passed." : `Verification found ${pl(e.issues?.length ?? 1, "problem")}: ${firstLine(e.issues?.[0])}`;
    case "fix": return `Fixing ${pl(e.issues.length, "problem")} (attempt ${e.attempt} of ${e.max}): ${firstLine(e.issues[0])}`;
    case "retry": return `Retrying ${e.what} (attempt ${e.attempt} of ${e.max}).`;
    case "complete":
      return e.ok ? (e.changed ? `Done — ${pl(e.changed, "file")} changed and verified.` : "Done — no files needed changes.") : "Stopped before finishing; see the failed steps above.";
  }
}
