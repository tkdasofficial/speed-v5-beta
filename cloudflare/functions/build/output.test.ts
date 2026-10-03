import { describe, expect, it } from "vitest";
import { prepareArtifact, relativize, isStaticProject, toB64, ArtifactError } from "../../../.output.build";

const f = (path: string, text: string) => ({ path, content: toB64(text) });
const text = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));

describe(".output.build", () => {
  it("rewrites root-relative paths relative to the file's folder", () => {
    expect(relativize("/assets/app.js", "index.html")).toBe("./assets/app.js");
    expect(relativize("/assets/app.js", "docs/a/page.html")).toBe("../../assets/app.js");
    expect(relativize("//cdn.x/y.js", "index.html")).toBe("//cdn.x/y.js");
  });
  it("keeps every file separate (no single inlined HTML)", () => {
    const a = prepareArtifact([f("index.html", '<link href="/style.css"><script src="./app.js"></script>'), f("style.css", "a{background:url(/img/x.png)}"), f("app.js", "1"), f("img/x.png", "p")]);
    expect(a.fileCount).toBe(4);
    expect(text(a.files.find((x) => x.path === "index.html")!.content)).toContain('href="./style.css"');
    expect(text(a.files.find((x) => x.path === "style.css")!.content)).toContain("url(./img/x.png)");
  });
  it("rejects output without index.html or with unsafe paths", () => {
    expect(() => prepareArtifact([f("app.js", "1")])).toThrow(ArtifactError);
    expect(() => prepareArtifact([f("index.html", ""), f("../x.js", "")])).toThrow(ArtifactError);
  });
  it("routes plain HTML projects to the static flow", () => {
    expect(isStaticProject(["index.html", "style.css"])).toBe(true);
    expect(isStaticProject(["index.html", "package.json"])).toBe(false);
  });
});
