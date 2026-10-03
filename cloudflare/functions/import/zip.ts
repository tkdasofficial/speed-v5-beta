// Safe ZIP extraction shared by the browser (local uploads) and the Worker (provider archives).
import { unzipSync } from "fflate";
import { LIMITS } from "./normalize";

export class ImportError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Extracts file entries (directories dropped). Paths are validated later by buildTree. */
export function unzipEntries(bytes: Uint8Array): { path: string; bytes: Uint8Array }[] {
  if (bytes.length > LIMITS.maxArchiveBytes) throw new ImportError(413, `Archive is larger than ${LIMITS.maxArchiveBytes / 1024 / 1024} MB`);
  let out: Record<string, Uint8Array>;
  let total = 0;
  try {
    out = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith("/")) return false;
        total += f.originalSize;
        if (total > LIMITS.maxArchiveBytes * 4) throw new ImportError(413, "Archive expands to more than 200 MB");
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(400, "This ZIP file is corrupt or unreadable");
  }
  const entries = Object.entries(out).map(([path, b]) => ({ path, bytes: b }));
  if (!entries.length) throw new ImportError(400, "This archive contains no files");
  return entries;
}
