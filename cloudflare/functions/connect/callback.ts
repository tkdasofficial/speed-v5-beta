// Shared integration OAuth callback (/oauth/<provider>[/<service>]/callback). Provider specifics live in providers.ts.
// Always redirects back to the frontend's /integrations page with a sanitized message — never with tokens.
import type { Integration } from "./providers";

export async function connectCallback(req: Request, p: Integration): Promise<Response> {
  const { d1 } = await import("../d1");
  const { providerConfig } = await import("./providers");
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  type S = { user_id: string; integration: string; origin: string; verifier: string; expires_at: number };
  const s = state ? (await d1<S>("SELECT * FROM oauth_states WHERE state = ?", [state]))[0] : undefined;
  if (state) await d1("DELETE FROM oauth_states WHERE state = ?", [state]); // single use
  if (!s || s.integration !== p.id || s.expires_at < Math.floor(Date.now() / 1000)) return new Response("This connection link expired. Please start again from Integrations.", { status: 400 });
  const back = (q: Record<string, string>) => Response.redirect(`${s.origin}/integrations?${new URLSearchParams({ integration: p.id, ...q })}`, 302);
  const cfg = providerConfig(p.provider);
  if (!cfg) return back({ error: `${p.name} is not configured yet` });
  if (url.searchParams.get("error")) return back({ error: `${p.name} authorization was cancelled` });
  const code = url.searchParams.get("code");
  if (!code) return back({ error: "Connection expired, please try again" });
  try {
    const t = await p.exchange(cfg, code, `${url.origin}${p.callbackPath}`, s.verifier);
    const who = await p.identify(t.access_token);
    const check = await p.verify(t.access_token); // credential must actually work before we store it
    const { saveConnection } = await import("@security/connections.server");
    await saveConnection(s.user_id, p.id, who.externalId, who.label, t, check.metadata ?? null);
    return back({ connected: who.label });
  } catch (e) {
    console.error(`[connect] ${p.id} callback failed`); // never log codes or tokens
    return back({ error: e instanceof Error && !/D1|SQL/i.test(e.message) ? e.message : "Could not save the connection, please try again" });
  }
}
