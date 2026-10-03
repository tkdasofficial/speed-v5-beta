import { describe, it, expect } from "vitest";
import { hashFiles, safeRelPath } from "./hash";

describe("build hashing", () => {
  it("is independent of file order", async () => {
    const a = [{ path: "a.ts", content: "1" }, { path: "b/c.ts", content: "2" }];
    expect(await hashFiles(a)).toBe(await hashFiles([...a].reverse()));
  });
  it("changes when content changes", async () => {
    expect(await hashFiles([{ path: "a", content: "1" }])).not.toBe(await hashFiles([{ path: "a", content: "2" }]));
  });
  it("rejects unsafe paths", () => {
    for (const p of ["../x", "a/../../b", "/etc/passwd", "C:/x", "a\\b", "./a", ""]) expect(safeRelPath(p)).toBe(false);
    expect(safeRelPath("src/App.tsx")).toBe(true);
  });
});
