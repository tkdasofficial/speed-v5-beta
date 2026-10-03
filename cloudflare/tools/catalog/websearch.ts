// web_search: free/public sources only (no keys, no secrets). SearXNG, DuckDuckGo, Wikipedia and Reddit are queried
// in parallel with per-source timeouts; results are normalized, de-duplicated by canonical URL, ranked and attributed.
// A source failure becomes a warning; the tool fails only when every source fails.
import { defineTool } from "../registry";
import { z, ToolFailure } from "./util";
import { redact } from "../policy";
import type { ToolEnv } from "../types";

export interface SearchResult { title: string; url: string; snippet: string; domain: string; source: string; publishedAt?: string }
export interface SearchProvider { name: string; weight: number; available(): boolean; search(q: string, n: number, signal: AbortSignal): Promise<SearchResult[]> }
export interface MergedResult extends Omit<SearchResult, "source"> { source: string; sources: string[]; score: number; rank: number }

const UA = "Mozilla/5.0 (compatible; SpeedAgent/1.0; +https://speed-api.tusharkantidasofficial.workers.dev)";
const decode = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const domainOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const httpUrl = (u: string) => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : null; } catch { return null; } };
const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Canonical key for de-duplication: lowercase host without www/m., no fragment, no tracking params, no trailing slash. */
export function canonicalUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    x.hostname = x.hostname.toLowerCase().replace(/^(www|m|old)\./, "");
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|ref$|ref_src$|fbclid$|gclid$|si$)/.test(k)) x.searchParams.delete(k);
    x.protocol = "https:";
    return x.toString().replace(/\/(\?|$)/, "$1");
  } catch { return u; }
}

// ---------- parsers (exported for tests) ----------

export function parseDuckDuckGo(html: string, n: number): SearchResult[] {
  const out: SearchResult[] = [];
  const blocks = html.split(/(?=<div[^>]+class="[^"]*\bresult\b[^"]*")/).filter((b) => b.startsWith("<div"));
  for (const b of blocks) {
    if (/result--ad\b/.test(b.slice(0, 200))) continue;
    const a = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    const url = ddgHref(a[1]!);
    if (!url) continue;
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(b);
    out.push({ title: decode(a[2]!), url, snippet: sn ? decode(sn[1]!) : "", domain: domainOf(url), source: "duckduckgo" });
    if (out.length >= n) break;
  }
  return out;
}

function ddgHref(raw: string): string | null {
  let href = raw.replace(/&amp;/g, "&");
  const ud = /[?&]uddg=([^&]+)/.exec(href);
  if (ud) href = decodeURIComponent(ud[1]!);
  if (href.startsWith("//")) href = `https:${href}`;
  const url = httpUrl(href);
  return !url || /duckduckgo\.com\/(y\.js|l\/)/.test(url) ? null : url;
}

/** DuckDuckGo Lite: results are table rows (link row, snippet row). */
export function parseDuckDuckGoLite(html: string, n: number): SearchResult[] {
  const out: SearchResult[] = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class=['"]result-link|$)/g;
  for (let m; (m = re.exec(html)) && out.length < n;) {
    if (/sponsored|result-sponsored/i.test(m[0].slice(0, 300))) continue;
    const url = ddgHref(m[1]!);
    if (!url) continue;
    const sn = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/.exec(m[3]!);
    out.push({ title: decode(m[2]!), url, snippet: sn ? decode(sn[1]!) : "", domain: domainOf(url), source: "duckduckgo" });
  }
  return out;
}

type DdgTopic = { FirstURL?: string; Text?: string; Topics?: DdgTopic[] };
/** DuckDuckGo instant-answer JSON: abstract + related topics (used when the HTML pages are bot-checked). */
export function parseDuckDuckGoInstant(j: { AbstractURL?: string; AbstractText?: string; Heading?: string; Results?: DdgTopic[]; RelatedTopics?: DdgTopic[] }, n: number): SearchResult[] {
  const out: SearchResult[] = [];
  if (j.AbstractURL && j.AbstractText) out.push({ title: j.Heading || domainOf(j.AbstractURL), url: j.AbstractURL, snippet: clip(j.AbstractText), domain: domainOf(j.AbstractURL), source: "duckduckgo" });
  const flat = [...(j.Results ?? []), ...(j.RelatedTopics ?? []).flatMap((t) => (t.Topics ? t.Topics : [t]))];
  for (const t of flat) {
    if (out.length >= n) break;
    const url = t.FirstURL && httpUrl(t.FirstURL);
    if (!url || !t.Text) continue;
    const [title, ...rest] = t.Text.split(" - ");
    out.push({ title: decode(title!), url, snippet: decode(rest.join(" - ") || t.Text), domain: domainOf(url), source: "duckduckgo" });
  }
  return out;
}

export function parseSearxng(j: { results?: { title?: string; url?: string; content?: string; publishedDate?: string | null }[] }, n: number): SearchResult[] {
  return (j.results ?? []).flatMap((x) => {
    const url = x.url && httpUrl(x.url);
    return url && x.title ? [{ title: decode(x.title), url, snippet: clip(decode(x.content ?? "")), domain: domainOf(url), source: "searxng", ...(x.publishedDate ? { publishedAt: x.publishedDate } : {}) }] : [];
  }).slice(0, n);
}

export function parseWikipedia(j: { query?: { search?: { title: string; snippet?: string; timestamp?: string }[] } }, n: number, lang = "en"): SearchResult[] {
  return (j.query?.search ?? []).slice(0, n).map((x) => {
    const url = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, "_"))}`;
    return { title: x.title, url, snippet: clip(decode(x.snippet ?? "")), domain: `${lang}.wikipedia.org`, source: "wikipedia", ...(x.timestamp ? { publishedAt: x.timestamp } : {}) };
  });
}

type RedditPost = { data?: { title?: string; permalink?: string; selftext?: string; subreddit_name_prefixed?: string; over_18?: boolean; score?: number; num_comments?: number; created_utc?: number } };
export function parseReddit(j: { data?: { children?: RedditPost[] } }, n: number): SearchResult[] {
  return (j.data?.children ?? []).flatMap((c) => {
    const d = c.data;
    if (!d?.title || !d.permalink || d.over_18) return [];
    const url = `https://www.reddit.com${d.permalink}`;
    const meta = `${d.subreddit_name_prefixed ?? "reddit"} · ${d.score ?? 0} points · ${d.num_comments ?? 0} comments`;
    return [{ title: decode(d.title), url, snippet: clip(d.selftext ? `${meta} — ${decode(d.selftext)}` : meta), domain: "reddit.com", source: "reddit", ...(d.created_utc ? { publishedAt: new Date(d.created_utc * 1000).toISOString() } : {}) }];
  }).slice(0, n);
}

/** Reddit's public Atom search feed (used when the JSON API refuses unauthenticated cloud traffic). */
export function parseRedditRss(xml: string, n: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const e of xml.split("<entry>").slice(1)) {
    if (out.length >= n) break;
    const link = /<link href="([^"]+)"/.exec(e)?.[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(e)?.[1];
    const url = link && httpUrl(decode(link));
    if (!url || !title || !/reddit\.com\/r\//.test(url)) continue;
    const sub = /reddit\.com\/r\/([^/]+)/.exec(url)?.[1];
    const body = /<content[^>]*>([\s\S]*?)<\/content>/.exec(e)?.[1] ?? "";
    const text = decode(decode(body)).replace(/submitted by .*$/, "").trim();
    const updated = /<updated>([^<]+)<\/updated>/.exec(e)?.[1];
    out.push({ title: decode(title), url, snippet: clip(`r/${sub ?? "reddit"}${text ? ` — ${text}` : ""}`), domain: "reddit.com", source: "reddit", ...(updated ? { publishedAt: updated } : {}) });
  }
  return out;
}

// ---------- transport ----------

async function get(url: string, init: RequestInit, signal: AbortSignal, name: string) {
  const r = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) }, signal, redirect: "follow" }).catch((e: unknown) => {
    if (signal.aborted || (e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") throw new ToolFailure("TIMEOUT", `${name} did not answer in time`, true);
    throw new ToolFailure("INTEGRATION_FAILED", `${name} unreachable`, true);
  });
  if (r.status === 429) throw new ToolFailure("RESOURCE_LIMIT", `${name} rate limit reached`, true);
  if (!r.ok && r.status !== 202) throw new ToolFailure("INTEGRATION_FAILED", `${name} returned HTTP ${r.status}`, r.status >= 500);
  return r;
}
async function json<T>(r: Response, name: string): Promise<T> {
  const t = await r.text();
  try { return JSON.parse(t) as T; } catch { throw new ToolFailure("INTEGRATION_FAILED", `${name} returned a non-JSON page (likely a bot check)`, true); }
}

/** Public SearXNG instances with the JSON API enabled; tried in order until one answers. */
export const SEARXNG_INSTANCES = [
  "https://search.lumy.live", "https://searx.be", "https://search.inetol.net", "https://priv.au", "https://searx.tiekoetter.com",
  "https://opnxng.com", "https://paulgo.io", "https://search.rhscz.eu", "https://etsi.me", "https://search.ononoki.org",
];

/** First-success over a list of attempts sharing one deadline; returns the first non-empty answer. */
async function firstOf(attempts: (() => Promise<SearchResult[]>)[], name: string): Promise<SearchResult[]> {
  const errs: string[] = [];
  let empty = false;
  for (const a of attempts) {
    try { const r = await a(); if (r.length) return r; empty = true; }
    catch (e) { errs.push((e as Error).message); if (e instanceof ToolFailure && e.code === "TIMEOUT") break; }
  }
  if (empty) return [];
  throw new ToolFailure(errs.some((e) => /in time/.test(e)) ? "TIMEOUT" : "INTEGRATION_FAILED", `${name}: ${errs.slice(0, 3).join("; ")}`, true);
}

export function providers(): SearchProvider[] {
  return [
    {
      name: "searxng", weight: 1.0, available: () => true,
      search: (q, n, signal) => firstOf(SEARXNG_INSTANCES.map((base) => async () => {
        const host = new URL(base).hostname;
        const r = await get(`${base}/search?q=${encodeURIComponent(q)}&format=json&language=en&safesearch=1`, { headers: { Accept: "application/json" } }, AbortSignal.any([signal, AbortSignal.timeout(4000)]), `SearXNG ${host}`)
          .catch((e) => { if (signal.aborted) throw e; throw new ToolFailure("INTEGRATION_FAILED", (e as Error).message.replace("did not answer in time", "was too slow"), true); });
        return parseSearxng(await json(r, `SearXNG ${host}`), n);
      }), "SearXNG"),
    },
    {
      name: "duckduckgo", weight: 1.0, available: () => true,
      search: (q, n, signal) => firstOf([
        async () => {
          const r = await get("https://html.duckduckgo.com/html/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `q=${encodeURIComponent(q)}&kl=us-en` }, AbortSignal.any([signal, AbortSignal.timeout(5000)]), "DuckDuckGo");
          const html = await r.text();
          if (r.status === 202 || /anomaly-modal|challenge-form/.test(html)) throw new ToolFailure("RESOURCE_LIMIT", "DuckDuckGo HTML asked for a bot check", true);
          return parseDuckDuckGo(html, n);
        },
        async () => {
          const r = await get(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}&kl=us-en`, {}, AbortSignal.any([signal, AbortSignal.timeout(4000)]), "DuckDuckGo Lite");
          const html = await r.text();
          if (r.status === 202 || /anomaly-modal|challenge-form/.test(html)) throw new ToolFailure("RESOURCE_LIMIT", "DuckDuckGo Lite asked for a bot check", true);
          return parseDuckDuckGoLite(html, n);
        },
        async () => {
          const r = await get(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, {}, signal, "DuckDuckGo Instant Answer");
          return parseDuckDuckGoInstant(await json(r, "DuckDuckGo Instant Answer"), n);
        },
      ].map((f) => async () => { try { return await f(); } catch (e) { if (signal.aborted) throw e; throw new ToolFailure("INTEGRATION_FAILED", (e as Error).message, true); } }), "DuckDuckGo"),
    },
    {
      name: "wikipedia", weight: 0.8, available: () => true,
      async search(q, n, signal) {
        const r = await get(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=${Math.min(n, 10)}&format=json&utf8=1&origin=*`, { headers: { Accept: "application/json" } }, signal, "Wikipedia");
        return parseWikipedia(await json(r, "Wikipedia"), n);
      },
    },
    {
      name: "reddit", weight: 0.6, available: () => true,
      search: (q, n, signal) => firstOf(["https://www.reddit.com", "https://old.reddit.com", "https://api.reddit.com"].map((base) => async () => {
        const path = base.includes("api.") ? "/search" : "/search.json";
        const r = await get(`${base}${path}?q=${encodeURIComponent(q)}&limit=${Math.min(n, 10)}&sort=relevance&type=link&raw_json=1`, { headers: { Accept: "application/json" } }, AbortSignal.any([signal, AbortSignal.timeout(4000)]), "Reddit")
          .catch((e) => { if (signal.aborted) throw e; throw new ToolFailure("INTEGRATION_FAILED", (e as Error).message, true); });
        return parseReddit(await json(r, "Reddit"), n);
      }).concat(async () => {
        const r = await get(`https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&limit=${Math.min(n, 10)}&sort=relevance&type=link`, { headers: { Accept: "application/atom+xml" } }, AbortSignal.any([signal, AbortSignal.timeout(4000)]), "Reddit RSS")
          .catch((e) => { if (signal.aborted) throw e; throw new ToolFailure("INTEGRATION_FAILED", (e as Error).message, true); });
        return parseRedditRss(await r.text(), n);
      }), "Reddit"),
    },
  ];
}

// ---------- merge & rank ----------

/** Reciprocal-rank fusion across sources, weighted per source, boosted when several sources agree; de-duplicated by canonical URL. */
export function mergeResults(lists: { provider: string; weight: number; results: SearchResult[] }[], q: string, n: number): MergedResult[] {
  const terms = q.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
  const by = new Map<string, MergedResult>();
  for (const l of lists) l.results.forEach((r, i) => {
    if (!r.url || !r.title) return;
    const key = canonicalUrl(r.url);
    const s = l.weight / (i + 3);
    const cur = by.get(key);
    if (!cur) { by.set(key, { ...r, sources: [l.provider], score: s, rank: 0 }); return; }
    if (!cur.sources.includes(l.provider)) cur.sources.push(l.provider);
    cur.score += s;
    if (r.snippet.length > cur.snippet.length) cur.snippet = r.snippet;
    if (!cur.publishedAt && r.publishedAt) cur.publishedAt = r.publishedAt;
  });
  const out = [...by.values()].map((r) => {
    const t = r.title.toLowerCase();
    const hit = terms.length ? terms.filter((x) => t.includes(x)).length / terms.length : 0;
    return { ...r, source: r.sources[0]!, score: +(r.score * (1 + 0.5 * (r.sources.length - 1)) * (1 + 0.3 * hit)).toFixed(4) };
  });
  out.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  // Keep variety: at most 3 results per domain unless that's all there is.
  const per = new Map<string, number>(), picked: MergedResult[] = [], spill: MergedResult[] = [];
  for (const r of out) { const c = per.get(r.domain) ?? 0; (c < 3 ? picked : spill).push(r); per.set(r.domain, c + 1); }
  return [...picked, ...spill].slice(0, n).map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Runs every available source in parallel, each with its own timeout. Fails only when every source failed. */
export async function searchWeb(q: string, n: number, list: SearchProvider[], o: { timeoutMs: number; signal?: AbortSignal | undefined; sources?: readonly string[] | undefined }) {
  const chosen = list.filter((p) => p.available() && (!o.sources?.length || o.sources.includes(p.name)));
  if (!chosen.length) throw new ToolFailure("INTEGRATION_FAILED", "No web search source is available", false);
  const t0 = Date.now();
  const settled = await Promise.all(chosen.map(async (p) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), o.timeoutMs);
    const onAbort = () => ac.abort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const s = Date.now();
    try {
      const results = await p.search(q, n, ac.signal);
      return { provider: p.name, weight: p.weight, ok: true as const, results, ms: Date.now() - s };
    } catch (e) {
      const f = e instanceof ToolFailure ? e : new ToolFailure(ac.signal.aborted ? "TIMEOUT" : "INTEGRATION_FAILED", (e as Error).message, true);
      const msg = ac.signal.aborted && f.code !== "TIMEOUT" ? `${p.name} did not answer in time` : f.message;
      return { provider: p.name, weight: p.weight, ok: false as const, error: redact(msg), code: ac.signal.aborted ? "TIMEOUT" : f.code, results: [] as SearchResult[], ms: Date.now() - s };
    } finally { clearTimeout(t); o.signal?.removeEventListener("abort", onAbort); }
  }));
  if (o.signal?.aborted) throw new ToolFailure("CANCELLED", "Search cancelled");
  const sources = settled.map((s) => ({ provider: s.provider, status: s.ok ? (s.results.length ? "ok" : "empty") : "failed", count: s.results.length, ms: s.ms, ...(s.ok ? {} : { error: s.error }) }));
  const failed = settled.filter((s) => !s.ok) as Extract<(typeof settled)[number], { ok: false }>[];
  const tried = failed.map((f) => ({ provider: f.provider, error: f.error }));
  if (failed.length === settled.length) {
    const allTimeouts = failed.every((f) => f.code === "TIMEOUT");
    throw new ToolFailure(allTimeouts ? "TIMEOUT" : "INTEGRATION_FAILED", `All search sources failed: ${tried.map((x) => `${x.provider}: ${x.error}`).join("; ")}`, true, { tried, sources });
  }
  const results = mergeResults(settled.filter((s) => s.ok), q, n);
  return { provider: settled.filter((s) => s.ok && s.results.length).map((s) => s.provider).join("+") || "none", results, tried, sources, tookMs: Date.now() - t0 };
}

const SOURCES = ["searxng", "duckduckgo", "wikipedia", "reddit"] as const;

export const webSearchTool = defineTool({
  name: "web_search", category: "search", requiredPermissions: ["network:fetch"], projectScoped: false, timeoutMs: 25_000, retryPolicy: { maxAttempts: 1, backoffMs: 0 },
  description: "Search the web through free public sources (SearXNG, DuckDuckGo, Wikipedia, Reddit) in parallel; returns merged, de-duplicated, ranked results with title, URL, snippet, domain and source attribution.",
  purpose: "Find current documentation, error explanations, libraries, discussions and examples on the web.",
  capabilities: ["google", "internet", "search online", "look up", "wikipedia", "reddit"],
  inputSchema: z.object({
    query: z.string().trim().min(2).max(300),
    limit: z.number().int().min(1).max(20).default(8),
    sources: z.array(z.enum(SOURCES)).min(1).max(4).optional(),
  }),
  handler: async (a, env: ToolEnv) => {
    const r = await searchWeb(a.query, a.limit, providers(), { timeoutMs: 12_000, signal: env.signal, sources: a.sources });
    return {
      data: {
        query: a.query, provider: r.provider, count: r.results.length, sources: r.sources,
        results: r.results.map((x) => ({ rank: x.rank, title: redact(x.title), url: x.url, snippet: redact(x.snippet), domain: x.domain, source: x.source, sources: x.sources, score: x.score, ...(x.publishedAt ? { publishedAt: x.publishedAt } : {}) })),
      },
      warnings: [...(r.results.length ? [] : ["No results found for this query."]), ...r.tried.map((t) => `${t.provider} unavailable: ${t.error}`)],
      metadata: { provider: r.provider, tookMs: r.tookMs, sourcesOk: r.sources.filter((s) => s.status !== "failed").length, sourcesFailed: r.tried.length },
    };
  },
});
