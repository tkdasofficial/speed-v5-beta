import { SandboxError } from "../utils/errors";
/** Allocates preview/dev ports from a fixed range for sandbox processes. */
export class PortAllocator {
  private used = new Set<number>();
  constructor(private readonly min = 3000, private readonly max = 3999) {}
  allocate(preferred?: number): number {
    if (preferred !== undefined && preferred >= this.min && preferred <= this.max && !this.used.has(preferred)) { this.used.add(preferred); return preferred; }
    for (let p = this.min; p <= this.max; p++) if (!this.used.has(p)) { this.used.add(p); return p; }
    throw new SandboxError("INVALID_STATE", "No free ports");
  }
  release(port: number): void { this.used.delete(port); }
}
