// Safe project recovery decisions (pure, unit-tested). The recover_project tool gathers the evidence and only
// performs the single action chosen here; anything ambiguous returns "recovery_requires_review" instead.

export interface RecoveryEvidence {
  revision: number;
  currentErrors: { file: string; message: string }[];
  buildStatus: string | null;
  buildError: string | null;
  buildStuck: boolean;
  runningJobs: string[];
  /** Candidates newest first: snapshots first, then plain revisions. `valid` = passes project validation. */
  candidates: { kind: "snapshot" | "revision"; id: string | null; revision: number; label: string | null; valid: boolean; filesLost: string[] }[];
}

export type RecoveryAction =
  | { type: "none"; reason: string }
  | { type: "rebuild"; reason: string }
  | { type: "restore"; reason: string; source: "snapshot" | "revision"; snapshotId: string | null; revision: number; filesLost: string[] }
  | { type: "review"; reason: string };

export const SAFE_LIMITS = { maxRevisionsBack: 10, maxFilesLost: 20 };

export function decideRecovery(e: RecoveryEvidence): RecoveryAction {
  if (e.runningJobs.length) return { type: "review", reason: `Commands are still running (${e.runningJobs.join(", ")}); wait for them before recovering.` };
  if (!e.currentErrors.length) {
    if (e.buildStatus === "failed" || e.buildStuck) return { type: "rebuild", reason: `The files are valid but the last build ${e.buildStuck ? "never finished" : "failed"}; rebuilding is the safe fix (no files change).` };
    return { type: "none", reason: "The project validates and the last build is fine; nothing to recover." };
  }
  const good = e.candidates.find((c) => c.valid);
  if (!good) return { type: "review", reason: `No earlier snapshot or revision passes validation; the ${e.currentErrors.length} error(s) need a code fix instead of a rollback.` };
  const back = e.revision - good.revision;
  if (back > SAFE_LIMITS.maxRevisionsBack || good.filesLost.length > SAFE_LIMITS.maxFilesLost)
    return { type: "review", reason: `The nearest working version is ${back} revisions back and would undo changes to ${good.filesLost.length} files; too much work to undo automatically.` };
  return { type: "restore", reason: `Revision ${good.revision}${good.label ? ` ("${good.label}")` : ""} is the newest version that validates.`, source: good.kind, snapshotId: good.id, revision: good.revision, filesLost: good.filesLost };
}
