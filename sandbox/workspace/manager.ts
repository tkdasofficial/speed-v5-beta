import type { SandboxContext } from "../core/context";
import { Sandbox } from "../core/sandbox";
/** Keeps one sandbox per project in this process. */
export class WorkspaceManager {
  private sandboxes = new Map<string, Sandbox>();
  get(projectId: string): Sandbox | undefined { return this.sandboxes.get(projectId); }
  open(ctx: SandboxContext): Sandbox {
    const existing = this.sandboxes.get(ctx.projectId);
    if (existing && existing.state.phase !== "disposed") return existing;
    const s = new Sandbox(ctx); s.start();
    this.sandboxes.set(ctx.projectId, s);
    return s;
  }
  close(projectId: string): void { this.sandboxes.get(projectId)?.dispose(); this.sandboxes.delete(projectId); }
}
