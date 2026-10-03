import { NotImplementedError } from "../utils/errors";
/** Pseudo-terminal contract. A real backend arrives with the execution phase. */
export interface Pty { write(data: string): void; resize(cols: number, rows: number): void; onData(fn: (d: string) => void): () => void; close(): void }
export interface PtyFactory { open(cols: number, rows: number): Pty }
export const unavailablePty: PtyFactory = { open() { throw new NotImplementedError("Terminal (PTY)"); } };
