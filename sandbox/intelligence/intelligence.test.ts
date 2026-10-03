import { describe, expect, it } from "vitest";
import { Sandbox } from "../core/sandbox";
import { createContext } from "../core/context";
import { memoryBackend } from "../storage/persistence";
import { AgentTools } from "./tools";
import type { BuildOutcome } from "./tools";

function setup() {
  const sb = new Sandbox(createContext("p1", "u1"), memoryBackend());
  sb.start();
  const runtime: string[] = [];
  const tools = new AgentTools({
    local: sb.workspace.files, output: sb.output, folders: () => sb.workspace.files.folders(),
    write: (p, c) => { sb.write(p, c); }, create: (p, c) => { sb.createFile(p, c); }, remove: (p) => { sb.remove(p); }, move: (f, t) => { sb.move(f, t); },
    build: () => { const r = sb.generateOutput(); return r.ok ? { ok: true, outputId: r.record.id, files: r.record.files.length, warnings: r.warnings ?? [] } : { ok: false, errors: r.diagnostics ?? [], warnings: r.warnings ?? [] }; },
    lastOutput: () => (sb.lastOutput ? { id: sb.lastOutput.id, createdAt: sb.lastOutput.createdAt, files: sb.lastOutput.files.length } : null),
    outputStale: () => sb.outputStale(), previewErrors: () => runtime, clearPreviewErrors: () => { runtime.length = 0; },
  });
  sb.createFile("index.html", `<!DOCTYPE html>\n<html><head><link rel="stylesheet" href="css/style.css"></head>\n<body>\n<section class="hero">\n<h1>Hello</h1>\n<button class="hero-cta" id="cta">Start</button>\n</section>\n<img src="img/logo.svg" alt="">\n<script type="module" src="js/app.js"></script>\n</body></html>`);
  sb.createFile("css/style.css", `body { margin: 0; }\n.hero-cta { background: blue; color: white; }\n`);
  sb.createFile("img/logo.svg", `<svg xmlns="http://www.w3.org/2000/svg"/>`);
  sb.createFile("js/app.js", `import { greet } from "./util.js";\ndocument.getElementById("cta").addEventListener("click", () => greet());\n`);
  sb.createFile("js/util.js", `export function greet() { alert("hi"); }\n`);
  const run = <T = unknown>(n: string, a: Record<string, unknown> = {}) => { const r = tools.run(n, a); if (!r.success) throw new Error(`${n}: ${r.error.message}`); return r.data as T; };
  const build = () => run<BuildOutcome>("build_project");
  return { sb, tools, run, build, runtime };
}
const out = (sb: Sandbox, p: string) => sb.output.get(p)?.content;

describe("codebase intelligence tools", () => {
  it("1: HTML-only change", () => {
    const { sb, run, build } = setup(); expect(build().ok).toBe(true);
    run("edit_file", { path: "index.html", find: "<h1>Hello</h1>", replace: "<h1>Welcome</h1>" });
    expect(build().ok).toBe(true);
    expect(out(sb, "index.html")).toContain("Welcome");
    expect(run<{ modified: string[] }>("get_changed_files").modified).toEqual(["index.html"]);
  });
  it("2: CSS change found through the HTML element", () => {
    const { sb, run, build } = setup();
    const el = run<{ text: string }[]>("find_html_elements", { selector: "button.hero-cta" });
    expect(el[0]!.text).toContain("hero-cta");
    const rules = run<{ file: string; line: number }[]>("find_css_selectors", { selector: ".hero-cta" });
    expect(rules[0]).toMatchObject({ file: "css/style.css", line: 2 });
    run("edit_file", { path: "css/style.css", find: "background: blue", replace: "background: red" });
    expect(build().ok).toBe(true);
    expect(out(sb, "css/style.css")).toContain("red");
    expect(out(sb, "index.html")).toBe(sb.workspace.files.get("index.html")!.content);
  });
  it("3: JS behaviour change preserves HTML/CSS", () => {
    const { sb, run, build } = setup();
    const before = { h: sb.workspace.files.get("index.html")!.content, c: sb.workspace.files.get("css/style.css")!.content };
    expect(run<{ file: string }[]>("find_js_symbols", { name: "greet" })[0]!.file).toBe("js/util.js");
    run("edit_file", { path: "js/util.js", find: 'alert("hi")', replace: 'console.log("hi")' });
    expect(build().ok).toBe(true);
    expect(sb.workspace.files.get("index.html")!.content).toBe(before.h);
    expect(sb.workspace.files.get("css/style.css")!.content).toBe(before.c);
  });
  it("4: multi-file change", () => {
    const { sb, run, build } = setup();
    run("patch_file", { path: "index.html", edits: [{ find: "</section>", replace: '<p class="tag">New</p>\n</section>' }] });
    run("edit_file", { path: "css/style.css", find: "body { margin: 0; }", replace: "body { margin: 0; }\n.tag { color: gray; }" });
    expect(build().ok).toBe(true);
    expect(run<{ modified: string[] }>("get_changed_files").modified.sort()).toEqual(["css/style.css", "index.html"]);
  });
  it("5: syntax error → detect → repair → build", () => {
    const { run, build } = setup();
    const e = run<{ diagnostics: { code: string; line: number }[] }>("edit_file", { path: "js/util.js", find: 'alert("hi"); }', replace: 'alert("hi"; }' });
    expect(e.diagnostics[0]!.code).toBe("JS_SYNTAX_ERROR");
    const b = build(); expect(b.ok).toBe(false);
    if (!b.ok) { expect(b.errors[0]).toMatchObject({ type: "syntax_error", file: "js/util.js", line: 1 }); expect(b.errors[0]!.context).toContain("alert"); }
    run("edit_file", { path: "js/util.js", find: 'alert("hi"; }', replace: 'alert("hi"); }' });
    expect(build().ok).toBe(true);
  });
  it("6: missing asset → detect → repair", () => {
    const { run, build } = setup();
    run("edit_file", { path: "index.html", find: "img/logo.svg", replace: "img/brand.svg" });
    const b = build(); expect(b.ok).toBe(false);
    if (!b.ok) expect(b.errors.some((x) => x.type === "missing_asset" && x.related?.includes("img/brand.svg"))).toBe(true);
    run("move_file", { path: "img/logo.svg", to: "img/brand.svg" });
    expect(build().ok).toBe(true);
  });
  it("7: broken import → detect → repair", () => {
    const { run, build } = setup();
    run("edit_file", { path: "js/app.js", find: "./util.js", replace: "./utils.js" });
    const b = build(); expect(b.ok).toBe(false);
    if (!b.ok) expect(b.errors[0]).toMatchObject({ type: "broken_import", file: "js/app.js" });
    run("rollback_change");
    expect(build().ok).toBe(true);
  });
  it("8: failed build keeps the existing .output", () => {
    const { sb, run, build } = setup(); expect(build().ok).toBe(true);
    const id = sb.lastOutput!.id, snapshot = out(sb, "css/style.css");
    run("edit_file", { path: "css/style.css", find: "color: white; }", replace: "color: white;" });
    expect(build().ok).toBe(false);
    expect(sb.lastOutput!.id).toBe(id);
    expect(out(sb, "css/style.css")).toBe(snapshot);
  });
  it("9: successful build updates .output", () => {
    const { sb, run, build } = setup(); expect(build().ok).toBe(true);
    const id = sb.lastOutput!.id;
    run("create_file", { path: "about.html", content: "<!DOCTYPE html><html><body><a href=\"index.html\">Home</a></body></html>" });
    expect(build().ok).toBe(true);
    expect(sb.lastOutput!.id).not.toBe(id);
    expect(out(sb, "about.html")).toContain("Home");
    expect(run<{ ok: boolean }>("check_preview").ok).toBe(true);
  });
  it("10: unknown location is found by searching, and boundaries hold", () => {
    const { run, tools } = setup();
    const hits = run<{ file: string; line: number }[]>("search_text", { query: "Start" });
    expect(hits.find((h) => h.file === "index.html")?.line).toBe(6);
    expect(run<string[]>("search_filename", { query: "util" })).toContain("js/util.js");
    expect(tools.run("edit_file", { path: ".output/index.html", find: "a", replace: "b" })).toMatchObject({ success: false, error: { type: "invalid_arguments" } });
    expect(tools.run("read_file", { path: "../secret" })).toMatchObject({ success: false, error: { type: "invalid_path" } });
    expect(tools.run("delete_file", { path: "css/style.css" })).toMatchObject({ success: false, error: { type: "has_references" } });
    expect(tools.run("read_file", { path: "nope.js" })).toMatchObject({ success: false, error: { type: "file_not_found" } });
  });
});
