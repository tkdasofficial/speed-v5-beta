import { expect, test } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import { buildTree, cleanPath } from "./normalize";
import { unzipEntries } from "./zip";

test("rejects traversal and absolute paths", () => {
  for (const p of ["../a", "a/../b", "/etc/passwd", "C:/x", "a\\b", "./a", "a//b"]) expect(cleanPath(p)).toBeNull();
  expect(cleanPath("src/index.ts")).toBe("src/index.ts");
});

test("zip with traversal entry is skipped, relative paths preserved, root stripped", () => {
  const zip = zipSync({ "repo-main/src/a.ts": strToU8("x"), "repo-main/README.md": strToU8("# hi"), "repo-main/../evil.sh": strToU8("rm") });
  const t = buildTree(unzipEntries(zip), "zip");
  expect(t.files.map((f) => f.path)).toEqual(["README.md", "src/a.ts"]);
  expect(t.dirs).toEqual(["src"]);
  expect(t.skipped.some((s) => s.path.includes(".."))).toBe(true);
});

test("ignores node_modules/.git and classifies binary", () => {
  const t = buildTree([
    { path: "p/node_modules/x.js", bytes: strToU8("1") },
    { path: "p/.git/HEAD", bytes: strToU8("ref") },
    { path: "p/logo.png", bytes: new Uint8Array([137, 80, 0, 1]) },
    { path: "p/a.txt", bytes: strToU8("ok") },
  ], "directory");
  expect(t.files.map((f) => [f.path, f.kind])).toEqual([["a.txt", "text"], ["logo.png", "binary"]]);
});

test("corrupt zip throws a clear error", () => {
  expect(() => unzipEntries(new Uint8Array([1, 2, 3, 4]))).toThrow(/corrupt/);
});
