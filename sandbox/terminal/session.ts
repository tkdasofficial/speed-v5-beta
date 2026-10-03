import { uid } from "../core/context";
import type { TerminalSessionInfo } from "../types/terminal";
import type { TerminalOutput } from "../types/terminal";
/** Terminal session state: dimensions and bounded scrollback. */
export class TerminalSession {
  readonly info: TerminalSessionInfo;
  private scrollback: TerminalOutput[] = [];
  constructor(cols = 80, rows = 24, private readonly limit = 5000) { this.info = { id: uid("term"), cols, rows, createdAt: Date.now() }; }
  append(o: TerminalOutput): void { this.scrollback.push(o); if (this.scrollback.length > this.limit) this.scrollback.shift(); }
  history(): readonly TerminalOutput[] { return this.scrollback; }
}
