// Google Drive object storage (server-only). Credentials come from the Secrets Store via envStr(); never logged or returned.
import { envStr } from "../context";

const DRIVE = "https://www.googleapis.com/drive/v3";
let cached: { token: string; exp: number } | null = null;

export class StorageError extends Error {}

export async function driveToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"].filter((k) => !envStr(k));
  if (missing.length) throw new StorageError(`Missing server secret: ${missing.join(", ")}`);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: envStr("GOOGLE_CLIENT_ID")!, client_secret: envStr("GOOGLE_CLIENT_SECRET")!,
      refresh_token: envStr("GOOGLE_REFRESH_TOKEN")!, grant_type: "refresh_token",
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !j.access_token) throw new StorageError(`Google sign-in failed (${j.error ?? res.status})`);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3000) * 1000 };
  return cached.token;
}

/** Drive API call with retry on 429/5xx (3 attempts, backoff). */
export async function drive(path: string, init: RequestInit = {}, base = DRIVE): Promise<Response> {
  for (let i = 0; ; i++) {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${await driveToken()}` } });
    if ((res.status === 429 || res.status >= 500) && i < 2) { await new Promise((r) => setTimeout(r, 500 * 2 ** i)); continue; }
    return res;
  }
}

/** Verifies the credentials and that the root folder is a reachable, writable folder. Returns no file data. */
export async function verifyDriveRoot(): Promise<{ ok: boolean; error?: string | undefined; writable?: boolean }> {
  const root = envStr("GOOGLE_DRIVE_FOLDER_ID");
  if (!root) return { ok: false, error: "Missing server secret: GOOGLE_DRIVE_FOLDER_ID" };
  try {
    const res = await drive(`/files/${encodeURIComponent(root)}?fields=mimeType,trashed,capabilities(canAddChildren)&supportsAllDrives=true`);
    if (!res.ok) { const b = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[]; message?: string } }; const sc = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${await driveToken()}`).then((r) => r.json() as Promise<{ scope?: string }>).catch(() => ({ scope: "" })); return { ok: false, error: `Root folder not accessible (${res.status} ${b.error?.errors?.[0]?.reason ?? ""}: ${b.error?.message ?? ""}) granted scopes: ${sc.scope ?? ""}` }; }
    const f = (await res.json()) as { mimeType: string; trashed: boolean; capabilities?: { canAddChildren?: boolean } };
    if (f.mimeType !== "application/vnd.google-apps.folder" || f.trashed) return { ok: false, error: "Root ID is not an active folder" };
    return { ok: !!f.capabilities?.canAddChildren, writable: !!f.capabilities?.canAddChildren, error: f.capabilities?.canAddChildren ? undefined : "Root folder is read-only" };
  } catch (e) {
    return { ok: false, error: e instanceof StorageError ? e.message : "Google Drive unreachable" };
  }
}

/** Writes (or overwrites) one fixed test file `metadata.json` in the root folder. Idempotent; contains no user data. */
export async function writeTestMetadata(): Promise<{ ok: boolean; id?: string; name?: string; error?: string }> {
  const root = envStr("GOOGLE_DRIVE_FOLDER_ID");
  if (!root) return { ok: false, error: "Missing server secret: GOOGLE_DRIVE_FOLDER_ID" };
  try {
    const content = JSON.stringify({ app: "Speed", kind: "storage-test", writtenAt: new Date().toISOString() }, null, 2);
    const q = encodeURIComponent(`name='metadata.json' and '${root}' in parents and trashed=false`);
    const found = (await (await drive(`/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json()) as { files?: { id: string }[] };
    const existing = found.files?.[0]?.id;
    const boundary = "speed" + crypto.randomUUID();
    const meta = existing ? {} : { name: "metadata.json", parents: [root], mimeType: "application/json" };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
    const path = existing ? `/files/${existing}?uploadType=multipart&supportsAllDrives=true&fields=id,name` : `/files?uploadType=multipart&supportsAllDrives=true&fields=id,name`;
    const res = await drive(path, { method: existing ? "PATCH" : "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }, "https://www.googleapis.com/upload/drive/v3");
    const j = (await res.json().catch(() => ({}))) as { id?: string; name?: string; error?: { message?: string } };
    return res.ok ? { ok: true, id: j.id!, name: j.name! } : { ok: false, error: `Upload failed (${res.status}): ${j.error?.message ?? ""}` };
  } catch (e) {
    return { ok: false, error: e instanceof StorageError ? e.message : "Google Drive unreachable" };
  }
}

const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** Finds a child by exact name inside a folder (first match, not trashed). */
export async function findChild(parent: string, name: string, folder = false): Promise<string | null> {
  const q = encodeURIComponent(`name='${esc(name)}' and '${parent}' in parents and trashed=false${folder ? " and mimeType='application/vnd.google-apps.folder'" : ""}`);
  const res = await drive(`/files?q=${q}&fields=files(id)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  if (!res.ok) throw new StorageError(`Drive lookup failed (${res.status})`);
  return ((await res.json()) as { files?: { id: string }[] }).files?.[0]?.id ?? null;
}

/** Returns the folder ID for a child folder, creating it when missing. */
export async function ensureFolder(parent: string, name: string): Promise<string> {
  const hit = await findChild(parent, name, true);
  if (hit) return hit;
  const res = await drive(`/files?supportsAllDrives=true&fields=id`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, parents: [parent], mimeType: "application/vnd.google-apps.folder" }) });
  if (!res.ok) throw new StorageError(`Drive folder create failed (${res.status})`);
  return ((await res.json()) as { id: string }).id;
}

/** Creates or overwrites a file by name inside a folder. Returns its file ID. */
export async function putFile(parent: string, name: string, content: string, mime = "application/json", existing?: string | null): Promise<string> {
  const id = existing === undefined ? await findChild(parent, name) : existing;
  const boundary = "speed" + crypto.randomUUID();
  const meta = id ? {} : { name, parents: [parent], mimeType: mime };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n--${boundary}--`;
  const path = id ? `/files/${id}?uploadType=multipart&supportsAllDrives=true&fields=id` : `/files?uploadType=multipart&supportsAllDrives=true&fields=id`;
  const res = await drive(path, { method: id ? "PATCH" : "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }, UPLOAD);
  if (!res.ok) throw new StorageError(`Drive upload failed (${res.status})`);
  return ((await res.json()) as { id: string }).id;
}

export async function getFileText(id: string): Promise<string> {
  const res = await drive(`/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
  if (!res.ok) throw new StorageError(`Drive download failed (${res.status})`);
  return res.text();
}

export async function deleteFile(id: string): Promise<void> {
  await drive(`/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: "DELETE" }).catch(() => undefined);
}

/** users/{userId}/projects/{projectId}/ with source/, static/, assets/ and metadata/ subfolders. */
export async function projectFolders(userId: string, projectId: string) {
  const root = envStr("GOOGLE_DRIVE_FOLDER_ID");
  if (!root) throw new StorageError("Missing server secret: GOOGLE_DRIVE_FOLDER_ID");
  const users = await ensureFolder(root, "users");
  const user = await ensureFolder(users, userId);
  const projects = await ensureFolder(user, "projects");
  const project = await ensureFolder(projects, projectId);
  const [source, stat, assets, metadata] = await Promise.all(["source", "static", "assets", "metadata"].map((n) => ensureFolder(project, n)));
  return { project, source: source!, static: stat!, assets: assets!, metadata: metadata! };
}
