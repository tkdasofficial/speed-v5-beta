import type { FileMeta, FileStore, TreeNode } from "../types/filesystem";
import { languageFor } from "../editor/buffer";
/** Builds a sorted folder/file tree (folders first) from the store, including empty folders. */
export function buildTree(store: FileStore): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "folder", children: [] };
  const insert = (path: string, isFile: boolean) => {
    let cur = root;
    const segs = path.split("/");
    segs.forEach((name, i) => {
      const p = segs.slice(0, i + 1).join("/");
      const file = isFile && i === segs.length - 1;
      const kids = (cur.children ??= []);
      let next = kids.find((k) => k.name === name);
      if (!next) { next = file ? { name, path: p, type: "file" } : { name, path: p, type: "folder", children: [] }; kids.push(next); }
      cur = next;
    });
  };
  for (const d of store.folders()) insert(d, false);
  for (const f of store.list()) insert(f.path, true);
  const sort = (n: TreeNode[]): TreeNode[] =>
    n.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1))
      .map((x) => (x.children ? { ...x, children: sort(x.children) } : x));
  return sort(root.children ?? []);
}
export function fileMeta(store: FileStore, path: string): FileMeta | undefined {
  const f = store.get(path);
  if (!f) return undefined;
  return { path: f.path, size: f.content.length, encoding: f.encoding, updatedAt: f.updatedAt, createdAt: f.createdAt ?? f.updatedAt, language: languageFor(f.path) };
}
