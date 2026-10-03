// Code transformation and asset tools: atomic multi-edit patches, multi-file replace, formatting, templates,
// and binary asset management in the project file store.
import { defineTool, group } from "../registry";
import { z, ToolFailure, P, getFile, write, remove, safeToolPath, fetchJson, ASSET_EXT, TEXT_EXT, detect, visible } from "./util";
import { validateFile } from "../../../sandbox/intelligence/validate";
import type { MemoryFileStore } from "../../../sandbox/workspace/workspace";

const diag = (s: MemoryFileStore, p: string) => validateFile(s, p).filter((d) => d.severity === "error").slice(0, 10);
const tf = group({ category: "transform", readOnly: false });

/** Whitespace normalization that never changes meaning: LF endings, no trailing spaces, one final newline; JSON re-indented. */
function basicFormat(path: string, text: string) {
  if (/\.json$/i.test(path)) { try { return `${JSON.stringify(JSON.parse(text), null, 2)}\n`; } catch (e) { throw new ToolFailure("INVALID_ARGUMENT", `${path} is not valid JSON: ${(e as Error).message}`); } }
  const keepTrailing = /\.md$/i.test(path); // markdown uses trailing double-space line breaks
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => (keepTrailing ? l : l.replace(/[ \t]+$/, "")));
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n")}\n`;
}

const pascal = (s: string) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^./, (c) => c.toUpperCase());

export const transformTools = [
  tf({
    name: "apply_patch", description: "Apply several exact find/replace edits to one file atomically (all or nothing).", capabilities: ["multi edit", "patch"],
    inputSchema: z.object({ path: P, edits: z.array(z.object({ find: z.string().min(1), replace: z.string() })).min(1).max(30) }),
    handler: async (a, env) => {
      const p = safeToolPath(a.path); const s = await env.files(); let next = getFile(s, p).content;
      for (const [i, e] of a.edits.entries()) {
        const n = next.split(e.find).length - 1;
        if (!n) throw new ToolFailure("INVALID_ARGUMENT", `Edit ${i + 1}: text not found in ${p} — nothing was changed`, false, undefined, "read_file");
        if (n > 1) throw new ToolFailure("INVALID_ARGUMENT", `Edit ${i + 1}: text appears ${n} times in ${p} — add surrounding context`, false, undefined, "read_file");
        next = next.replace(e.find, () => e.replace);
      }
      write(env, s, p, next);
      return { data: { path: p, edits: a.edits.length, diagnostics: diag(s, p) }, stateChanges: [{ kind: "file", target: p, detail: "patched" }] };
    },
  }),
  tf({
    name: "replace_in_files", description: "Replace exact text (or a regex) across many files, optionally limited by extension/folder.", capabilities: ["rename everywhere", "bulk replace"],
    inputSchema: z.object({ find: z.string().min(1).max(2000), replace: z.string().max(20000), regex: z.boolean().default(false), ext: z.array(z.string().max(10)).optional(), dir: z.string().max(400).optional(), dryRun: z.boolean().default(false) }),
    handler: async (a, env) => {
      const s = await env.files();
      let re: RegExp | null = null;
      if (a.regex) { try { re = new RegExp(a.find, "g"); } catch (e) { throw new ToolFailure("INVALID_ARGUMENT", `Bad regex: ${(e as Error).message}`); } }
      const changed: { path: string; count: number }[] = [];
      for (const f of visible(s)) {
        if (f.encoding !== "utf8" || !TEXT_EXT.test(f.path)) continue;
        if (a.dir && !f.path.startsWith(`${a.dir.replace(/\/+$/, "")}/`)) continue;
        if (a.ext && !a.ext.some((x) => f.path.endsWith(`.${x.replace(/^\./, "")}`))) continue;
        const count = re ? (f.content.match(re) ?? []).length : f.content.split(a.find).length - 1;
        if (!count) continue;
        changed.push({ path: f.path, count });
        if (!a.dryRun) write(env, s, f.path, re ? f.content.replace(re, a.replace) : f.content.split(a.find).join(a.replace));
        if (changed.length >= 300) break;
      }
      return { data: { files: changed, total: changed.reduce((n, c) => n + c.count, 0), dryRun: a.dryRun }, stateChanges: a.dryRun ? [] : changed.map((c) => ({ kind: "file" as const, target: c.path, detail: "replaced" })) };
    },
  }),
  tf({
    name: "format_file", description: "Normalize formatting of a file (JSON re-indent; line endings, trailing whitespace, final newline). Use run_formatter for full Prettier.", capabilities: ["format", "prettify"],
    inputSchema: z.object({ path: P }),
    handler: async (a, env) => {
      const p = safeToolPath(a.path); const s = await env.files(); const f = getFile(s, p);
      if (f.encoding !== "utf8") throw new ToolFailure("INVALID_ARGUMENT", "Binary files can't be formatted");
      const out = basicFormat(p, f.content);
      if (out !== f.content) write(env, s, p, out);
      return { data: { path: p, changed: out !== f.content }, stateChanges: out !== f.content ? [{ kind: "file", target: p, detail: "formatted" }] : [] };
    },
  }),
  tf({
    name: "generate_component", description: "Create a React component file (TSX for React projects) with a typed props interface, or an HTML partial for static sites.", capabilities: ["new component", "scaffold"],
    inputSchema: z.object({ name: z.string().regex(/^[A-Za-z][\w-]{0,60}$/), dir: z.string().max(300).default("src/components"), props: z.array(z.string().regex(/^[a-zA-Z_]\w*$/)).max(20).default([]) }),
    handler: async (a, env) => {
      const s = await env.files(); const d = detect(s); const N = pascal(a.name);
      const react = ["react-vite", "react", "next", "tanstack-start"].includes(d.framework);
      if (!react) {
        const p = safeToolPath(`partials/${a.name.toLowerCase()}.html`);
        if (s.get(p)) throw new ToolFailure("CONFLICT", `${p} already exists`);
        write(env, s, p, `<section class="${a.name.toLowerCase()}">\n  <!-- ${N} -->\n</section>\n`);
        return { data: { path: p, framework: d.framework }, stateChanges: [{ kind: "file", target: p, detail: "created" }] };
      }
      const ts = d.language === "typescript";
      const p = safeToolPath(`${a.dir.replace(/\/+$/, "")}/${N}.${ts ? "tsx" : "jsx"}`);
      if (s.get(p)) throw new ToolFailure("CONFLICT", `${p} already exists`, false, undefined, "read_file");
      const props = a.props;
      const body = `${ts && props.length ? `export interface ${N}Props {\n${props.map((x) => `  ${x}?: string;`).join("\n")}\n}\n\n` : ""}export function ${N}(${props.length ? `{ ${props.join(", ")} }${ts ? `: ${N}Props` : ""}` : ""}) {\n  return (\n    <div>\n      ${props.length ? props.map((x) => `{${x}}`).join(" ") : N}\n    </div>\n  );\n}\n\nexport default ${N};\n`;
      write(env, s, p, body);
      return { data: { path: p, component: N, diagnostics: diag(s, p) }, stateChanges: [{ kind: "file", target: p, detail: "created" }] };
    },
  }),
  tf({
    name: "generate_page", description: "Create a new page: an HTML page linked to the site's stylesheet (static) or a page component (React).", capabilities: ["new page", "new route"],
    inputSchema: z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,60}$/), title: z.string().max(120).default("") }),
    handler: async (a, env) => {
      const s = await env.files(); const d = detect(s); const title = a.title || pascal(a.name);
      if (d.framework === "static" || d.framework === "empty") {
        const p = `${a.name}.html`; if (s.get(p)) throw new ToolFailure("CONFLICT", `${p} already exists`);
        const css = s.list().find((f) => /\.css$/.test(f.path) && !f.path.includes("/"))?.path ?? s.list().find((f) => /\.css$/.test(f.path))?.path;
        write(env, s, p, `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>${title}</title>\n${css ? `  <link rel="stylesheet" href="${css}" />\n` : ""}</head>\n<body>\n  <main>\n    <h1>${title}</h1>\n  </main>\n</body>\n</html>\n`);
        return { data: { path: p, linkedStylesheet: css ?? null }, stateChanges: [{ kind: "file", target: p, detail: "created" }] };
      }
      const N = `${pascal(a.name)}Page`; const ts = d.language === "typescript";
      const p = safeToolPath(`src/pages/${N}.${ts ? "tsx" : "jsx"}`);
      if (s.get(p)) throw new ToolFailure("CONFLICT", `${p} already exists`);
      write(env, s, p, `export default function ${N}() {\n  return (\n    <main>\n      <h1>${title}</h1>\n    </main>\n  );\n}\n`);
      const changes = [{ kind: "file" as const, target: p, detail: "created" }];
      // Register the route: TanStack/file-based routers pick the file up by location; react-router <Routes> gets a <Route>.
      const routePath = `/${a.name}`;
      const fileRouter = s.list().some((f) => /^src\/routes\/__root\.[jt]sx$/.test(f.path)) ? "tanstack" : s.list().some((f) => /^(src\/)?app\/layout\.[jt]sx$/.test(f.path)) ? "next-app" : null;
      if (fileRouter === "tanstack") {
        const rp = `src/routes/${a.name}.${ts ? "tsx" : "jsx"}`;
        if (s.get(rp)) throw new ToolFailure("CONFLICT", `${rp} already exists`);
        write(env, s, rp, `import { createFileRoute } from "@tanstack/react-router";\nimport ${N} from "../pages/${N}";\n\nexport const Route = createFileRoute("${routePath}")({\n  head: () => ({ meta: [{ title: ${JSON.stringify(title)} }] }),\n  component: ${N},\n});\n`);
        changes.push({ kind: "file", target: rp, detail: "route created" });
        return { data: { path: p, component: N, route: routePath, routeFile: rp, router: "tanstack" }, stateChanges: changes, next: "verify_project" };
      }
      const host = s.list().find((f) => f.encoding === "utf8" && /\.[jt]sx$/.test(f.path) && /<Routes[\s>]/.test(f.content) && /react-router/.test(f.content));
      if (host) {
        const rel = `./${pathRel(host.path, p).replace(/\.[jt]sx$/, "")}`.replace(/^\.\/\.\.\//, "../");
        let c = host.content;
        if (!c.includes(`<Route path="${routePath}"`)) {
          c = c.replace(/(<Routes[^>]*>)/, `$1\n        <Route path="${routePath}" element={<${N} />} />`);
          const lastImport = [...c.matchAll(/^import .*;$/gm)].pop();
          const imp = `import ${N} from "${rel}";`;
          c = lastImport ? c.slice(0, lastImport.index! + lastImport[0].length) + `\n${imp}` + c.slice(lastImport.index! + lastImport[0].length) : `${imp}\n${c}`;
          write(env, s, host.path, c); changes.push({ kind: "file", target: host.path, detail: `route ${routePath} registered` });
        }
        return { data: { path: p, component: N, route: routePath, routeFile: host.path, router: "react-router" }, stateChanges: changes, next: "verify_project" };
      }
      return { data: { path: p, component: N, route: null, note: "No router found (single-page app); render the component where it should appear or add a router" }, stateChanges: changes, next: "analyze_routes" };
    },
  }),
];

/** Relative module path from one file to another (POSIX). */
function pathRel(from: string, to: string) {
  const a = from.split("/").slice(0, -1), b = to.split("/");
  let i = 0; while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  return `${up ? "../".repeat(up) : ""}${b.slice(i).join("/")}`;
}

// ---------------- assets ----------------
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", mp3: "audio/mpeg", mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf" };
const bytesOf = (f: { content: string; encoding: string }) => (f.encoding === "base64" ? Math.floor((f.content.length * 3) / 4) : new TextEncoder().encode(f.content).length);
/** Pixel size from PNG/GIF/JPEG/WebP headers (no decoding). */
function dims(b64: string): { width: number; height: number } | null {
  const b = Uint8Array.from(atob(b64.slice(0, 40000)), (c) => c.charCodeAt(0));
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!, l16 = (i: number) => b[i]! | (b[i + 1]! << 8);
  if (b[0] === 0x89 && b[1] === 0x50) return { width: (u16(16) << 16) | u16(18), height: (u16(20) << 16) | u16(22) };
  if (b[0] === 0x47 && b[1] === 0x49) return { width: l16(6), height: l16(8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length - 9;) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]!; if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: u16(i + 5), width: u16(i + 7) }; i += 2 + u16(i + 2); }
  }
  if (String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === "WEBP") {
    if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) === "VP8 ") return { width: l16(26) & 0x3fff, height: l16(28) & 0x3fff };
  }
  return null;
}
const as = group({ category: "assets" });
export const assetTools = [
  as({
    name: "list_assets", description: "Images, fonts, media and other binary assets in the project with sizes.", capabilities: ["images", "media files"],
    inputSchema: z.object({}),
    handler: async (_a, env) => { const s = await env.files(); const l = s.list().filter((f) => ASSET_EXT.test(f.path)).map((f) => ({ path: f.path, bytes: bytesOf(f), type: MIME[f.path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream" })); return { data: { assets: l, totalBytes: l.reduce((n, x) => n + x.bytes, 0) } }; },
  }),
  as({
    name: "get_asset_info", description: "Type, size and pixel dimensions of an asset.",
    inputSchema: z.object({ path: P, includeContent: z.boolean().default(false) }),
    handler: async (a, env) => {
      const p = safeToolPath(a.path); const f = getFile(await env.files(), p); const ext = p.split(".").pop()!.toLowerCase();
      const content = a.includeContent ? (bytesOf(f) > 256_000 ? null : f.encoding === "base64" ? { encoding: "base64", data: f.content } : { encoding: "utf8", data: f.content }) : undefined;
      const d = f.encoding === "base64" && /^(png|jpe?g|gif|webp)$/.test(ext) ? dims(f.content) : null;
      const svg = ext === "svg" ? /viewBox=["'][\d.\s-]+?\s([\d.]+)\s([\d.]+)["']/.exec(f.content) : null;
      return { data: { path: p, type: MIME[ext] ?? "application/octet-stream", bytes: bytesOf(f), ...(d ? d : svg ? { width: Number(svg[1]), height: Number(svg[2]) } : {}), ...(content !== undefined ? { content } : {}) }, ...(content === null ? { warnings: ["Asset is larger than 256 KB; content not returned"] } : {}) };
    },
  }),
  as({
    name: "upload_asset", description: "Add an asset to the project from base64 data or an https URL (max 900 KB).", readOnly: false, requiredPermissions: ["project:write", "network:fetch"], timeoutMs: 30_000, capabilities: ["add image", "download image"],
    inputSchema: z.object({ path: P, base64: z.string().max(1_200_000).optional(), url: z.string().url().max(2000).optional() }),
    handler: async (a, env) => {
      const p = safeToolPath(a.path);
      if (!ASSET_EXT.test(p)) throw new ToolFailure("INVALID_ARGUMENT", "Path must end with an asset extension (png, jpg, svg, woff2…)");
      let b64 = a.base64;
      if (!b64 && a.url) {
        const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20_000);
        try {
          const { safeExternalUrl } = await import("../policy"); safeExternalUrl(a.url);
          const r = await fetch(a.url, { signal: ac.signal }); if (!r.ok) throw new ToolFailure("INTEGRATION_FAILED", `Download failed (${r.status})`, r.status >= 500);
          const buf = new Uint8Array(await r.arrayBuffer()); if (buf.length > 900_000) throw new ToolFailure("RESOURCE_LIMIT", "Asset larger than 900 KB");
          let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); b64 = btoa(s);
        } finally { clearTimeout(t); }
      }
      if (!b64) throw new ToolFailure("INVALID_ARGUMENT", "base64 or url is required");
      try { atob(b64.slice(0, 64)); } catch { throw new ToolFailure("INVALID_ARGUMENT", "base64 is not valid"); }
      const s = await env.files();
      if (p.endsWith(".svg")) write(env, s, p, decodeURIComponent(escape(atob(b64)))); else write(env, s, p, b64, "base64");
      return { data: { path: p, bytes: Math.floor((b64.length * 3) / 4) }, stateChanges: [{ kind: "file", target: p, detail: "asset added" }] };
    },
  }),
  as({
    name: "delete_asset", description: "Delete an asset file (refuses while it is referenced unless force=true).", destructive: true, requiredPermissions: ["project:delete"],
    inputSchema: z.object({ path: P, force: z.boolean().default(false) }),
    handler: async (a, env) => {
      const p = safeToolPath(a.path); const s = await env.files(); getFile(s, p);
      const base = p.split("/").pop()!;
      const refs = s.list().filter((f) => f.path !== p && f.encoding === "utf8" && f.content.includes(base)).map((f) => f.path);
      if (refs.length && !a.force) throw new ToolFailure("CONFLICT", `${p} is referenced by ${refs.slice(0, 5).join(", ")}`, false, { refs });
      remove(env, s, p);
      return { data: { deleted: p, wasReferencedBy: refs }, stateChanges: [{ kind: "file", target: p, detail: "deleted" }] };
    },
  }),
  as({
    name: "optimize_svg", description: "Minify an SVG asset (strip comments, metadata, editor attributes, whitespace).", readOnly: false, capabilities: ["optimize image", "compress svg"],
    inputSchema: z.object({ path: z.string().regex(/\.svg$/i).optional() }),
    handler: async (a, env) => {
      if (!a.path) {
        const s = await env.files();
        const svgs = s.list().filter((f) => /\.svg$/i.test(f.path) && f.encoding === "utf8").map((f) => f.path);
        const raster = s.list().filter((f) => /\.(png|jpe?g|gif|webp|avif)$/i.test(f.path)).map((f) => f.path);
        const results = []; let saved = 0;
        for (const p of svgs) { const r = await env.run("optimize_svg", { path: p }); if (r.success) { const d = r.data as { before: number; after: number }; saved += d.before - d.after; results.push({ path: p, ...d }); } }
        return { data: { optimized: results, savedBytes: saved, skippedRaster: raster }, warnings: raster.length ? [`${raster.length} raster image(s) skipped: raster recompression is not available in the Worker runtime`] : [], stateChanges: results.filter((r) => r.after < r.before).map((r) => ({ kind: "file" as const, target: r.path, detail: "optimized" })) };
      }
      const p = safeToolPath(a.path); const s = await env.files(); const f = getFile(s, p);
      const out = f.content.replace(/<\?xml[^>]*>|<!--[\s\S]*?-->|<metadata[\s\S]*?<\/metadata>|<title>[\s\S]*?<\/title>/g, "").replace(/\s(inkscape|sodipodi|xmlns:(inkscape|sodipodi|dc|cc|rdf)|data-name)(:[\w-]+)?="[^"]*"/g, "").replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").trim();
      const before = f.content.length; if (out.length < before) write(env, s, p, out);
      return { data: { path: p, before, after: out.length, savedPercent: Math.round((1 - out.length / before) * 100) }, stateChanges: out.length < before ? [{ kind: "file", target: p, detail: "optimized" }] : [] };
    },
  }),
  as({
    name: "fetch_url", description: "GET an https URL (docs, JSON APIs) and return status, headers and a text excerpt.", projectScoped: false, requiredPermissions: ["network:fetch"], category: "api", capabilities: ["http get", "test api", "request"],
    inputSchema: z.object({ url: z.string().url().max(2000), method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), body: z.string().max(20000).optional(), headers: z.record(z.string(), z.string().max(500)).optional() }),
    handler: async (a, env) => {
      const h = Object.fromEntries(Object.entries(a.headers ?? {}).filter(([k]) => !/^(cookie|authorization|host)$/i.test(k)));
      const r = await fetchJson<unknown>(a.url, { method: a.method, headers: h, ...(a.body ? { body: a.body } : {}), timeoutMs: 15_000 }, env);
      return { data: { status: r.status, ms: r.ms, contentType: r.headers.get("content-type"), body: (typeof r.body === "string" ? r.body : JSON.stringify(r.body)).slice(0, 12000) } };
    },
  }),
];
