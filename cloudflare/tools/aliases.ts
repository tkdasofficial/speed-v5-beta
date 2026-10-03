// Canonical 200-tool names that are served by an existing implementation (audited; see tool-audit-200.md).
// Each alias resolves to exactly one real tool, optionally with fixed arguments, so no capability is duplicated.
import { registerAlias, type AliasSpec } from "./registry";

export const CANONICAL_ALIASES: Record<string, AliasSpec> = {
  // Execution / dependencies
  uninstall_dependencies: { target: "remove_dependency" },
  check_dependency_updates: { target: "check_outdated_dependencies" },
  fix_dependency_error: { target: "fix_missing_dependencies" },
  validate_dependencies: { target: "audit_dependencies" },
  // Verification / build / preview / runtime
  check_build: { target: "run_build" },
  get_last_build: { target: "get_build_state" },
  get_runtime_logs: { target: "get_build_logs", preset: { includeRuntime: true } },
  start_preview: { target: "open_preview" },
  get_preview_url: { target: "open_preview", note: "Returns a fresh signed preview URL." },
  get_preview_status: { target: "get_build_status" },
  get_runtime_status: { target: "get_command_result", note: "Without jobId reports the latest dev server / command process." },
  // Git
  git_history: { target: "git_log" },
  git_branch: { target: "git_list_branches" },
  git_commit: { target: "git_commit_and_push", note: "Commits are created directly on the remote branch (no local clone), so commit and push are one step." },
  git_push: { target: "git_commit_and_push", note: "There is no local clone: pushing means committing the project's changes to the remote branch." },
  git_revert: { target: "git_revert_file", note: "Pass commit to revert a whole commit, or path to restore one file." },
  // Environment
  get_environment_variables: { target: "list_env_vars" },
  set_environment_variable: { target: "set_env_var" },
  remove_environment_variable: { target: "delete_env_var" },
  validate_environment: { target: "check_env_requirements" },
  // Code
  format_project: { target: "run_formatter" },
  replace_code: { target: "replace_in_files" },
  generate_file: { target: "create_file" },
  generate_route: { target: "generate_page" },
  get_file_context: { target: "analyze_code" },
  // Integrations
  get_integration_status: { target: "list_integrations" },
  // Planning
  update_plan: { target: "update_plan_step" },
  mark_task_complete: { target: "update_plan_step", preset: { status: "done" } },
  mark_task_failed: { target: "update_plan_step", preset: { status: "failed" } },
  get_task_status: { target: "get_task_progress" },
  // Cleanup
  clean_build_artifacts: { target: "cleanup_workspace", preset: { scope: "build" } },
  clean_cache: { target: "cleanup_workspace", preset: { scope: "cache" } },
  clean_dependencies: { target: "cleanup_workspace", preset: { scope: "dependencies" } },
  clean_temp_files: { target: "cleanup_workspace", preset: { scope: "temp" } },
  // Security / validation
  scan_sensitive_files: { target: "scan_secrets" },
  validate_project: { target: "verify_project" },
  // Assets
  read_asset: { target: "get_asset_info", preset: { includeContent: true } },
  create_asset: { target: "upload_asset" },
  optimize_assets: { target: "optimize_svg" },
  // Logs / context / orchestration
  get_logs: { target: "get_operation_logs" },
  get_previous_results: { target: "get_operation_logs", preset: { includeResults: true } },
  update_project_context: { target: "record_knowledge", preset: { kind: "context" } },
  record_decision: { target: "record_knowledge", preset: { kind: "decision" } },
  record_learning: { target: "record_knowledge", preset: { kind: "learning" } },
  check_operation_status: { target: "get_operation_status" },
  retry_failed_operation: { target: "retry_operation" },
};

export function registerCanonicalAliases() {
  for (const [name, spec] of Object.entries(CANONICAL_ALIASES)) registerAlias(name, spec);
}
