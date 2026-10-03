// Speed API — Cloudflare Worker entry. All backend functionality lives here:
//   POST /rpc/:name             JSON RPC for auth + live data (Authorization: Bearer <session>)
//   GET  /auth/start/:provider  OAuth start (?return=<allowed frontend origin>)
//   GET  /oauth/:provider/callback  sign-in (google, github, gitlab, bitbucket) and integrations (supabase; google/<service>/callback — see connect/providers.ts)
//   POST /stripe/webhook        signature-verified billing events
//   GET  /health
import { ZodError } from "zod";
import { als, isAllowedOrigin, resolveSecrets, type Env } from "./context";
import { AuthError } from "@security/authorize.server";
import * as auth from "./api/auth";
import * as sync from "./api/sync";
import * as github from "./api/github";
import * as imports from "./api/imports";
import * as connections from "./api/connections";
import * as tasks from "./api/tasks";
import * as files from "./api/files";
import * as build from "./api/build";
export { TaskRunner } from "../tasks/runner";

import * as toolsApi from "./api/tools";
const handlers: Record<string, (data: unknown) => Promise<unknown>> = { ...toolsApi, ...auth, ...sync, ...github, ...imports, ...connections, ...tasks, ...files, ...build } as never;

function cors(origin: string | null, env: Env): Record<string, string> {
  if (!isAllowedOrigin(origin, env)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

async function oauthStart(req: Request, env: Env, p: string) {
  const { providerConfig, authorizeUrl, callbackUrl, isProvider } = await import("./oauth");
  const { randomId } = await import("@security/session.server");
  const ret = new URL(req.url).searchParams.get("return");
  if (!isAllowedOrigin(ret, env)) return new Response("Origin not allowed", { status: 403 });
  if (!isProvider(p)) return Response.redirect(`${ret}/auth/login?error=unknown_provider`, 302);
  const cfg = providerConfig(p);
  if (!cfg) return Response.redirect(`${ret}/auth/login?error=${p}_not_configured`, 302);
  const state = randomId(16);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl(p, cfg.id, callbackUrl(req, p), state),
      "Set-Cookie": `speed_oauth=${state}.${b64u(ret)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

async function oauthCallback(req: Request, env: Env, p: string) {
  const raw = /(?:^|;\s*)speed_oauth=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? "";
  const [cookieState, encOrigin] = raw.split(".");
  let origin: string | null = null;
  try { origin = encOrigin ? unb64u(encOrigin) : null; } catch { origin = null; }
  if (!isAllowedOrigin(origin, env)) return new Response("Sign-in expired, please try again", { status: 400 });
  const clear = "speed_oauth=; Path=/; Max-Age=0";
  const fail = (msg: string) => new Response(null, { status: 302, headers: { Location: `${origin}/auth/login?error=${encodeURIComponent(msg)}`, "Set-Cookie": clear } });
  const { providerConfig, fetchIdentity, callbackUrl, isProvider } = await import("./oauth");
  if (!isProvider(p)) return fail("Unknown provider");
  const { upsertOAuthUser, createSession, userFromToken } = await import("@security/session.server");
  const cfg = providerConfig(p);
  if (!cfg) return fail(`${p} sign-in is not configured`);
  const url = new URL(req.url);
  const denied = url.searchParams.get("error");
  if (denied) return fail(denied === "access_denied" ? "GitHub authorization was cancelled" : "Sign-in failed");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== cookieState) return fail("Sign-in expired, please try again");
  try {
    const who = await fetchIdentity(p, code, callbackUrl(req, p), cfg);
    const userId = await upsertOAuthUser(p, who.id, who.email, who.name, who.avatar);
    if (p === "github" && who.tokens) {
      const { saveGithubTokens } = await import("@security/github.server");
      await saveGithubTokens(userId, who.id, who.login ?? "", who.tokens);
    }
    const token = await createSession(userId);
    const me = await userFromToken(token);
    const next = me?.onboarded ? "/dashboard" : "/getting-started";
    return new Response(null, { status: 302, headers: { Location: `${origin}/auth/oauth#token=${token}&next=${encodeURIComponent(next)}`, "Set-Cookie": clear } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Sign-in failed";
    console.error(`[oauth] ${p} callback failed`); // never log codes or tokens
    return fail(/D1|SQL/i.test(msg) ? "Could not save your account, please try again" : msg);
  }
}

async function stripeWebhook(req: Request, env: Env) {
  const secret = typeof env["STRIPE_WEBHOOK_SECRET"] === "string" ? env["STRIPE_WEBHOOK_SECRET"] : "";
  if (!secret) return new Response("Billing is not configured", { status: 503 });
  const body = await req.text();
  const { verifyStripeSignature, applySubscription } = await import("@security/stripe.server");
  if (!(await verifyStripeSignature(body, req.headers.get("stripe-signature"), secret))) return new Response("Invalid signature", { status: 401 });
  const event = JSON.parse(body) as { id: string; type: string; data: { object: Record<string, unknown> } };
  const { notifyBilling } = await import("./email/billing.server");
  if (event.type.startsWith("customer.subscription.")) {
    const userId = await applySubscription(event.data.object as Parameters<typeof applySubscription>[0]);
    if (userId) await notifyBilling(event, userId);
  } else if (event.type === "invoice.payment_succeeded" || event.type === "invoice.payment_failed") {
    await notifyBilling(event, null);
  }
  return new Response("ok");
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const h = cors(origin, env);
  if (req.method === "OPTIONS") return new Response(null, { status: isAllowedOrigin(origin, env) ? 204 : 403, headers: h });

  const rpc = /^\/rpc\/([A-Za-z]+)$/.exec(url.pathname);
  if (rpc && req.method === "POST") {
    // Browser calls must come from an allowed frontend origin.
    if (origin && !isAllowedOrigin(origin, env)) return json({ error: "Origin not allowed" }, 403, h);
    const fn = handlers[rpc[1]!];
    if (!fn) return json({ error: "Not found" }, 404, h);
    let body: { data?: unknown } = {};
    try { body = (await req.json()) as { data?: unknown }; } catch { body = {}; }
    try {
      return json({ result: (await fn(body.data)) ?? null }, 200, h);
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message }, e.status, h);
      if (e instanceof ZodError) return json({ error: e.issues[0]?.message ?? "Invalid input" }, 400, h);
      console.error(`[rpc] ${rpc[1]} failed:`, (e as Error).message);
      return json({ error: e instanceof Error ? e.message : "Server error" }, 500, h);
    }
  }
  const start = /^\/auth\/start\/(\w+)$/.exec(url.pathname) ?? /^\/oauth\/(\w+)\/?$/.exec(url.pathname);
  if (start && req.method === "GET") return oauthStart(req, env, start[1]!);
  if (req.method === "GET" && /^\/oauth\/\w+(\/\w+)?\/callback\/?$/.test(url.pathname)) {
    const { integrationForCallback } = await import("./connect/providers");
    const integ = integrationForCallback(url.pathname);
    if (integ) return (await import("./connect/callback")).connectCallback(req, integ);
  }
  const cb = /^\/oauth\/(\w+)\/callback\/?$/.exec(url.pathname) ?? /^\/auth\/callback\/(\w+)$/.exec(url.pathname);
  if (cb && req.method === "GET") return oauthCallback(req, env, cb[1]!);
  if (url.pathname === "/stripe/webhook" && req.method === "POST") return stripeWebhook(req, env);
  if (url.pathname === "/api/github/repos" && req.method === "GET") {
    if (origin && !isAllowedOrigin(origin, env)) return json({ error: "Origin not allowed" }, 403, h);
    try { return json({ result: await github.githubRepos() }, 200, h); }
    catch (e) { return json({ error: e instanceof Error ? e.message : "Server error" }, e instanceof AuthError ? e.status : 500, h); }
  }
  if ((url.pathname === "/api/github/tree" || url.pathname === "/api/github/file") && req.method === "GET") {
    if (origin && !isAllowedOrigin(origin, env)) return json({ error: "Origin not allowed" }, 403, h);
    const q = Object.fromEntries(url.searchParams);
    try { return json({ result: await (url.pathname.endsWith("tree") ? github.githubTree(q) : github.githubFile(q)) }, 200, h); }
    catch (e) {
      if (e instanceof ZodError) return json({ error: e.issues[0]?.message ?? "Invalid input" }, 400, h);
      return json({ error: e instanceof Error ? e.message : "Server error" }, e instanceof AuthError ? e.status : 500, h);
    }
  }
  const rt = /^\/runtime\/(source|result)\/([\w-]{1,64})\/([\w-]{1,64})$/.exec(url.pathname);
  if (rt && ((rt[1] === "source" && req.method === "GET") || (rt[1] === "result" && req.method === "POST"))) {
    const p = await import("./build/pipeline.server");
    try { return await (rt[1] === "source" ? p.serveSource(req, rt[2]!, rt[3]!) : p.acceptResult(req, rt[2]!, rt[3]!)); }
    catch (e) { return json({ error: e instanceof Error ? e.message : "Server error" }, e instanceof p.BuildError ? e.status : 500, {}); }
  }
  const pv = /^\/preview\/s\/([\w-]{1,600}\.[\w-]{20,100})(\/.*)?$/.exec(url.pathname);
  if (pv && (req.method === "GET" || req.method === "HEAD")) {
    if (!pv[2]) return new Response(null, { status: 301, headers: { Location: `${url.pathname}/${url.search}` } });
    const { servePreviewSession } = await import("./build/pipeline.server");
    try { return await servePreviewSession(pv[1]!, decodeURIComponent(pv[2].slice(1))); }
    catch { return new Response("Preview temporarily unavailable", { status: 503 }); }
  }
  if (url.pathname === "/health") return json({ ok: true }, 200, h);
  if (url.pathname === "/health/storage" && req.method === "GET") {
    const { verifyDriveRoot } = await import("./storage/drive.server");
    const r = await verifyDriveRoot();
    return json(r, r.ok ? 200 : 503, h);
  }
  if (url.pathname === "/health/storage/test" && req.method === "POST") {
    const { writeTestMetadata } = await import("./storage/drive.server");
    const r = await writeTestMetadata();
    return json(r, r.ok ? 200 : 503, h);
  }
  return json({ error: "Not found" }, 404, h);
}

export default {
  async fetch(req: Request, env: Env) {
    const e = await resolveSecrets(env);
    return als.run({ req, env: e }, () => route(req, e));
  },
};
