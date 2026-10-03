// Deploys the Speed API Worker ("speed-api") to the Cloudflare account.
// Usage: bun backend/deploy.ts
// Reads from the deploy environment (never from source):
//   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_D1_DATABASE_ID   (required)
//   SMTP_EMAIL, SMTP_PASSWORD, REALTIME_SECRET, REALTIME_URL                  (required)
//   ALLOWED_ORIGINS  comma-separated frontend origins, `*` wildcards allowed (required)
//   GOOGLE_/GITHUB_CLIENT_ID/_SECRET, STRIPE_WEBHOOK_SECRET                   (optional)
const env = process.env;
const need = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_D1_DATABASE_ID"];
const missing = need.filter((k) => !env[k]);
if (missing.length) throw new Error(`Missing: ${missing.join(", ")}`);

const NAME = "speed-api";
const API = `https://api.cloudflare.com/client/v4/accounts/${env["CLOUDFLARE_ACCOUNT_ID"]}/workers`;
const auth = { Authorization: `Bearer ${env["CLOUDFLARE_API_TOKEN"]}` };

// Plain settings fall back to the values already on the live Worker.
if (!env["REALTIME_URL"] || !env["ALLOWED_ORIGINS"]) {
  const s = (await (await fetch(`${API}/scripts/${NAME}/settings`, { headers: auth })).json()) as { result?: { bindings?: { name: string; text?: string }[] } };
  for (const b of s.result?.bindings ?? []) if ((b.name === "REALTIME_URL" || b.name === "ALLOWED_ORIGINS") && !env[b.name] && b.text) env[b.name] = b.text;
}
for (const k of ["REALTIME_URL", "ALLOWED_ORIGINS"]) if (!env[k]) throw new Error(`Missing: ${k}`);

const built = await Bun.build({
  entrypoints: [`${import.meta.dir}/index.ts`],
  target: "browser",
  format: "esm",
  external: ["node:*", "cloudflare:*"],
  tsconfig: `${import.meta.dir}/../../tsconfig.json`,
} as Parameters<typeof Bun.build>[0]);
if (!built.success) throw new Error(`Build failed: ${built.logs.join("\n")}`);
const code = await built.outputs[0]!.text();

// Secrets come only from the Cloudflare Secrets Store (pushed first, then bound by name).
const { ensureStore, pushSecrets, listStored } = await import("../secrets-store");
const storeId = await ensureStore();
await pushSecrets(storeId);
const stored = await listStored(storeId);
// Sandbox D1 (project codebases) is found or created by name, and its migrations applied.
const { ensureSandboxDb } = await import("../sandbox/setup");
const sandboxDbId = await ensureSandboxDb();
const settings = (await (await fetch(`${API}/scripts/${NAME}/settings`, { headers: auth })).json()) as { result?: { bindings?: { type: string; name: string }[] } };
const hasTasks = (settings.result?.bindings ?? []).some((b) => b.name === "TASKS");
const metadata = {
  main_module: "index.js",
  compatibility_date: "2025-09-01",
  compatibility_flags: ["nodejs_compat"],
  bindings: [
    { type: "d1", name: "DB", id: env["CLOUDFLARE_D1_DATABASE_ID"] },
    { type: "d1", name: "SANDBOX_DB", id: sandboxDbId },
    { type: "durable_object_namespace", name: "TASKS", class_name: "TaskRunner" },
    { type: "plain_text", name: "REALTIME_URL", text: env["REALTIME_URL"] },
    { type: "plain_text", name: "ALLOWED_ORIGINS", text: env["ALLOWED_ORIGINS"] },
    ...stored.map((k) => ({ type: "secrets_store_secret", name: k, store_id: storeId, secret_name: k })),
  ],
  ...(hasTasks ? {} : { migrations: { new_tag: "tasks-v1", new_sqlite_classes: ["TaskRunner"] } }),
};
const form = new FormData();
form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
form.append("index.js", new Blob([code], { type: "application/javascript+module" }), "index.js");
const up = (await (await fetch(`${API}/scripts/${NAME}`, { method: "PUT", headers: auth, body: form })).json()) as { success: boolean; errors: unknown };
if (!up.success) throw new Error(`Upload failed: ${JSON.stringify(up.errors)}`);

await fetch(`${API}/scripts/${NAME}/subdomain`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
const sub = (await (await fetch(`${API}/subdomain`, { headers: auth })).json()) as { result?: { subdomain?: string } };
console.log(`https://${NAME}.${sub.result?.subdomain}.workers.dev`);
