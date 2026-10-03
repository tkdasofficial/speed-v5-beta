import { describe, expect, it } from "vitest";
import { validateViteExports } from "./validate";

const store = (files: Record<string, string>) => ({
  get: (p: string) => (p in files ? { path: p, content: files[p]!, encoding: "utf8" } : undefined),
  list: () => Object.entries(files).map(([path, content]) => ({ path, content, encoding: "utf8" })),
}) as never;

describe("validateViteExports", () => {
  it("flags a default import of a file with only named exports", () => {
    const r = validateViteExports(store({ "src/App.tsx": "import Header from './components/Header';", "src/components/Header.tsx": "export function Header() { return null }" }));
    expect(r).toHaveLength(1);
    expect(r[0]!.code).toBe("IMPORT_MISSING_EXPORT");
  });
  it("accepts a matching default export", () => {
    expect(validateViteExports(store({ "src/App.tsx": "import Header from './components/Header';", "src/components/Header.tsx": "export default function Header() { return null }" }))).toHaveLength(0);
  });
  it("flags a missing named export", () => {
    expect(validateViteExports(store({ "src/App.tsx": "import { Footer } from './Footer';", "src/Footer.tsx": "export default function Foot() {}" }))).toHaveLength(1);
  });
});
