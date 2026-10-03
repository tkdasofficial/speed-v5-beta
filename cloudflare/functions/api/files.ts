// Server codebase API (sandbox D1). Reads are direct; quick user edits commit immediately as revisions and are
// published live; long/AI work goes through the task system.
import { z } from "zod";
import * as v from "@security/validation";

async function owner(projectId: string) {
  const { requireUser, assertOwnsProject } = await import("@security/authorize.server");
  const user = await requireUser();
  await assertOwnsProject(user.id, projectId);
  const fs = await import("../../sandbox/fs.server");
  await fs.ensureProject(user.id, projectId);
  return { user, fs };
}
async function announce(userId: string, projectId: string, r: { revision: number; changed: string[] }) {
  if (!r.changed.length) return;
  const { publish } = await import("@realtime/publish.server");
  await publish(userId, "filerev", "upsert", `${projectId}:${r.revision}`, r.revision, { id: `${projectId}:${r.revision}`, projectId, revision: r.revision, changed: r.changed.slice(0, 200), version: r.revision });
}

export async function sbTree(raw: unknown) {
  const data = z.object({ projectId: v.id, since: z.number().int().min(0).optional() }).parse(raw);
  const { fs } = await owner(data.projectId);
  return fs.readTree(data.projectId, data.since);
}

const p = z.string().min(1).max(400);
const op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("write"), path: p, content: z.string().max(900_000), expectedVersion: z.number().int().optional() }),
  z.object({ op: z.literal("create"), path: p, content: z.string().max(900_000).optional() }),
  z.object({ op: z.literal("mkdir"), path: p }),
  z.object({ op: z.literal("delete"), path: p }),
  z.object({ op: z.literal("move"), from: p, to: p }),
  z.object({ op: z.literal("copy"), from: p, to: p }),
]);

export async function sbOp(raw: unknown) {
  const data = z.object({ projectId: v.id, op }).parse(raw);
  const { user, fs } = await owner(data.projectId);
  const r = await fs.applyOp(data.projectId, data.op);
  await announce(user.id, data.projectId, r);
  return r;
}

export async function sbImport(raw: unknown) {
  const data = z.object({
    projectId: v.id,
    files: z.array(z.object({ path: p, content: z.string().max(900_000), encoding: z.enum(["utf8", "base64"]).optional() })).max(2000),
    folders: z.array(p).max(2000).default([]),
  }).parse(raw);
  const { user, fs } = await owner(data.projectId);
  const r = await fs.importFiles(data.projectId, data.files, data.folders);
  await announce(user.id, data.projectId, r);
  return r;
}

export async function sbRevisions(raw: unknown) {
  const data = z.object({ projectId: v.id }).parse(raw);
  const { fs } = await owner(data.projectId);
  return fs.listRevisions(data.projectId);
}

/** Copies one project's codebase into another (project duplicate). */
export async function sbCopyProject(raw: unknown) {
  const data = z.object({ fromId: v.id, toId: v.id }).parse(raw);
  const { fs } = await owner(data.fromId);
  const { user } = await owner(data.toId);
  const t = await fs.readTree(data.fromId);
  if (t.unchanged) return { revision: 0, changed: [] as string[] };
  const r = await fs.importFiles(data.toId, t.files, t.folders);
  await announce(user.id, data.toId, r);
  return r;
}
