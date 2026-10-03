// web_search: real web results through a provider chain. Keyed providers (Brave, Tavily) are used when their key is
// in the Worker's Secrets Store; otherwise DuckDuckGo's HTML results page (no key). Keys never appear in results/logs.
import { defineTool } from "../registry";
import { z, ToolFailure } from "./util";
import { redact } from "../policy";
import type { ToolEnv } from "../types";

export interface SearchResult { title: string; url: string; snippet: string; domain: string; source: string }
export interface SearchProvider { name: string; available(): boolean; search(q: string, n: number, signal: AbortSignal): Promise<SearchResult[]> }

const decode = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const domainOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const httpUrl = (u: string) => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : null; } catch { return null; } };

/** Parses DuckDuckGo's HTML results page (exported for tests). Ads and non-http links are dropped. */
export function parseDuckDuckGo(html: string, n: number): SearchResult[] {
  const out: SearchResult[] = [];
  const blocks = html.split(/(?=<div[^>]+class="[^"]*\bresult\b[^"]*")/).filter((b) => b.startsWith("<div"));
  for (const b of blocks) {
    if (/result--ad\b/.test(b.slice(0, 200))) continue;
    const a = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    let href = a[1]!.replace(/&amp;/g, "&");
    const ud = /[?&]uddg=([^&]+)/.exec(href);
    if (ud) href = decodeURIComponent(ud[1]!);
    if (href.startsWith("//")) href = `https:${href}`;
    const url = httpUrl(href);
    if (!url || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(b);
    out.push({ title: decode(a[2]!), url, snippet: sn ? decode(sn[1]!) : "", domain: domainOf(url), source: "duckduckgo" });
    if (out.length >= n) break;
  }
  return out;
}

async function get(url: string, init: RequestInit, signal: AbortSignal, name: string) {
  const r = await fetch(url, { ...init, signal, redirect: "follow" }).catch((e: unknown) => {
    if ((e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") throw new ToolFailure("TIMEOUT", `${name} did not answer in time`, true);
    throw new ToolFailure("INTEGRATION_FAILED", `${name} unreachable`, true);
  });
  if (r.status === 429) throw new ToolFailure("RESOURCE_LIMIT", `${name} rate limit reached`, true);
  if (!r.ok && r.status !== 202) throw new ToolFailure("INTEGRATION_FAILED", `${name} returned HTTP ${r.status}`, r.status >= 500);
  return r;
}

export function providers(secret: (k: string) => string | undefined): SearchProvider[] {
  return [
    {
      name: "brave", available: () => !!secret("BRAVE_SEARCH_API_KEY"),
      async search(q, n, signal) {
        const r = await get(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`, { headers: { Accept: "application/json", "X-Subscription-Token": secret("BRAVE_SEARCH_API_KEY")! } }, signal, "Brave Search");
        const j = (await r.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
        return (j.web?.results ?? []).map((x) => ({ title: decode(x.title), url: x.url, snippet: decode(x.description ?? ""), domain: domainOf(x.url), source: "brave" }));
      },
    },
    {
      name: "tavily", available: () => !!secret("TAVILY_API_KEY"),
      async search(q, n, signal) {
        const r = await get("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret("TAVILY_API_KEY")!}` }, body: JSON.stringify({ query: q, max_results: n }) }, signal, "Tavily");
        const j = (await r.json()) as { results?: { title: string; url: string; content?: string }[] };
        return (j.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: (x.content ?? "").slice(0, 400), domain: domainOf(x.url), source: "tavily" }));
      },
    },
    {
      name: "duckduckgo", available: () => true,
      async search(q, n, signal) {
        const r = await get("https://html.duckduckgo.com/html/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 (compatible; SpeedAgent/1.0)" }, body: `q=${encodeURIComponent(q)}&kl=us-en` }, signal, "DuckDuckGo");
        const html = await r.text();
        if (r.status === 202 || /anomaly-modal|challenge-form/.test(html)) throw new ToolFailure("RESOURCE_LIMIT", "DuckDuckGo asked for a bot check; try again later or configure BRAVE_SEARCH_API_KEY", true);
        return parseDuckDuckGo(html, n);
      },
    },
  ];
}

/** Tries available providers in order; a provider failure falls through to the next, never to fake results. */
export async function searchWeb(q: string, n: number, list: SearchProvider[], o: { timeoutMs: number; signal?: AbortSignal }) {
  const tried: { provider: string; error: string }[] = [];
  for (const p of list.filter((x) => x.available())) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), o.timeoutMs);
    o.signal?.addEventListener("abort", () => ac.abort(), { once: true });
    try {
      const results = (await p.search(q, n, ac.signal)).filter((r) => r.url && r.title);
      const uniq = [...new Map(results.map((r) => [r.url, r])).values()].slice(0, n);
      return { provider: p.name, results: uniq, tried };
    } catch (e) {
      const f = e instanceof ToolFailure ? e : new ToolFailure(ac.signal.aborted ? "TIMEOUT" : "INTEGRATION_FAILED", (e as Error).message, true);
      tried.push({ provider: p.name, error: redact(f.message) });
      if (o.signal?.aborted) throw new ToolFailure("CANCELLED", "Search cancelled");
    } finally { clearTimeout(t); }
  }
  if (!tried.length) throw new ToolFailure("INTEGRATION_FAILED", "No web search provider is configured", false);
  const allTimeouts = tried.every((x) => /in time|aborted/i.test(x.error));
  throw new ToolFailure(allTimeouts ? "TIMEOUT" : "INTEGRATION_FAILED", `All search providers failed: ${tried.map((x) => `${x.provider}: ${x.error}`).join("; ")}`, true, { tried });
}

async function secretReader(): Promise<(k: string) => string | undefined> {
  try { const { envStr } = await import("../../functions/context"); return (k) => envStr(k); } catch { return () => undefined; }
}

export const webSearchTool = defineTool({
  name: "web_search", category: "search", requiredPermissions: ["network:fetch"], projectScoped: false, timeoutMs: 25_000, retryPolicy: { maxAttempts: 2, backoffMs: 800 },
  description: "Search the web and return real results (title, URL, snippet, domain). Uses Brave or Tavily when configured, otherwise DuckDuckGo.",
  purpose: "Find current documentation, error explanations, libraries and examples on the web.",
  capabilities: ["google", "internet", "search online", "look up"],
  inputSchema: z.object({ query: z.string().trim().min(2).max(300), limit: z.number().int().min(1).max(20).default(8) }),
  handler: async (a, env: ToolEnv) => {
    const r = await searchWeb(a.query, a.limit, providers(await secretReader()), { timeoutMs: 12_000, signal: env.signal });
    return {
      data: { query: a.query, provider: r.provider, count: r.results.length, results: r.results.map((x) => ({ ...x, title: redact(x.title), snippet: redact(x.snippet) })) },
      warnings: [...(r.results.length ? [] : ["No results found for this query."]), ...r.tried.map((t) => `${t.provider} failed: ${t.error}`)],
      metadata: { provider: r.provider },
    };
  },
});
