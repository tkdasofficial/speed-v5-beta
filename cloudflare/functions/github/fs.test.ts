import { expect, test } from "bun:test";
import { decodeText, normalizeTree, safeRepoPath } from "./fs";

const b64 = (s: string | Uint8Array) => btoa(typeof s === "string" ? unescape(encodeURIComponent(s)) : String.fromCharCode(...s));

test("tree keeps files and folders, drops submodules, folders first", () => {
  const t = normalizeTree([
    { path: "src/a.ts", mode: "100644", type: "blob", sha: "1", size: 10 },
    { path: "src", mode: "040000", type: "tree", sha: "2" },
    { path: "vendor/lib", mode: "160000", type: "commit", sha: "3" },
  ]);
  expect(t).toEqual([
    { path: "src", name: "src", type: "dir", size: null, sha: "2" },
    { path: "src/a.ts", name: "a.ts", type: "file", size: 10, sha: "1" },
  ]);
});

test("paths cannot escape the repository", () => {
  for (const p of ["../x", "a/../../b", "a/./b", "a\\b", "a\0b", "", "/", "a//b"]) expect(safeRepoPath(p)).toBeNull();
  expect(safeRepoPath("/src/my file.ts")).toBe("src/my%20file.ts");
});

test("text decodes; binary and invalid UTF-8 are refused", () => {
  expect(decodeText("a.ts", b64("const x = 'é';"))).toBe("const x = 'é';");
  expect(decodeText("logo.png", b64("hi"))).toBeNull();
  expect(decodeText("data", b64(new Uint8Array([1, 0, 2])))).toBeNull();
  expect(decodeText("data", b64(new Uint8Array([0xff, 0xfe, 0xfd])))).toBeNull();
});
