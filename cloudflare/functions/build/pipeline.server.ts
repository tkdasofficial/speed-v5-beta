// Build & preview pipeline (server-only).
//   startBuild → source hash check → source bundle to Drive → dispatch speed-runtime GitHub Actions run
//   runtime GETs /runtime/source, builds in a throwaway workspace, POSTs /runtime/result
//   acceptResult → static hash check → static bundle to Drive → metadata.json → project settings (previewUrl)
// The previous working build is only replaced after the new one is fully stored. Secrets never leave the server;
// the runtime only ever receives a single-use, short-lived build token.
import { ctx, envStr } from "../context";
import { d1 } from "../d1";
import { hashFiles, safeRelPath, IGNORED, type HashFile } from "./hash";
import { prepareArtifact, isStaticProject, toB64, ArtifactError, type ArtifactFile, type ProjectType } from "../../../.output.build";

export const RUNTIME_REPO = "tkdasofficial/speed-runtime";
const WORKFLOW = "build.yml";
const TOKEN_TTL_MS = 30 * 60_000;
const MAX_SOURCE_BYTES = 15_000_000;
const MAX_STATIC_BYTES = 40_000_000;
const MAX_FILES = 3000;
const FALLBACK_ORIGIN = "https://speed-api.tusharkantidasofficial.workers.dev";

export class BuildError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

type Settings = Record<string, string | number | boolean>;
export type BuildState = { status: "unchanged" | "queued" | "building" | "ready" | "failed" | "idle"; previewUrl: string | null; error?: string | null; buildId?: string | null; sourceHash?: string | null };

const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomToken = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); };

export function apiOrigin(): string {
  try { const u = new URL(ctx().req.url); if (u.protocol === "https:" && u.hostname.includes(".") && !u.hostname.endsWith(".internal")) return u.origin; } catch { /* no request */ }
  return FALLBACK_ORIGIN;
}
/** Marker kept in project settings; the real URL is a short-lived preview session (see openPreviewSession). */
export const previewUrlFor = (_userId: string, projectId: string) => `speed-preview:${projectId}`;

async function loadProject(projectId: string): Promise<{ ownerId: string; settings: Settings } | null> {
  const [r] = await d1<{ owner_id: string; settings: string }>("SELECT owner_id, settings FROM projects WHERE id = ?", [projectId]);
  return r ? { ownerId: r.owner_id, settings: JSON.parse(r.settings || "{}") as Settings } : null;
}
async function patch(userId: string, projectId: string, p: Settings) {
  const { patchProjectSettings } = await import("../projects.server");
  await patchProjectSettings(userId, projectId, p);
}
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Only React + TypeScript + Vite projects with a build script are built by the runtime. */
export function detectFramework(files: HashFile[]): "react-vite" | null {
  const pkg = files.find((f) => f.path === "package.json");
  if (!pkg) return null;
  try {
    const j = JSON.parse(pkg.content) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...j.dependencies, ...j.devDependencies };
    return j.scripts?.["build"] && deps["vite"] && deps["react"] ? "react-vite" : null;
  } catch { return null; }
}

export function stateOf(s: Settings, userId: string, projectId: string): BuildState {
  let status = (str(s["buildStatus"]) as BuildState["status"]) ?? "idle";
  let error = str(s["buildError"]);
  // A run that never reported back before its token expired is over; the last working version stays live.
  if ((status === "queued" || status === "building") && Number(s["buildExpires"] ?? 0) < Date.now()) { status = "failed"; error = error || "The build didn't finish in time. Tap Rebuild to try again."; }
  return { status, previewUrl: s["staticFileId"] ? previewUrlFor(userId, projectId) : null, error, buildId: str(s["buildId"]), sourceHash: str(s["sourceHash"]) };
}

/** Starts a build for the project's current files, or returns the existing preview when nothing changed. */
export async function startBuild(userId: string, projectId: string): Promise<BuildState> {
  const proj = await loadProject(projectId);
  if (!proj || proj.ownerId !== userId) throw new BuildError("Project not found", 404);
  const fs = await import("../../sandbox/fs.server");
  const tree = await fs.readTree(projectId);
  if (tree.unchanged) throw new BuildError("Project files unavailable");
  const files: HashFile[] = tree.files.filter((f) => !IGNORED.test(f.path)).map((f) => ({ path: f.path, content: f.content, encoding: f.encoding === "base64" ? "base64" : "utf8" }));
  const framework = detectFramework(files);
  const isStatic = !framework && isStaticProject(files.map((f) => f.path));
  if (!framework && !isStatic) throw new BuildError("This project has no index.html and isn't a React + Vite project, so there is nothing to preview yet.");
  if (files.length > MAX_FILES) throw new BuildError("Project has too many files to build.");
  if (files.some((f) => !safeRelPath(f.path))) throw new BuildError("Project contains an unsafe file path.");
  const bytes = files.reduce((n, f) => n + f.content.length, 0);
  if (bytes > MAX_SOURCE_BYTES) throw new BuildError("Project is too large to build.");
  if (framework) {
    // Catch import/export mismatches here instead of failing minutes later in the GitHub build.
    const { validateViteExports } = await import("../../../sandbox/intelligence/validate");
    const store = { get: (p: string) => files.find((f) => f.path === p), list: () => files } as unknown as Parameters<typeof validateViteExports>[0];
    const bad = validateViteExports(store);
    if (bad.length) throw new BuildError(`The project has code errors, so it wasn't built. Ask the agent to fix them:\n${bad.slice(0, 5).map((e) => `- ${e.file}:${e.line} ${e.message}`).join("\n")}`);
  }

  const sourceHash = await hashFiles(files);
  const s = proj.settings;
  // Identical source: no build, no upload, no new deployment.
  if (s["sourceHash"] === sourceHash && s["staticFileId"]) return { status: "unchanged", previewUrl: previewUrlFor(userId, projectId), sourceHash };
  // Same source already building and token still valid: don't start a duplicate run.
  if (s["pendingSourceHash"] === sourceHash && (s["buildStatus"] === "queued" || s["buildStatus"] === "building") && Number(s["buildExpires"] ?? 0) > Date.now())
    return { ...stateOf(s, userId, projectId), status: s["buildStatus"] as "queued" | "building" };

  if (isStatic) return publishStatic(userId, projectId, s, files, sourceHash);

  const { putFile } = await import("../storage/drive.server");
  const folders = await foldersFor(userId, projectId, s);
  const sourceFileId = await putFile(folders.source, `${sourceHash}.json`, JSON.stringify({ framework, sourceHash, files }));
  const buildId = `${Date.now().toString(36)}${randomToken().slice(0, 8)}`;
  const token = randomToken();
  await patch(userId, projectId, {
    buildStatus: "queued", buildId, buildTokenHash: await sha256(token), buildExpires: Date.now() + TOKEN_TTL_MS,
    pendingSourceHash: sourceHash, pendingSourceFileId: sourceFileId, buildError: "", buildUpdatedAt: new Date().toISOString(),
    projectType: "react-vite", ...folderSettings(folders),
  });

  const pat = envStr("GITHUB_PAT");
  if (!pat) { await patch(userId, projectId, { buildStatus: "failed", buildError: "Build runtime is not configured." }); throw new BuildError("Build runtime is not configured (missing GitHub token).", 503); }
  const res = await fetch(`https://api.github.com/repos/${RUNTIME_REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "speed-api", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { build_id: buildId, project_id: projectId, user_id: userId, api_url: apiOrigin(), token } }),
  });
  if (!res.ok) {
    const msg = `Could not start the build runtime (${res.status}).`;
    console.error(`[build] dispatch failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await patch(userId, projectId, { buildStatus: "failed", buildError: msg, buildTokenHash: "" });
    throw new BuildError(msg, 502);
  }
  return { status: "queued", previewUrl: stateOf(s, userId, projectId).previewUrl, buildId, sourceHash };
}

/** Validates a runtime call: matching current build, unexpired token, constant-time-ish hash compare. */
async function authorizeRuntime(req: Request, projectId: string, buildId: string) {
  const proj = await loadProject(projectId);
  if (!proj) throw new BuildError("Not found", 404);
  const s = proj.settings;
  const token = /^Bearer\s+(\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token || s["buildId"] !== buildId || !s["buildTokenHash"] || Number(s["buildExpires"] ?? 0) < Date.now() || (await sha256(token)) !== s["buildTokenHash"])
    throw new BuildError("Unauthorized", 401);
  return proj;
}

/** Runtime fetches the exact source bundle that was hashed, plus a short-lived Drive upload pass for this project's
 *  static folder (a ~1h access token minted from the stored refresh token; the refresh token itself never leaves). */
export async function serveSource(req: Request, projectId: string, buildId: string): Promise<Response> {
  const proj = await authorizeRuntime(req, projectId, buildId);
  const { getFileText, driveToken } = await import("../storage/drive.server");
  const src = JSON.parse(await getFileText(String(proj.settings["pendingSourceFileId"]))) as Record<string, unknown>;
  const folders = await foldersFor(proj.ownerId, projectId, proj.settings);
  await patch(proj.ownerId, projectId, { buildStatus: "building", buildUpdatedAt: new Date().toISOString() });
  return Response.json({ ...src, upload: { folderId: folders.static, accessToken: await driveToken(), name: `.output-dist-${buildId}.json` } }, { headers: { "Cache-Control": "no-store" } });
}

type StaticFile = { path: string; content: string }; // content is base64

/** Runtime reports after it pushed .output/dist to Drive and deleted its workspace. Failures keep the previous preview. */
export async function acceptResult(req: Request, projectId: string, buildId: string): Promise<Response> {
  const proj = await authorizeRuntime(req, projectId, buildId);
  const userId = proj.ownerId, s = proj.settings;
  // Token is single-use from here on.
  await patch(userId, projectId, { buildTokenHash: "" });
  const body = (await req.json().catch(() => null)) as { ok?: boolean; error?: string; driveFileId?: string; cleaned?: boolean } | null;
  const fail = async (msg: string, status = 200) => {
    await patch(userId, projectId, { buildStatus: "failed", buildError: msg.slice(0, 2000), buildUpdatedAt: new Date().toISOString() });
    return Response.json({ ok: false, error: msg }, { status });
  };
  if (!body) return fail("Runtime sent an unreadable result.", 400);
  if (!body.ok) return fail(body.error || "Build failed.");
  if (!body.driveFileId || !/^[\w-]{10,128}$/.test(body.driveFileId)) return fail("Runtime did not report a Google Drive upload.", 400);
  const { getFileText, deleteFile } = await import("../storage/drive.server");
  try {
    // Verify the upload really landed in this project's static folder before trusting it.
    const folders = await foldersFor(userId, projectId, s);
    const { drive } = await import("../storage/drive.server");
    const meta = (await (await drive(`/files/${body.driveFileId}?fields=parents,trashed&supportsAllDrives=true`)).json().catch(() => ({}))) as { parents?: string[]; trashed?: boolean };
    if (meta.trashed || !meta.parents?.includes(folders.static)) return fail("The uploaded build was not found in this project's Drive folder.", 400);
    const uploaded = JSON.parse(await getFileText(body.driveFileId)) as { files?: StaticFile[] };
    const r = await storeArtifact(userId, projectId, s, Array.isArray(uploaded.files) ? uploaded.files : [], String(s["pendingSourceHash"]), "react-vite", String(s["pendingSourceFileId"]), body.driveFileId);
    await patch(userId, projectId, { runtimeCleaned: body.cleaned === true });
    return Response.json({ ok: true, status: r.changed ? "deployed" : "static-unchanged" });
  } catch (e) {
    await deleteFile(body.driveFileId);
    return fail(e instanceof ArtifactError ? e.message : `Storing the build failed: ${e instanceof Error ? e.message : "unknown error"}`, e instanceof ArtifactError ? 400 : 502);
  }
}

type Folders = { project: string; source: string; static: string; assets: string; metadata: string };
const folderSettings = (f: Folders): Settings => ({ driveProjectFolderId: f.project, driveSourceFolderId: f.source, driveStaticFolderId: f.static, driveAssetsFolderId: f.assets, driveMetadataFolderId: f.metadata });
/** Uses persisted folder IDs; only walks/creates the Drive hierarchy when any are missing. */
async function foldersFor(userId: string, projectId: string, s: Settings): Promise<Folders> {
  const k = ["driveProjectFolderId", "driveSourceFolderId", "driveStaticFolderId", "driveAssetsFolderId", "driveMetadataFolderId"].map((x) => str(s[x]));
  if (k.every(Boolean)) return { project: k[0]!, source: k[1]!, static: k[2]!, assets: k[3]!, metadata: k[4]! };
  const { projectFolders } = await import("../storage/drive.server");
  return projectFolders(userId, projectId);
}

/** Static HTML projects skip GitHub: their final files are validated and stored as the artifact directly. */
async function publishStatic(userId: string, projectId: string, s: Settings, files: HashFile[], sourceHash: string): Promise<BuildState> {
  const artifact: ArtifactFile[] = files.map((f) => ({ path: f.path, content: f.encoding === "base64" ? f.content : toB64(f.content) }));
  try {
    await patch(userId, projectId, { buildStatus: "building", buildError: "", projectType: "static", buildUpdatedAt: new Date().toISOString() });
    await storeArtifact(userId, projectId, s, artifact, sourceHash, "static", null);
    return { status: "ready", previewUrl: previewUrlFor(userId, projectId), sourceHash };
  } catch (e) {
    const msg = e instanceof ArtifactError ? e.message : `Storing the preview failed: ${e instanceof Error ? e.message : "unknown error"}`;
    await patch(userId, projectId, { buildStatus: "failed", buildError: msg.slice(0, 2000), buildUpdatedAt: new Date().toISOString() });
    throw new BuildError(msg, 502);
  }
}

/** Validate → hash → upload (only when changed) → metadata → switch pointer → remove the old version.
 *  `preUploaded` is a bundle the runtime already pushed to Drive; it is kept as-is when validation didn't alter it. */
async function storeArtifact(userId: string, projectId: string, s: Settings, raw: ArtifactFile[], sourceHash: string, projectType: ProjectType, sourceFileId: string | null, preUploaded?: string) {
  const art = prepareArtifact(raw);
  const files = art.files;
  const staticHash = await hashFiles(files.map((f) => ({ path: f.path, content: f.content, encoding: "base64" })));
  const folders = await foldersFor(userId, projectId, s);
  const { putFile, deleteFile, drive } = await import("../storage/drive.server");
  let staticFileId = str(s["staticFileId"]);
  const changed = staticHash !== s["staticHash"] || !staticFileId;
  const rawMap = new Map(raw.map((f) => [f.path, f.content]));
  const untouched = files.length === raw.length && files.every((f) => rawMap.get(f.path) === f.content);
  // New version is written under its own name first; the pointer switches only after the upload succeeds.
  if (changed && preUploaded && untouched) {
    const r = await drive(`/files/${preUploaded}?supportsAllDrives=true&fields=id`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `${staticHash}.json` }) });
    if (!r.ok) throw new Error(`Drive rename failed (${r.status})`);
    staticFileId = preUploaded;
  } else {
    if (changed) staticFileId = await putFile(folders.static, `${staticHash}.json`, JSON.stringify({ staticHash, entry: art.entry, files }), "application/json", null);
    if (preUploaded) await deleteFile(preUploaded);
  }
  const buildVersion = Number(s["buildVersion"] ?? 0) + (changed ? 1 : 0);
  const now = new Date().toISOString();
  const metadataFileId = await putFile(folders.metadata, "metadata.json", JSON.stringify({
    userId, projectId, projectType, sourceHash, artifactHash: staticHash, buildStatus: "ready", buildVersion,
    driveFolders: folders, artifact: { entry: art.entry, fileCount: art.fileCount, bytes: art.bytes, uploadedAt: changed ? now : str(s["artifactUploadedAt"]) ?? now },
    lastSuccessfulBuildAt: now, preview: { loader: "drive", entry: art.entry },
  }, null, 2), "application/json", str(s["metadataFileId"]) ?? undefined);
  const oldStatic = str(s["staticFileId"]), oldSource = str(s["sourceFileId"]);
  await patch(userId, projectId, {
    ...folderSettings(folders), projectType, buildStatus: "ready", buildError: "", sourceHash, sourceFileId: sourceFileId ?? "", staticHash, staticFileId: staticFileId!,
    metadataFileId, previewUrl: previewUrlFor(userId, projectId), buildVersion, pendingSourceHash: "", pendingSourceFileId: "",
    artifactUploadedAt: changed ? now : str(s["artifactUploadedAt"]) ?? now, lastSuccessAt: now, buildUpdatedAt: now,
  });
  // Old versions are removed only after the new pointer is saved.
  if (changed && oldStatic && oldStatic !== staticFileId) await deleteFile(oldStatic);
  if (oldSource && oldSource !== sourceFileId) await deleteFile(oldSource);
  if (changed) dropPreviewCache(projectId);
  return { changed };
}

// ---- Preview serving -------------------------------------------------------------------------
const bundles = new Map<string, { hash: string; files: Map<string, Uint8Array> }>();
const dropPreviewCache = (projectId: string) => bundles.delete(projectId);

const MIME: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", txt: "text/plain; charset=utf-8", xml: "application/xml", webmanifest: "application/manifest+json", map: "application/json", wasm: "application/wasm", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg" };
const b64ToBytes = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

// ---- Temporary preview sessions -------------------------------------------------------------
// A session is an HMAC-signed, expiring token scoped to userId + projectId + sessionId. Nothing is stored per
// session, so abandoned sessions cannot pile up; they simply expire. Closing one revokes it in this isolate
// and drops its cached files. The Drive artifact, source and project are never touched.
export const PREVIEW_TTL_S = 30 * 60;
const revoked = new Map<string, number>();
const b64u = (u: Uint8Array | string) => btoa(typeof u === "string" ? u : String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sign(body: string) {
  const secret = envStr("AUTH_SECRET");
  if (!secret) throw new BuildError("Preview is not configured.", 503);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`preview-session:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))));
}
type Session = { uid: string; pid: string; sid: string; exp: number };
export async function openPreviewSession(userId: string, projectId: string) {
  const proj = await loadProject(projectId);
  if (!proj || proj.ownerId !== userId) throw new BuildError("Project not found", 404);
  if (!proj.settings["staticFileId"]) return { url: null, expiresAt: null, version: 0 };
  const sess: Session = { uid: userId, pid: projectId, sid: randomToken().slice(0, 16), exp: Math.floor(Date.now() / 1000) + PREVIEW_TTL_S };
  const body = b64u(JSON.stringify(sess));
  const token = `${body}.${await sign(body)}`;
  return { url: `${apiOrigin()}/preview/s/${token}/`, expiresAt: sess.exp * 1000, version: Number(proj.settings["buildVersion"] ?? 0) };
}
export async function readSession(token: string): Promise<Session | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig || (await sign(body)) !== sig) return null;
  let s: Session;
  try { s = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as Session; } catch { return null; }
  const now = Date.now() / 1000;
  for (const [k, e] of revoked) if (e < now) revoked.delete(k);
  return s.exp > now && !revoked.has(s.sid) ? s : null;
}
export async function closePreviewSession(userId: string, token: string) {
  const s = await readSession(token);
  if (!s || s.uid !== userId) return { closed: false };
  revoked.set(s.sid, s.exp);
  dropPreviewCache(s.pid);
  return { closed: true };
}

/** GET /preview/s/{session}/{path} — Drive Preview Loader: serves the latest known-good artifact for the session's project. */
export async function servePreviewSession(token: string, path: string): Promise<Response> {
  const sess = await readSession(token);
  if (!sess) return new Response("This preview session has expired. Reopen Preview to continue.", { status: 401, headers: { "Content-Type": "text/plain" } });
  return servePreview(sess.uid, sess.pid, path);
}

async function servePreview(userId: string, projectId: string, path: string): Promise<Response> {
  const proj = await loadProject(projectId);
  const s = proj?.settings;
  if (!proj || proj.ownerId !== userId || !s?.["staticFileId"]) return new Response("Preview not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  const hash = String(s["staticHash"]);
  let b = bundles.get(projectId);
  if (!b || b.hash !== hash) {
    const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
    const key = new Request(`https://preview-cache.speed/${projectId}/${hash}`);
    let text = cache ? await (await cache.match(key))?.text() : undefined;
    if (!text) {
      const { getFileText } = await import("../storage/drive.server");
      text = await getFileText(String(s["staticFileId"]));
      if (cache) await cache.put(key, new Response(text, { headers: { "Cache-Control": "public, max-age=86400" } })).catch(() => undefined);
    }
    const parsed = JSON.parse(text) as { files: StaticFile[] };
    b = { hash, files: new Map(parsed.files.map((f) => [f.path, b64ToBytes(f.content)])) };
    bundles.set(projectId, b);
  }
  const clean = path.replace(/^\/+/, "");
  let file = clean ? (b.files.get(clean) ?? b.files.get(`${clean.replace(/\/$/, "")}/index.html`)) : b.files.get("index.html");
  let name = file ? (b.files.has(clean) ? clean : "index.html") : "index.html";
  // SPA fallback: unknown extension-less routes render index.html; missing assets are a real 404.
  if (!file) { if (/\.[a-z0-9]+$/i.test(clean)) return new Response(`Missing file in this build: ${clean}`, { status: 404, headers: { "Content-Type": "text/plain" } }); file = b.files.get("index.html"); name = "index.html"; }
  const ext = name.split(".").pop()!.toLowerCase();
  return new Response(file as BodyInit, {
    headers: {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": ext === "html" ? "no-cache" : "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
      // Generated code runs in an opaque origin so it can never act as the API's origin.
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
