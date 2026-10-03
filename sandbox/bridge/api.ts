import { SandboxError } from "../utils/errors";
import { readFile } from "../filesystem/read";
import { writeFile } from "../filesystem/write";
import { deletePath } from "../filesystem/delete";
import { movePath } from "../filesystem/move";
import { buildTree } from "../filesystem/tree";
import type { Workspace } from "../workspace/workspace";
import type { Terminal } from "../terminal/terminal";
import type { SandboxRequest, SandboxResponse } from "./messages";
/** Dispatches typed requests from the application to the engine. */
export function handleRequest(ws: Workspace, terminal: Terminal, req: SandboxRequest): SandboxResponse {
  try {
    switch (req.type) {
      case "fs.read": return { ok: true, data: readFile(ws.files, req.path) };
      case "fs.write": { const c = writeFile(ws.files, req.path, req.content); ws.watcher.emit([c]); return { ok: true, data: c }; }
      case "fs.delete": { const c = deletePath(ws.files, req.path); ws.watcher.emit(c); return { ok: true, data: c }; }
      case "fs.move": { const c = movePath(ws.files, req.from, req.to); ws.watcher.emit(c); return { ok: true, data: c }; }
      case "fs.tree": return { ok: true, data: buildTree(ws.files) };
      case "terminal.run": return { ok: true, data: { id: terminal.run(req.command).id } };
    }
  } catch (e) {
    if (e instanceof SandboxError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "INTERNAL", message: e instanceof Error ? e.message : "Unknown error" };
  }
}
