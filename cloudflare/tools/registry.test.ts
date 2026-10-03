import { test, expect } from "vitest";
import { loadTools } from "./index";
import { toolsForPhase, catalogText } from "./exposure";
import { COMMAND_MAP, resolveCommand } from "./policy";
test("registry", () => {
  const all = loadTools();
  console.log("TOOLS", all.length);
  const names = new Set(all.map((t) => t.name));
  const missing = [...new Set(Object.values(COMMAND_MAP).map((m) => m.tool))].filter((n) => !names.has(n));
  expect(missing).toEqual([]);
  for (const t of ["apply_patch","scan_secrets","verify_project","run_typecheck","wait_for_command","git_status","add_dependency","remove_dependency","run_script"]) expect(names.has(t), t).toBe(true);
  expect(toolsForPhase("planning", true).every((t) => t.readOnly)).toBe(true);
  console.log("PLAN", toolsForPhase("planning", true).length, "BUILD", toolsForPhase("building").length, "VAL", toolsForPhase("validating").length, "chars", catalogText("building").length);
  expect(resolveCommand("npm run lint").tool).toBe("run_linter");
  expect(() => resolveCommand("rm -rf /")).toThrow();
});
