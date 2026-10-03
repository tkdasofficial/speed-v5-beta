import type { FileEntry, FileStore } from "../types/filesystem";

// In-browser static site runner: turns one .output page into a self-contained document.
// Local CSS/JS/images/fonts/modules become inline code or data URLs, and a small runtime
// inside the page routes link clicks, form GETs, location changes and fetch() back to .output.

const MIME: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  json: "application/json", svg: "image/svg+xml", txt: "text/plain", xml: "application/xml", webmanifest: "application/manifest+json",
  ico: "image/x-icon", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", mp3: "audio/mpeg", mp4: "video/mp4", webm: "video/webm",
};
export const mimeOf = (path: string) => MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
const isExternal = (ref: string) => /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);

/** Resolves a reference relative to `from` into a .output path (no query/hash). */
export function resolvePath(from: string, ref: string): string {
  const dir = from.split("/").slice(0, -1).join("/");
  const clean = ref.split(/[?#]/)[0]!;
  const raw = clean.startsWith("/") ? clean.slice(1) : dir ? `${dir}/${clean}` : clean;
  const parts: string[] = [];
  for (const s of raw.split("/")) { if (!s || s === ".") continue; if (s === "..") parts.pop(); else parts.push(s); }
  return parts.join("/");
}

/** Finds the page a link points to: exact file, folder index, or extensionless .html. */
export function findPage(output: FileStore, path: string): string | null {
  for (const c of [path, path ? `${path}/index.html` : "index.html", `${path}.html`]) if (output.get(c) && /\.html?$/i.test(c)) return c;
  return null;
}

const toB64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const dataUrl = (f: FileEntry, body?: string) => `data:${mimeOf(f.path)};base64,${f.encoding === "base64" && body === undefined ? f.content : toB64(body ?? f.content)}`;

class Ctx {
  private modules = new Map<string, string>();
  constructor(readonly out: FileStore) {}
  file(from: string, ref: string) { return isExternal(ref) ? undefined : this.out.get(resolvePath(from, ref)); }
  asset(from: string, ref: string): string | undefined {
    const f = this.file(from, ref);
    if (!f) return undefined;
    if (/\.css$/i.test(f.path)) return dataUrl(f, this.css(f.path, f.content));
    if (/\.m?js$/i.test(f.path)) return this.module(f.path);
    return dataUrl(f);
  }
  css(path: string, css: string): string {
    return css
      .replace(/@import\s+(?:url\()?\s*["']([^"']+)["']\s*\)?\s*;/gi, (m, ref: string) => { const f = this.file(path, ref); return f ? this.css(f.path, f.content) : m; })
      .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, _q, ref: string) => { const u = this.asset(path, ref.trim()); return u ? `url("${u}")` : m; });
  }
  js(path: string, code: string): string {
    const rw = (m: string, pre: string, ref: string, post: string) => {
      if (!/^\.{0,2}\//.test(ref)) return m;
      const f = this.out.get(resolvePath(path, ref));
      return f ? `${pre}${this.module(f.path)}${post}` : m;
    };
    return code
      .replace(/(\b(?:import|export)\s[^"'`;]*?\bfrom\s*["'])([^"']+)(["'])/g, rw)
      .replace(/(\bimport\s*["'])([^"']+)(["'])/g, rw)
      .replace(/(\bimport\(\s*["'])([^"']+)(["']\s*\))/g, rw);
  }
  module(path: string): string {
    const hit = this.modules.get(path);
    if (hit) return hit;
    const f = this.out.get(path)!;
    this.modules.set(path, dataUrl(f)); // cycle guard
    const u = /\.m?js$/i.test(path) ? dataUrl(f, this.js(path, f.content)) : dataUrl(f);
    this.modules.set(path, u);
    return u;
  }
}

function runtime(page: string, files: Record<string, { c: string; t: string; b: boolean }>): string {
  return `<script>(function(){var P=${JSON.stringify(page)},F=${JSON.stringify(files).replace(/</g, "\\u003c")};
function res(r){var c=r.split(/[?#]/)[0],d=P.split("/").slice(0,-1).join("/"),raw=c.charAt(0)=="/"?c.slice(1):(d?d+"/"+c:c),o=[];raw.split("/").forEach(function(s){if(!s||s==".")return;if(s=="..")o.pop();else o.push(s)});return o.join("/")}
function ext(r){return /^([a-z][a-z0-9+.-]*:|\\/\\/)/i.test(r)}
function go(r){if(!r)return;if(r.charAt(0)=="#"){var el=document.getElementById(decodeURIComponent(r.slice(1)));if(el)el.scrollIntoView();return}parent.postMessage({__speedPreview:"navigate",path:res(r),hash:(r.split("#")[1]||"")},"*")}
document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a||e.defaultPrevented)return;var h=a.getAttribute("href");if(!h||/^(javascript|mailto|tel):/i.test(h))return;e.preventDefault();if(ext(h)){window.open(a.href,"_blank","noopener");return}go(h)},false);
document.addEventListener("submit",function(e){var f=e.target,m=(f.getAttribute("method")||"get").toLowerCase(),a=f.getAttribute("action");if(m!="get"||!a||ext(a))return;e.preventDefault();go(a)},false);
var of=window.fetch;window.fetch=function(i,o){var u=typeof i=="string"?i:(i&&i.url)||"";if(u&&!ext(u)&&!/^(data|blob):/.test(u)){var k=res(u),f=F[k];if(!f)return Promise.resolve(new Response("Not found",{status:404}));var body=f.b?Uint8Array.from(atob(f.c),function(ch){return ch.charCodeAt(0)}):f.c;return Promise.resolve(new Response(body,{status:200,headers:{"Content-Type":f.t}}))}return of.apply(this,arguments)};
try{history.pushState=function(s,t,u){if(u)go(String(u))};history.replaceState=function(){}}catch(e){}
window.addEventListener("error",function(e){parent.postMessage({__speedPreview:"error",message:String(e.message||e)},"*")});
})();</script>`;
}

/** Renders `page` from .output as a standalone document for an iframe srcdoc; null if missing. */
export function runStaticPage(output: FileStore, page: string): string | null {
  const html = output.get(page)?.content;
  if (html === undefined) return null;
  const ctx = new Ctx(output);
  const files: Record<string, { c: string; t: string; b: boolean }> = {};
  for (const f of output.list()) if (/\.(json|txt|xml|csv|svg|md|html?)$/i.test(f.path) || f.content.length < 300_000) files[f.path] = { c: f.content, t: mimeOf(f.path), b: f.encoding === "base64" };
  let doc = html
    .replace(/<link\b[^>]*>/gi, (tag) => {
      const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1];
      if (!href) return tag;
      const f = ctx.file(page, href);
      if (!f) return tag;
      if (/rel=["'][^"']*stylesheet/i.test(tag)) return `<style data-src="${f.path}">${ctx.css(f.path, f.content)}</style>`;
      return tag.replace(href, ctx.asset(page, href)!);
    })
    .replace(/<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, a: string, src: string, b: string) => {
      const f = ctx.file(page, src);
      if (!f) return tag;
      const attrs = `${a}${b}`.replace(/\s+(defer|async)\b(=["'][^"']*["'])?/gi, "");
      const isModule = /type=["']module["']/i.test(attrs);
      const body = (isModule ? ctx.js(f.path, f.content) : f.content).replace(/<\/script/gi, "<\\/script");
      // Deferred classic scripts must still see the parsed DOM.
      const defer = !isModule && /\bdefer\b/i.test(tag);
      return defer ? `<script${attrs}>document.addEventListener("DOMContentLoaded",function(){${body}\n});</script>` : `<script${attrs}>${body}</script>`;
    })
    .replace(/<script\b([^>]*type=["']module["'][^>]*)>([\s\S]*?)<\/script>/gi, (_m, a: string, code: string) => `<script${a}>${ctx.js(page, code)}</script>`)
    .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_m, a: string, css: string) => `<style${a}>${ctx.css(page, css)}</style>`)
    .replace(/\b(src|poster|data)=["']([^"']+)["']/gi, (m, k: string, ref: string) => { const u = ctx.asset(page, ref); return u ? `${k}="${u}"` : m; })
    .replace(/\bsrcset=["']([^"']+)["']/gi, (_m, set: string) => `srcset="${set.split(",").map((p) => { const [u, ...d] = p.trim().split(/\s+/); return [ctx.asset(page, u!) ?? u, ...d].join(" "); }).join(", ")}"`)
    .replace(/\bstyle=["']([^"']*url\([^"']*)["']/gi, (_m, s: string) => `style="${ctx.css(page, s).replace(/"/g, "'")}"`);
  const rt = runtime(page, files);
  doc = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (h) => h + rt) : rt + doc;
  return doc;
}
