// The agent runs on the server as an `ai_agent` background task; the app only submits and observes it.
import type { QueryClient } from "@tanstack/react-query";
import { keys } from "@realtime/store";
import type { Message } from "@realtime/events";
import { cancelBgTask, createBgTask } from "@/lib/api/tasks";

type Mode = { model: "speed" | "flash" | "heavy"; depth: "quick" | "balanced" | "deep"; plan: boolean };

export async function startAgentTask(opts: { qc: QueryClient; projectId: string; prompt: string; mode: Mode }) {
  const { qc, projectId, prompt, mode } = opts;
  // Show the user's message instantly; it's dropped as soon as the saved copy arrives.
  const tempId = `local-${Date.now()}`;
  const key = keys.messages(projectId);
  qc.setQueryData<Message[]>(key, (l) => [...(l ?? []), { id: tempId, projectId, role: "user", content: prompt, createdAt: new Date().toISOString().slice(0, 19).replace("T", " "), version: 0 }]);
  const unsub = qc.getQueryCache().subscribe(() => {
    const l = qc.getQueryData<Message[]>(key);
    if (l?.some((m) => m.id !== tempId && m.role === "user" && m.content === prompt && m.version > 0)) {
      unsub(); qc.setQueryData<Message[]>(key, (x) => x?.filter((m) => m.id !== tempId));
    }
  });
  try {
    return await createBgTask({ data: { type: "ai_agent", projectId, idempotencyKey: tempId, payload: { prompt, ...mode, clientMessageId: tempId } } });
  } catch (e) {
    unsub(); qc.setQueryData<Message[]>(key, (x) => x?.filter((m) => m.id !== tempId));
    throw e;
  }
}

export const stopAgentTask = (taskId: string) => cancelBgTask({ data: { id: taskId } });

/** Restores the codebase to a revision (runs as a background file task). */
export const rollbackToRevision = (projectId: string, revision: number) =>
  createBgTask({ data: { type: "file_operation", projectId, payload: { op: "rollback", revision }, idempotencyKey: `rollback-${projectId}-${revision}-${Date.now()}` } });
