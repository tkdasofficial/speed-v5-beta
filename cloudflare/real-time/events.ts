// Delta event contract shared by server publisher and client sync engine.
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type Project = { id: string; slug: string; name: string; settings: Record<string, Json>; updatedAt: string; createdAt?: string; version: number };
export type Message = { id: string; projectId: string; role: "user" | "assistant" | "system"; content: string; createdAt: string; version: number };
export type Task = { id: string; projectId: string; title: string; description: string; status: string; version: number };
export type Profile = { email: string; displayName: string | null; avatarUrl: string | null; version: number };
export type StateEntry = { key: string; value: Json; version: number };

/** Background task (global worker system). */
export type Job = { id: string; projectId: string | null; type: string; status: "queued" | "running" | "retrying" | "awaiting_approval" | "completed" | "failed" | "cancelled"; progress: number; currentStep: string | null; result: Json; error: string | null; retryCount: number; createdAt: string; startedAt: string | null; completedAt: string | null; version: number };
export type JobEvent = { id: string; taskId: string; projectId: string | null; seq: number; kind: string; data: Json; at: string; version: number };
/** Server codebase changed (projectId + new revision). */
export type FileRev = { id: string; projectId: string; revision: number; changed: string[]; version: number };
export type EntityMap = { project: Project; message: Message; task: Task; profile: Profile; state: StateEntry; job: Job; jobevent: JobEvent; filerev: FileRev };
export type Entity = keyof EntityMap;

export type SyncEvent = {
  [K in Entity]: { seq: number; entity: K; op: "upsert" | "delete"; id: string; version: number; data: EntityMap[K] | null };
}[Entity];

export type Snapshot = {
  seq: number;
  projects: Project[];
  tasks: Task[];
  profile: Profile;
  state: StateEntry[];
};
