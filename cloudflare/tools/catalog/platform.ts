// Tools over existing platform services: build artifact checks/upload (build/pipeline.server.ts), integration
// connect/disconnect (api/connections.ts), background tasks (api/tasks.ts). Handlers only call those services.
import { group } from "../registry";
import { z, ToolFailure } from "./util";
import type { ToolEnv } from "../types";

/** Maps service errors (BuildError / AuthError / plain) onto the standard tool error codes. */
function fail(e: unknown, fallback: "BUILD_FAILED" | "INTEGRATION_FAILED" | "UNKNOWN_ERROR"): never {
  if (e instanceof ToolFailure) throw e;
  const err = e as { status?: number; message?: string };
  const msg = err?.message ?? String(e);
  const st = err?.status;
  if (st === 404 || /not found/i.test(msg)) throw new ToolFailure("INVALID_ARGUMENT", msg);
  if (st === 401 || st === 403) throw new ToolFailure("PERMISSION_DENIED", msg);
  if (st === 409) throw new ToolFailure("CONFLICT", msg);
  if (st === 503) throw new ToolFailure("INTEGRATION_FAILED", msg, false);
  throw new ToolFailure(fallback, msg, !!st && st >= 500);
}
const call = async <T>(fn: () => Promise<T>, fb: Parameters<typeof fail>[1]) => { try { return await fn(); } catch (e) { fail(e, fb); } };

const bd = group({ category: "build", requiredPermissions: ["build:run"] });
export const buildArtifactTools = [
  bd({
    name: "verify_build_output", readOnly: true, timeoutMs: 30_000, retryPolicy: { maxAttempts: 2, backoffMs: 600 },
    description: "Re-validate the project's stored build output: index.html entry, safe paths, size limits, hash integrity and no leaked secrets.",
    purpose: "Confirm the published build is complete and safe before relying on it.",
    capabilities: ["check build output", "validate artifact", "dist"],
    outputSchema: z.object({ ok: z.boolean(), fileCount: z.number(), hashMatches: z.boolean(), issues: z.array(z.string()) }).passthrough(),
    inputSchema: z.object({}),
    handler: async (_a, env: ToolEnv) => {
      const { verifyBuildOutput } = await import("../../functions/build/pipeline.server");
      const r = await call(() => verifyBuildOutput(env.userId, env.projectId), "BUILD_FAILED");
      return { data: r, ...(r.ok ? {} : { warnings: r.issues, next: "run_production_build" }) };
    },
  }),
  bd({
    name: "upload_build", readOnly: false, idempotent: true, supportsParallelExecution: false, timeoutMs: 60_000, requiredPermissions: ["build:run", "preview:manage"],
    description: "Upload a static (plain HTML) project's current files to Google Drive as its build and switch the preview to it. Unchanged files are not re-uploaded. React + Vite builds are uploaded by the build runtime (run_production_build).",
    purpose: "Publish static project output without a GitHub build.",
    capabilities: ["upload build", "publish static", "drive upload"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      await env.commit("Before upload");
      const { uploadBuild } = await import("../../functions/build/pipeline.server");
      const r = await call(() => uploadBuild(env.userId, env.projectId), "BUILD_FAILED");
      return { data: r, stateChanges: [{ kind: "build", target: env.projectId, detail: r.status }], next: "verify_upload" };
    },
  }),
  bd({
    name: "verify_upload", readOnly: true, timeoutMs: 30_000, retryPolicy: { maxAttempts: 2, backoffMs: 600 },
    description: "Check the live build file in Google Drive: exists, not trashed, inside this project's static folder, name matches the build hash, and metadata points at it.",
    purpose: "Confirm an upload actually landed where the preview reads it.",
    capabilities: ["check upload", "drive file"],
    inputSchema: z.object({}),
    handler: async (_a, env) => {
      const { verifyUpload } = await import("../../functions/build/pipeline.server");
      const r = await call(() => verifyUpload(env.userId, env.projectId), "BUILD_FAILED");
      return { data: r, ...(r.ok ? {} : { warnings: r.issues }) };
    },
  }),
];

const INTEGRATIONS = ["supabase", "google_drive", "google_gmail", "google_sheets", "google_docs", "google_calendar"] as const;
const ig = group({ category: "integrations", projectScoped: false, supportsParallelExecution: false });
export const integrationControlTools = [
  ig({
    name: "connect_integration", readOnly: false, idempotent: false, requiredPermissions: ["integration:write"], timeoutMs: 15_000,
    description: "Start connecting one of the user's accounts (Supabase or a Google service). Returns the sign-in URL the user must open themselves; the connection exists only after they approve. Tokens never reach the agent.",
    purpose: "Let the user authorize a service the project needs.",
    capabilities: ["connect", "oauth", "link account"],
    inputSchema: z.object({ integration: z.enum(INTEGRATIONS) }),
    handler: async (a, env) => {
      const { startIntegrationConnect } = await import("../../functions/api/connections");
      const { ctx } = await import("../../functions/context");
      const { apiOrigin } = await import("../../functions/build/pipeline.server");
      const origin = (ctx().env.ALLOWED_ORIGINS ?? "").split(",").map((x: string) => x.trim().replace(/\/$/, "")).find((x: string) => x && !x.includes("*"));
      if (!origin) throw new ToolFailure("INTEGRATION_FAILED", "No app origin is configured to return to after sign-in");
      const r = await call(() => startIntegrationConnect(env.userId, a.integration, origin, apiOrigin()), "INTEGRATION_FAILED");
      return { data: { integration: a.integration, authorizeUrl: r.url, expiresInSeconds: r.expiresInSeconds, status: "awaiting_user_authorization" }, warnings: ["The user must open authorizeUrl and approve; call list_integrations afterwards to confirm."], next: "list_integrations" };
    },
  }),
  ig({
    name: "disconnect_integration", readOnly: false, destructive: true, requiresConfirmation: true, idempotent: false, requiredPermissions: ["integration:write"], timeoutMs: 20_000,
    description: "Revoke and remove one of the user's connections (GitHub, or a connection id from list_integrations). Needs confirmation.",
    purpose: "Remove access the user no longer wants to grant.",
    capabilities: ["disconnect", "revoke", "unlink account"],
    inputSchema: z.union([z.object({ integration: z.literal("github") }), z.object({ connectionId: z.string().uuid() })]),
    handler: async (a, env) => {
      const { disconnectIntegrationFor } = await import("../../functions/api/connections");
      const r = await call(() => disconnectIntegrationFor(env.userId, a), "INTEGRATION_FAILED");
      return { data: r, stateChanges: [{ kind: "integration", target: r.removed, detail: "disconnected" }] };
    },
  }),
];

const tk = group({ category: "planning", requiredPermissions: ["task:manage"], supportsParallelExecution: false });
export const taskControlTools = [
  tk({
    name: "create_task", readOnly: false, idempotent: true, timeoutMs: 15_000,
    description: "Start a background task for this project (durable, runs on the server; progress via get_task_progress). The agent cannot start another agent task.",
    purpose: "Hand long-running work to the background task runner.",
    capabilities: ["background job", "queue task"],
    inputSchema: z.object({ type: z.string().regex(/^[a-z_]{2,60}$/), payload: z.record(z.string(), z.unknown()).default({}), idempotencyKey: z.string().min(1).max(120).optional() }),
    handler: async (a, env) => {
      if (a.type === "ai_agent") throw new ToolFailure("SECURITY_BLOCKED", "The agent cannot start another agent task");
      const { createTaskFor } = await import("../../functions/api/tasks");
      const r = await call(() => createTaskFor(env.userId, { type: a.type, projectId: env.projectId, payload: { ...a.payload, projectId: env.projectId }, idempotencyKey: a.idempotencyKey ?? `${env.operationId}` }), "UNKNOWN_ERROR");
      return { data: r, stateChanges: [{ kind: "task", target: (r as { id: string }).id, detail: r.created ? "created" : "existing" }] };
    },
  }),
  tk({
    name: "cancel_task", readOnly: false, idempotent: true, timeoutMs: 15_000,
    description: "Request cancellation of a background task in this project. Finished tasks are left as they are; the current agent task cannot cancel itself.",
    purpose: "Stop background work that is no longer needed.",
    capabilities: ["stop task", "abort job"],
    inputSchema: z.object({ taskId: z.string().min(8).max(64).regex(/^[\w-]+$/) }),
    handler: async (a, env) => {
      if (a.taskId === env.taskId) throw new ToolFailure("INVALID_ARGUMENT", "A task cannot cancel itself");
      const { cancelTaskFor } = await import("../../functions/api/tasks");
      const r = await call(() => cancelTaskFor(env.userId, a.taskId, env.projectId), "UNKNOWN_ERROR");
      return { data: r, stateChanges: [{ kind: "task", target: a.taskId, detail: r.alreadyFinished ? "already finished" : "cancel requested" }] };
    },
  }),
];
