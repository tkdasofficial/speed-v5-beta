// Single place that creates project rows (entitlement check → unique slug → insert → publish).
import { d1 } from "@backend/d1";
import type { Project } from "@realtime/events";

type PRow = { id: string; slug: string; name: string; settings: string; updated_at: string; created_at?: string; version: number };
export const toProject = (r: PRow): Project => ({ id: r.id, slug: r.slug, name: r.name, settings: JSON.parse(r.settings || "{}"), updatedAt: r.updated_at, createdAt: r.created_at ?? r.updated_at, version: r.version });
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "project";
const COLS = "id, slug, name, settings, updated_at, created_at, version";

export async function insertProject(userId: string, name: string, settings: Record<string, string | number | boolean> = {}): Promise<Project> {
  const { assertCanCreateProject } = await import("@security/entitlements.server");
  const { publish } = await import("@realtime/publish.server");
  await assertCanCreateProject(userId);
  const base = slugify(name);
  const taken = new Set((await d1<{ slug: string }>("SELECT slug FROM projects WHERE owner_id = ? AND slug LIKE ?", [userId, `${base}%`])).map((r) => r.slug));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  const [row] = await d1<PRow>(`INSERT INTO projects (id, owner_id, slug, name, settings) VALUES (?, ?, ?, ?, ?) RETURNING ${COLS}`,
    [crypto.randomUUID(), userId, slug, name.slice(0, 80), JSON.stringify(settings)]);
  const p = toProject(row!);
  await publish(userId, "project", "upsert", p.id, p.version, p);
  return p;
}

/** Merges settings server-side (used by trusted backend flows such as imports). */
export async function patchProjectSettings(userId: string, id: string, patch: Record<string, string | number | boolean>): Promise<Project> {
  const { publish } = await import("@realtime/publish.server");
  const [cur] = await d1<PRow>(`SELECT ${COLS} FROM projects WHERE id = ? AND owner_id = ?`, [id, userId]);
  if (!cur) throw new Error("Project not found");
  const [row] = await d1<PRow>(`UPDATE projects SET settings = ?, version = version + 1, updated_at = datetime('now') WHERE id = ? AND owner_id = ? RETURNING ${COLS}`,
    [JSON.stringify({ ...JSON.parse(cur.settings || "{}"), ...patch }), id, userId]);
  const p = toProject(row!);
  await publish(userId, "project", "upsert", p.id, p.version, p);
  return p;
}

export async function removeProject(userId: string, id: string) {
  const { publish } = await import("@realtime/publish.server");
  const rows = await d1<{ version: number }>("DELETE FROM projects WHERE id = ? AND owner_id = ? RETURNING version", [id, userId]);
  if (rows[0]) await publish(userId, "project", "delete", id, rows[0].version + 1, null);
}
