import type { Snapshot, SnapshotSummary } from "./snapshot";
import { summarize } from "./snapshot";
/** Minimal synchronous key/value backend (localStorage in browsers, memory elsewhere). */
export interface KeyValueBackend { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void }
export function memoryBackend(): KeyValueBackend {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); }, remove: (k) => { m.delete(k); } };
}
export function browserBackend(): KeyValueBackend {
  try {
    const ls = globalThis.localStorage;
    const probe = "__sbx_probe"; ls.setItem(probe, "1"); ls.removeItem(probe);
    return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v), remove: (k) => ls.removeItem(k) };
  } catch { return memoryBackend(); }
}
const PREFIX = "speed.sandbox";
/** Durable snapshot + state storage for one project. */
export class SandboxPersistence {
  constructor(private readonly kv: KeyValueBackend, private readonly projectId: string) {}
  private k(s: string): string { return `${PREFIX}.${this.projectId}.${s}`; }
  saveState(raw: string): void { this.kv.set(this.k("state"), raw); }
  loadState(): string | null { return this.kv.get(this.k("state")); }
  listSnapshots(): SnapshotSummary[] {
    try { const v = JSON.parse(this.kv.get(this.k("snapshots")) ?? "[]") as SnapshotSummary[]; return Array.isArray(v) ? v : []; } catch { return []; }
  }
  saveSnapshot(s: Snapshot): void {
    this.kv.set(this.k(`snap.${s.id}`), JSON.stringify(s));
    this.kv.set(this.k("snapshots"), JSON.stringify([summarize(s), ...this.listSnapshots().filter((x) => x.id !== s.id)]));
  }
  loadSnapshot(id: string): Snapshot | null {
    try { return JSON.parse(this.kv.get(this.k(`snap.${id}`)) ?? "null") as Snapshot | null; } catch { return null; }
  }
  deleteSnapshot(id: string): boolean {
    const list = this.listSnapshots();
    if (!list.some((s) => s.id === id)) return false;
    this.kv.remove(this.k(`snap.${id}`));
    this.kv.set(this.k("snapshots"), JSON.stringify(list.filter((s) => s.id !== id)));
    return true;
  }
  /** Copies all stored data to another project id (used by project duplicate). */
  copyTo(projectId: string): void {
    const other = new SandboxPersistence(this.kv, projectId);
    const st = this.loadState(); if (st) other.saveState(st);
    for (const s of this.listSnapshots().reverse()) { const full = this.loadSnapshot(s.id); if (full) other.saveSnapshot(full); }
  }
  clearAll(): void {
    for (const s of this.listSnapshots()) this.kv.remove(this.k(`snap.${s.id}`));
    this.kv.remove(this.k("snapshots")); this.kv.remove(this.k("state"));
  }
}
