// Pushes Speed backend secrets into the Cloudflare account-level Secrets Store ("speed").
// Usage: bun cloudflare/secrets-store.ts   — values are read from the environment and never printed.
// Needs a token with "Secrets Store: Edit" permission.
export const STORE_NAME = "speed";
export const STORE_SECRETS = ["SMTP_EMAIL", "SMTP_PASSWORD", "REALTIME_SECRET", "AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITLAB_CLIENT_ID", "GITLAB_CLIENT_SECRET", "BITBUCKET_CLIENT_ID", "BITBUCKET_CLIENT_SECRET", "SUPABASE_CLIENT_ID", "SUPABASE_CLIENT_SECRET", "STRIPE_WEBHOOK_SECRET", "NVIDIA_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "GITHUB_PAT", "GOOGLE_REFRESH_TOKEN", "GOOGLE_DRIVE_FOLDER_ID"];

const env = process.env;
const API = `https://api.cloudflare.com/client/v4/accounts/${env["CLOUDFLARE_ACCOUNT_ID"]}/secrets_store/stores`;
const headers = { Authorization: `Bearer ${env["CLOUDFLARE_API_TOKEN"]}`, "Content-Type": "application/json" };
type R<T> = { success: boolean; errors: { message: string }[]; result: T };
const call = async <T>(url: string, init: RequestInit = {}) => {
  const r = (await (await fetch(url, { ...init, headers })).json()) as R<T>;
  if (!r.success) throw new Error(`Secrets Store: ${r.errors.map((e) => e.message).join("; ")}`);
  return r.result;
};

/** Returns the store id, creating the store if needed. */
export async function ensureStore() {
  const stores = await call<{ id: string; name: string }[]>(API);
  const found = stores.find((s) => s.name === STORE_NAME) ?? stores[0];
  if (found) return found.id;
  const [created] = await call<{ id: string }[]>(API, { method: "POST", body: JSON.stringify({ name: STORE_NAME }) });
  return created!.id;
}

/** Creates or updates every secret present in the environment; returns names stored. */
export async function pushSecrets(storeId: string) {
  const existing = await call<{ id: string; name: string }[]>(`${API}/${storeId}/secrets?per_page=100`);
  const pushed: string[] = [];
  for (const name of STORE_SECRETS) {
    const value = env[name];
    if (!value) continue;
    const cur = existing.find((s) => s.name === name);
    if (cur) await call(`${API}/${storeId}/secrets/${cur.id}`, { method: "PATCH", body: JSON.stringify({ value, scopes: ["workers"] }) });
    else await call(`${API}/${storeId}/secrets`, { method: "POST", body: JSON.stringify([{ name, value, scopes: ["workers"] }]) });
    pushed.push(name);
  }
  return pushed;
}

/** Names of every Speed secret currently held in the store. */
export async function listStored(storeId: string) {
  const existing = await call<{ name: string }[]>(`${API}/${storeId}/secrets?per_page=100`);
  return STORE_SECRETS.filter((n) => existing.some((s) => s.name === n));
}

if (import.meta.main) {
  const id = await ensureStore();
  console.log(`Store ${id}: stored ${(await pushSecrets(id)).join(", ")}`);
}
