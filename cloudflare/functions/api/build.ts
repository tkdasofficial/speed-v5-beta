// Preview build RPCs. Building happens in the speed-runtime; Preview itself only opens the stored URL.
import { z } from "zod";
import * as v from "@security/validation";

async function owner(projectId: string) {
  const { requireUser, assertOwnsProject } = await import("@security/authorize.server");
  const user = await requireUser();
  await assertOwnsProject(user.id, projectId);
  return user;
}

export async function startPreviewBuild(raw: unknown) {
  const { projectId } = z.object({ projectId: v.id }).parse(raw);
  const user = await owner(projectId);
  const { startBuild } = await import("../build/pipeline.server");
  return startBuild(user.id, projectId);
}

export async function openPreviewSession(raw: unknown) {
  const { projectId } = z.object({ projectId: v.id }).parse(raw);
  const user = await owner(projectId);
  const p = await import("../build/pipeline.server");
  return p.openPreviewSession(user.id, projectId);
}

export async function closePreviewSession(raw: unknown) {
  const { token } = z.object({ token: z.string().min(10).max(1000) }).parse(raw);
  const { requireUser } = await import("@security/authorize.server");
  const user = await requireUser();
  const p = await import("../build/pipeline.server");
  return p.closePreviewSession(user.id, token);
}

export async function previewBuildStatus(raw: unknown) {
  const { projectId } = z.object({ projectId: v.id }).parse(raw);
  const user = await owner(projectId);
  const { d1 } = await import("../d1");
  const [r] = await d1<{ settings: string }>("SELECT settings FROM projects WHERE id = ?", [projectId]);
  const { stateOf } = await import("../build/pipeline.server");
  return stateOf(JSON.parse(r?.settings || "{}"), user.id, projectId);
}
