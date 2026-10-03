// Deploys the relay to the Cloudflare account in CLOUDFLARE_ACCOUNT_ID.
// Usage: REALTIME_SECRET=... bun real-time/worker/deploy.ts
const account = process.env["CLOUDFLARE_ACCOUNT_ID"];
const token = process.env["CLOUDFLARE_API_TOKEN"];
const secret = process.env["REALTIME_SECRET"];
if (!account || !token || !secret) throw new Error("Missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN / REALTIME_SECRET");
const NAME = "speed-realtime";
const API = `https://api.cloudflare.com/client/v4/accounts/${account}/workers`;
const auth = { Authorization: `Bearer ${token}` };

const built = await Bun.build({ entrypoints: [`${import.meta.dir}/index.ts`], target: "browser", format: "esm" });
if (!built.success) throw new Error("Build failed");
const code = await built.outputs[0]!.text();

const { ensureStore, pushSecrets } = await import("../../secrets-store");
const storeId = await ensureStore();
await pushSecrets(storeId);
const existing = await fetch(`${API}/scripts/${NAME}/settings`, { headers: auth });
const fresh = existing.status === 404;
const metadata = {
  main_module: "index.js",
  compatibility_date: "2025-01-01",
  bindings: [
    { type: "durable_object_namespace", name: "HUB", class_name: "UserHub" },
    { type: "secrets_store_secret", name: "REALTIME_SECRET", store_id: storeId, secret_name: "REALTIME_SECRET" },
  ],
  ...(fresh ? { migrations: { new_tag: "v1", new_sqlite_classes: ["UserHub"] } } : {}),
};
const form = new FormData();
form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
form.append("index.js", new Blob([code], { type: "application/javascript+module" }), "index.js");
const up = await (await fetch(`${API}/scripts/${NAME}`, { method: "PUT", headers: auth, body: form })).json() as { success: boolean; errors: unknown };
if (!up.success) throw new Error(`Upload failed: ${JSON.stringify(up.errors)}`);

await fetch(`${API}/scripts/${NAME}/subdomain`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
const sub = await (await fetch(`${API}/subdomain`, { headers: auth })).json() as { result?: { subdomain?: string } };
console.log(`https://${NAME}.${sub.result?.subdomain}.workers.dev`);
