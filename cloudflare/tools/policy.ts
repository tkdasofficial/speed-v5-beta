// Tool Policy / Permission Engine (spec §6, §15, §16). Pure functions so they are unit-testable.
import type { Permission, ToolDefinition } from "./types";
import { ToolFailure } from "./types";

export const ALL_PERMISSIONS: Permission[] = [
  "project:read", "project:write", "project:delete", "build:run", "preview:manage", "git:read", "git:write", "network:fetch",
  "integration:read", "integration:write", "database:read", "database:write", "env:read", "env:write", "task:manage", "logs:read", "logs:write", "orchestrate",
];
const READ_ONLY_PERMISSIONS: Permission[] = ["project:read", "git:read", "network:fetch", "integration:read", "database:read", "env:read", "logs:read", "orchestrate"];

/** Project owners get everything; read-only (plan) sessions get only read permissions. */
export function grantedPermissions(readOnly: boolean): Set<Permission> {
  return new Set(readOnly ? READ_ONLY_PERMISSIONS : ALL_PERMISSIONS);
}

export interface PolicyInput { tool: ToolDefinition; args: Record<string, unknown>; projectId: string; readOnly: boolean; confirmed: boolean; granted: Set<Permission> }

/** Throws a machine-readable ToolFailure when the call is not allowed. */
export function checkPolicy(p: PolicyInput) {
  const { tool, args } = p;
  if (p.readOnly && !tool.readOnly) throw new ToolFailure("PERMISSION_DENIED", `${tool.name} changes the project and is not allowed in plan/read-only mode`);
  const missing = tool.requiredPermissions.filter((x) => !p.granted.has(x));
  if (missing.length) throw new ToolFailure("PERMISSION_DENIED", `${tool.name} needs ${missing.join(", ")}`);
  // Cross-project access is impossible: the session's project is the only scope; any other project id in args is rejected.
  for (const k of ["projectId", "project_id", "workspaceId"]) {
    const v = args[k];
    if (v !== undefined && v !== p.projectId) throw new ToolFailure("SECURITY_BLOCKED", "Tools can only operate on the current project");
  }
  const needsConfirm = (tool.destructive && tool.requiresConfirmation) || !!tool.requiresConfirmationFor?.(args);
  if (needsConfirm && !p.confirmed && args["confirm"] !== true) {
    throw new ToolFailure("CONFIRMATION_REQUIRED", `${tool.name} is destructive — repeat the call with "confirm": true once the user agreed`, false, undefined, tool.name);
  }
}

// ---- file safety ----
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|.*\.pem|.*\.key|credentials\.json|service-account.*\.json)$/i;
const PROTECTED_DIR = /^(\.git|node_modules|\.output)(\/|$)/;

/** Normalizes a project-relative path; rejects traversal, absolute paths, generated output and secret files. */
export function safeToolPath(raw: unknown, opts: { allowEmpty?: boolean; allowSecrets?: boolean; allowGenerated?: boolean } = {}): string {
  if (typeof raw !== "string") { if (opts.allowEmpty) return ""; throw new ToolFailure("INVALID_ARGUMENT", "path is required"); }
  const s = raw.replace(/\\/g, "/").replace(/^\.local\/?/, "").replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s) { if (opts.allowEmpty) return ""; throw new ToolFailure("INVALID_ARGUMENT", "path is required"); }
  if (s.includes("\0") || /^[a-z]:/i.test(s)) throw new ToolFailure("SECURITY_BLOCKED", "Invalid path");
  const parts: string[] = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") throw new ToolFailure("SECURITY_BLOCKED", "Path traversal is not allowed");
    parts.push(seg);
  }
  const p = parts.join("/");
  if (!opts.allowGenerated && PROTECTED_DIR.test(p)) throw new ToolFailure("SECURITY_BLOCKED", `${p} is protected`);
  if (!opts.allowSecrets && SECRET_FILE.test(p)) throw new ToolFailure("SECURITY_BLOCKED", `${p} may contain secrets and is protected`);
  if (p.length > 400) throw new ToolFailure("INVALID_ARGUMENT", "Path too long");
  return p;
}
export const isSecretPath = (p: string) => SECRET_FILE.test(p);

// ---- secret scanning (shared by scan_secrets and log redaction) ----
export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: "GitHub fine-grained token", re: /github_pat_[A-Za-z0-9_]{50,}/g },
  { name: "OpenAI key", re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "Stripe secret key", re: /sk_(live|test)_[0-9a-zA-Z]{20,}/g },
  { name: "Slack token", re: /xox[baprs]-[0-9A-Za-z-]{10,}/g },
  { name: "Private key", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "Supabase service key", re: /sb_secret_[A-Za-z0-9_-]{20,}/g },
  { name: "JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];
export function redact(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p.re, "[REDACTED]");
  return out;
}

// ---- command safety ----
/** Commands are never run in a shell. Only these are understood, each mapped to a real backend operation. */
export const COMMAND_MAP: Record<string, { tool: string; args?: Record<string, unknown> }> = {
  "npm run build": { tool: "run_build" }, "bun run build": { tool: "run_build" }, "vite build": { tool: "run_build" }, "yarn build": { tool: "run_build" }, "pnpm build": { tool: "run_build" },
  "tsc": { tool: "run_typecheck" }, "tsc --noemit": { tool: "run_typecheck" }, "npx tsc --noemit": { tool: "run_typecheck" },
  "npm run lint": { tool: "run_linter" }, "eslint .": { tool: "run_linter" },
  "npm install": { tool: "install_dependencies" }, "npm i": { tool: "install_dependencies" }, "bun install": { tool: "install_dependencies" },
  "npm test": { tool: "run_tests" }, "npm run test": { tool: "run_tests" },
  "npm run dev": { tool: "run_dev_server" }, "git status": { tool: "git_status" }, "git diff": { tool: "git_diff" }, "git log": { tool: "git_log" },
};
const DANGEROUS = /(rm\s+-rf|sudo|curl\s|wget\s|\|\s*sh|>\s*\/|mkfs|dd\s+if=|chmod\s+777|:\(\)\{|shutdown|reboot|env\b|printenv|cat\s+.*\.env)/i;
export function resolveCommand(cmd: string): { tool: string; args?: Record<string, unknown> } {
  const c = cmd.trim().replace(/\s+/g, " ").toLowerCase();
  if (DANGEROUS.test(c) || /[;&|`$<>]/.test(c)) throw new ToolFailure("SECURITY_BLOCKED", "This command is not allowed");
  const add = /^(?:npm (?:install|i|add)|bun add|yarn add|pnpm add) (?:-d |--save-dev )?([@a-z0-9/._-]+(?:@[\w.^~-]+)?)$/.exec(c);
  if (add) return { tool: "add_dependency", args: { name: add[1]!.replace(/(.)@[^/]*$/, "$1"), dev: /(^| )(-d|--save-dev) /.test(c) } };
  const rm = /^(?:npm (?:uninstall|remove|rm)|bun remove|yarn remove|pnpm remove) ([@a-z0-9/._-]+)$/.exec(c);
  if (rm) return { tool: "remove_dependency", args: { name: rm[1] } };
  const script = /^(?:npm run|bun run|yarn|pnpm) ([a-z0-9:_-]+)$/.exec(c);
  const m = COMMAND_MAP[c];
  if (m) return m;
  if (script) return { tool: "run_script", args: { script: script[1] } };
  throw new ToolFailure("SECURITY_BLOCKED", `Unsupported command "${cmd.slice(0, 80)}". Supported: ${Object.keys(COMMAND_MAP).slice(0, 12).join(", ")}, npm install <pkg>`);
}

/** Executable command line: argv only (never a shell), allowlisted programs, workspace-relative arguments. */
export interface ParsedCommand { program: "npm" | "npx" | "node"; args: string[]; display: string }
const LOCAL_BINS = new Set(["tsc", "vite", "eslint", "prettier", "vitest", "jest", "tailwindcss", "postcss", "next", "astro", "svelte-check", "vue-tsc", "playwright"]);
const NPM_SUBCOMMANDS = new Set(["install", "i", "ci", "run", "run-script", "test", "t", "ls", "list", "outdated", "view", "info", "explain", "why", "audit", "pack", "exec"]);
const DENIED_FLAGS = /^(-g|--global|--prefix|--userconfig|--globalconfig|--cache|--registry|--unsafe-perm|--script-shell|--node-options|-r|--require|--import|--loader|--experimental-loader|-e|--eval|-p|--print|--inspect.*)(=|$)/;
const ARG = /^[\w@%+=:,./^~-]+$/;
export function tokenize(cmd: string): string[] {
  const out: string[] = []; let cur = ""; let q: string | null = null; let any = false;
  for (const ch of cmd.trim()) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ""; any = false; continue; }
    cur += ch;
  }
  if (q) throw new ToolFailure("INVALID_ARGUMENT", "Unclosed quote in command");
  if (cur || any) out.push(cur);
  return out;
}
export function parseCommand(cmd: string): ParsedCommand {
  if (/[;&|`$<>\n\r\\*?(){}]/.test(cmd)) throw new ToolFailure("SECURITY_BLOCKED", "Shell syntax (pipes, redirects, substitution, globs, chaining) is not allowed; run one command at a time");
  const argv = tokenize(cmd);
  if (!argv.length) throw new ToolFailure("INVALID_ARGUMENT", "Empty command");
  if (argv.length > 24) throw new ToolFailure("INVALID_ARGUMENT", "Too many arguments");
  let [prog, ...args] = argv as [string, ...string[]];
  if (LOCAL_BINS.has(prog)) { args = [prog, ...args]; prog = "npx"; }
  for (const a of args) {
    if (!ARG.test(a) || a.length > 200) throw new ToolFailure("SECURITY_BLOCKED", `Argument "${a.slice(0, 40)}" contains characters that are not allowed`);
    if (a.startsWith("/") || a.startsWith("~") || a.split(/[=/]/).includes("..")) throw new ToolFailure("SECURITY_BLOCKED", "Arguments must stay inside the project workspace (no absolute paths or ..)");
    if (DENIED_FLAGS.test(a)) throw new ToolFailure("SECURITY_BLOCKED", `Flag ${a.split("=")[0]} is not allowed`);
    if (/(^|\/)\.env(\.|$)|\.pem$|id_rsa/i.test(a)) throw new ToolFailure("SECURITY_BLOCKED", "Commands may not read secret files");
  }
  if (prog === "npm") {
    const sub = args[0];
    if (!sub || !NPM_SUBCOMMANDS.has(sub)) throw new ToolFailure("SECURITY_BLOCKED", `npm ${sub ?? ""} is not allowed. Allowed: ${[...NPM_SUBCOMMANDS].join(", ")}`);
    if (sub === "exec" && !LOCAL_BINS.has(args[1] ?? "")) throw new ToolFailure("SECURITY_BLOCKED", "npm exec only runs the project's own tools");
  } else if (prog === "npx") {
    const bin = args.find((a) => !a.startsWith("-"));
    if (!bin || !LOCAL_BINS.has(bin)) throw new ToolFailure("SECURITY_BLOCKED", `npx only runs installed project tools (${[...LOCAL_BINS].join(", ")})`);
    args = ["--no-install", ...args.filter((a) => a !== "--no-install" && a !== "-y" && a !== "--yes")];
  } else if (prog === "node") {
    const file = args[0];
    if (!file || !/^[\w./-]+\.(m?js|cjs)$/.test(file)) throw new ToolFailure("SECURITY_BLOCKED", "node can only run a project .js/.mjs/.cjs file");
  } else throw new ToolFailure("SECURITY_BLOCKED", `"${prog}" is not an allowed program. Allowed: npm, npx <project tool>, node <project file>, ${[...LOCAL_BINS].slice(0, 6).join(", ")}`);
  return { program: prog as ParsedCommand["program"], args, display: [prog, ...args].join(" ") };
}


// ---- network safety (SSRF) ----
export function safeExternalUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ToolFailure("INVALID_ARGUMENT", "Invalid URL"); }
  if (u.protocol !== "https:") throw new ToolFailure("SECURITY_BLOCKED", "Only https URLs are allowed");
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".internal") || h.endsWith(".local") || /^(\d+\.){3}\d+$/.test(h) || h.includes(":") || h === "metadata.google.internal") throw new ToolFailure("SECURITY_BLOCKED", "Private or IP-address hosts are not allowed");
  return u;
}
