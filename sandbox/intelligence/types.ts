// Shared types for the internal codebase-intelligence tool layer (agent-only, never user-facing).
export type ErrorCategory =
  | "syntax_error" | "type_error" | "missing_file" | "missing_module" | "broken_import" | "broken_reference"
  | "missing_asset" | "invalid_path" | "html_error" | "css_error" | "javascript_error" | "typescript_error"
  | "dependency_error" | "build_configuration_error" | "runtime_error" | "unknown_error";

export interface Diagnostic {
  type: ErrorCategory;
  severity: "error" | "warning";
  file: string;
  line: number;
  column: number;
  message: string;
  code: string;
  related?: string[];
  context?: string;
  cause?: string;
}

export type ToolResult<T = unknown> = { success: true; data: T } | { success: false; error: { type: string; message: string; path?: string } };
export const ok = <T>(data: T): ToolResult<T> => ({ success: true, data });
export const fail = (type: string, message: string, path?: string): ToolResult<never> => ({ success: false, error: { type, message, ...(path ? { path } : {}) } });

/** Line/column (1-based) of a character offset. */
export function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1, last = -1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) { line++; last = i; }
  return { line, column: offset - last };
}
