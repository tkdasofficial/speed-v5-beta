// Server-side authorization. Every protected server function calls requireUser()
// and the relevant ownership check; client-side flags are never trusted.
import { d1 } from "@backend/d1";
import { userFromToken } from "./session.server";
import { bearer } from "@backend/context";

export class AuthError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function currentUser() {
  return userFromToken(bearer());
}

export async function requireUser() {
  const me = await currentUser();
  if (!me) throw new AuthError(401, "Unauthorized");
  return me;
}

export async function assertOwnsProject(userId: string, projectId: string) {
  const rows = await d1<{ id: string }>("SELECT id FROM projects WHERE id = ? AND owner_id = ?", [projectId, userId]);
  if (!rows[0]) throw new AuthError(404, "Project not found");
}

export async function assertOwnsTask(userId: string, taskId: string) {
  const rows = await d1<{ project_id: string }>(
    "SELECT t.project_id FROM ai_tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND p.owner_id = ?",
    [taskId, userId],
  );
  if (!rows[0]) throw new AuthError(404, "Task not found");
  return rows[0].project_id;
}
