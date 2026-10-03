// Server-side codebase sandbox: the "sandbox" D1 (binding SANDBOX_DB) is the source of truth for project files.
// Every change goes load → apply on an in-memory copy → diff → one atomic revision (optimistic on current_revision).
import { ctx, type D1Database } from "@backend/context";
import { MemoryFileStore } from "../../sandbox/workspace/workspace";
import { normalizePath } from "../../sandbox/utils/paths";
import { createFile, createFolder } from "../../sandbox/filesystem/create";
import { writeFile } from "../../sandbox/filesystem/write";
import { deletePath } from "../../sandbox/filesystem/delete";
import { movePath } from "../../sandbox/filesystem/move";
import { copyPath } from "../../sandbox/filesystem/copy";
import type { FileEntry, FileStore } from "../../sandbox/types/filesystem";

/** Content larger than this belongs in object storage (R2), not D1. */
export const MAX_FILE_BYTES = 900_000;

export class ConflictError extends Error {}

function db(): D1Database {
  const b = ctx().env["SANDBOX_DB"] as D1Database | undefined;
  if (!b) throw new Error("Project file storage is not configured");
  return b;
}
async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db().prepare(sql).bind(...params.map((p) => (p === undefined ? null : p))).all<T>();
  return r.results ?? [];
}

/** Normalizes a client/AI path and rejects traversal, absolute and protected paths. */
export function safePath(raw: string): string {
  const s = String(raw ?? "").replace(/\\/g, "/").replace(/^\.local\/?/, "").replace(/^\/+/, "");
  if (!s || s.split("/").some((seg) => seg === "..")) throw new Error(`Invalid path: ${raw}`);
  const p = normalizePath(s);
  if (/^\.git(\/|$)/.test(p) || /(^|\/)\.env(\.|$)/.test(p)) throw new Error(`Protected path: ${p}`);
  if (p.length > 400) throw new Error("Path too long");
  return p;
}

type NodeRow = { path: string; node_type: "file" | "folder"; content: string | null; encoding: "utf8" | "base64"; size: number; version: number; updated_at: string; created_at: string };

export async function ensureProject(ownerId: string, projectId: string, name = ""): Promise<number> {
  await q("INSERT OR IGNORE INTO sb_projects (project_id, owner_id, name) VALUES (?, ?, ?)", [projectId, ownerId, name]);
  const [p] = await q<{ owner_id: string; current_revision: number }>("SELECT owner_id, current_revision FROM sb_projects WHERE project_id = ?", [projectId]);
  if (!p || p.owner_id !== ownerId) throw new Error("Project not found");
  return p.current_revision;
}

export async function getRevision(projectId: string): Promise<number> {
  const [p] = await q<{ current_revision: number }>("SELECT current_revision FROM sb_projects WHERE project_id = ?", [projectId]);
  return p?.current_revision ?? 0;
}

const ts = (s: string) => Date.parse(`${s.replace(" ", "T")}Z`) || Date.now();

/** Loads the full codebase into an in-memory store (with versions for conflict checks). */
export async function loadStore(projectId: string): Promise<{ store: MemoryFileStore; versions: Map<string, number>; revision: number }> {
  const [rows, revision] = await Promise.all([
    q<NodeRow>("SELECT path, node_type, content, encoding, size, version, updated_at, created_at FROM sb_nodes WHERE project_id = ?", [projectId]),
    getRevision(projectId),
  ]);
  const store = new MemoryFileStore();
  const versions = new Map<string, number>();
  for (const r of rows) {
    versions.set(r.path, r.version);
    if (r.node_type === "folder") store.addFolder(r.path);
    else store.set({ path: r.path, content: r.content ?? "", encoding: r.encoding, updatedAt: ts(r.updated_at), createdAt: ts(r.created_at) });
  }
  return { store, versions, revision };
}

export type TreeFile = { path: string; content: string; encoding: "utf8" | "base64"; version: number; updatedAt: number };
export async function readTree(projectId: string, since?: number) {
  const { store, versions, revision } = await loadStore(projectId);
  if (since !== undefined && since === revision) return { revision, unchanged: true as const };
  return {
    revision, unchanged: false as const,
    files: store.list().map((f): TreeFile => ({ path: f.path, content: f.content, encoding: f.encoding, version: versions.get(f.path) ?? 1, updatedAt: f.updatedAt })),
    folders: store.folders(),
  };
}

type Snap = { files: Map<string, FileEntry>; folders: Set<string> };
const snap = (s: FileStore): Snap => ({ files: new Map(s.list().map((f) => [f.path, { ...f }])), folders: new Set(s.folders()) });
export { snap as snapshotStore };

/** Diffs before→after and writes one revision. Throws ConflictError if someone else committed meanwhile. */
export async function commit(projectId: string, baseRevision: number, before: Snap, after: FileStore, meta: { taskId?: string | null; label?: string } = {}): Promise<{ revision: number; changed: string[] }> {
  type Ch = { path: string; type: "file" | "folder"; op: "create" | "update" | "delete"; before: string | null; after: string | null; enc: "utf8" | "base64" };
  const changes: Ch[] = [];
  const aFiles = new Map(after.list().map((f) => [f.path, f]));
  const aFolders = new Set(after.folders());
  for (const [p, f] of aFiles) {
    if (f.content.length > MAX_FILE_BYTES) throw new Error(`${p} is too large to store (${Math.round(f.content.length / 1024)} KB)`);
    const b = before.files.get(p);
    if (!b) changes.push({ path: p, type: "file", op: "create", before: null, after: f.content, enc: f.encoding });
    else if (b.content !== f.content || b.encoding !== f.encoding) changes.push({ path: p, type: "file", op: "update", before: b.content, after: f.content, enc: f.encoding });
  }
  for (const [p, b] of before.files) if (!aFiles.has(p)) changes.push({ path: p, type: "file", op: "delete", before: b.content, after: null, enc: b.encoding });
  for (const p of aFolders) if (!before.folders.has(p)) changes.push({ path: p, type: "folder", op: "create", before: null, after: null, enc: "utf8" });
  for (const p of before.folders) if (!aFolders.has(p)) changes.push({ path: p, type: "folder", op: "delete", before: null, after: null, enc: "utf8" });
  if (!changes.length) return { revision: baseRevision, changed: [] };

  const bumped = await q<{ current_revision: number }>(
    "UPDATE sb_projects SET current_revision = current_revision + 1, updated_at = datetime('now') WHERE project_id = ? AND current_revision = ? RETURNING current_revision",
    [projectId, baseRevision],
  );
  if (!bumped[0]) throw new ConflictError("The project changed while this edit was running — reload and try again");
  const revision = bumped[0].current_revision;
  const d = db();
  const stmts = changes.flatMap((c) => {
    const name = c.path.split("/").pop() ?? c.path;
    const parent = c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : "";
    const rev = d.prepare("INSERT INTO sb_revisions (project_id, revision, path, node_type, op, before_content, after_content, encoding, task_id, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(projectId, revision, c.path, c.type, c.op, c.before, c.after, c.enc, meta.taskId ?? null, meta.label ?? null);
    const node = c.op === "delete"
      ? d.prepare("DELETE FROM sb_nodes WHERE project_id = ? AND path = ?").bind(projectId, c.path)
      : d.prepare(`INSERT INTO sb_nodes (project_id, path, parent, name, node_type, content, encoding, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, path) DO UPDATE SET content = excluded.content, encoding = excluded.encoding, size = excluded.size, version = sb_nodes.version + 1, updated_at = datetime('now')`)
          .bind(projectId, c.path, parent, name, c.type, c.after, c.enc, c.after?.length ?? 0);
    return [rev, node];
  });
  for (let i = 0; i < stmts.length; i += 50) await d.batch(stmts.slice(i, i + 50));
  return { revision, changed: changes.map((c) => c.path) };
}

export type FileOp =
  | { op: "write"; path: string; content: string; expectedVersion?: number | undefined }
  | { op: "create"; path: string; content?: string | undefined }
  | { op: "mkdir"; path: string }
  | { op: "delete"; path: string }
  | { op: "move"; from: string; to: string }
  | { op: "copy"; from: string; to: string };

/** Applies one file/folder operation as its own revision (with an optimistic version check for writes). */
export async function applyOp(projectId: string, o: FileOp, meta: { taskId?: string | null } = {}) {
  const { store, versions, revision } = await loadStore(projectId);
  const before = snap(store);
  switch (o.op) {
    case "write": {
      const p = safePath(o.path);
      if (o.expectedVersion !== undefined && store.get(p) && versions.get(p) !== o.expectedVersion) throw new ConflictError(`${p} was changed elsewhere — reload it before saving`);
      store.get(p) ? writeFile(store, p, o.content) : createFile(store, p, o.content);
      break;
    }
    case "create": createFile(store, safePath(o.path), o.content ?? ""); break;
    case "mkdir": createFolder(store, safePath(o.path)); break;
    case "delete": deletePath(store, safePath(o.path)); break;
    case "move": movePath(store, safePath(o.from), safePath(o.to)); break;
    case "copy": copyPath(store, safePath(o.from), safePath(o.to)); break;
  }
  return commit(projectId, revision, before, store, { ...meta, label: o.op });
}

/** One-time upload of a device-only project. Only allowed while the server codebase is still empty. */
export async function importFiles(projectId: string, files: { path: string; content: string; encoding?: "utf8" | "base64" | undefined }[], folders: string[]) {
  const { store, revision } = await loadStore(projectId);
  if (store.list().length || store.folders().length) return { revision, changed: [] as string[], skipped: true };
  const before = snap(store);
  for (const d of folders) store.addFolder(safePath(d));
  for (const f of files) store.set({ path: safePath(f.path), content: f.content, encoding: f.encoding ?? "utf8", updatedAt: Date.now() });
  return { ...(await commit(projectId, revision, before, store, { label: "import" })), skipped: false };
}

/** Restores the codebase to how it was at `target` by undoing later revisions, as a new revision. */
export async function rollbackTo(projectId: string, target: number, meta: { taskId?: string | null } = {}) {
  const { store, revision } = await loadStore(projectId);
  if (target >= revision) return { revision, changed: [] as string[] };
  const rows = await q<{ path: string; node_type: string; op: string; before_content: string | null; encoding: "utf8" | "base64" }>(
    "SELECT path, node_type, op, before_content, encoding FROM sb_revisions WHERE project_id = ? AND revision > ? ORDER BY revision DESC, id DESC",
    [projectId, target],
  );
  const before = snap(store);
  for (const r of rows) {
    if (r.node_type === "folder") { if (r.op === "create") store.removeFolder(r.path); else if (r.op === "delete") store.addFolder(r.path); continue; }
    if (r.op === "create") store.delete(r.path);
    else store.set({ path: r.path, content: r.before_content ?? "", encoding: r.encoding, updatedAt: Date.now() });
  }
  return commit(projectId, revision, before, store, { ...meta, label: `rollback to ${target}` });
}

export async function listRevisions(projectId: string, limit = 50) {
  return q<{ revision: number; label: string | null; task_id: string | null; files: number; created_at: string }>(
    "SELECT revision, MAX(label) AS label, MAX(task_id) AS task_id, COUNT(*) AS files, MIN(created_at) AS created_at FROM sb_revisions WHERE project_id = ? GROUP BY revision ORDER BY revision DESC LIMIT ?",
    [projectId, limit],
  );
}

export async function deleteProjectFiles(projectId: string) {
  const d = db();
  await d.batch([
    d.prepare("DELETE FROM sb_nodes WHERE project_id = ?").bind(projectId),
    d.prepare("DELETE FROM sb_revisions WHERE project_id = ?").bind(projectId),
    d.prepare("DELETE FROM sb_projects WHERE project_id = ?").bind(projectId),
  ]);
}
