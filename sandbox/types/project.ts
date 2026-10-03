export type PackageManagerName = "bun" | "npm" | "pnpm" | "yarn";
export interface ProjectConfig { name: string; framework?: string; packageManager: PackageManagerName; buildCommand?: string; outputDir: ".output" }
export interface ProjectManifest { name: string; version: string; dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> }
