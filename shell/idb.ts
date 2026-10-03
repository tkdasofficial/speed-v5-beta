// Minimal IndexedDB key/value store for per-user cache snapshots (not authoritative).
const DB = "speed-shell";
const STORE = "kv";
let dbp: Promise<IDBDatabase> | null = null;

function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then((db) => new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
  }));
}

export const idbGet = <T>(k: string) => tx<T>("readonly", (s) => s.get(k) as IDBRequest<T>).catch(() => undefined);
export const idbSet = (k: string, v: unknown) => tx("readwrite", (s) => { s.put(v, k); }).catch(() => undefined);
export const idbClear = () => tx("readwrite", (s) => { s.clear(); }).catch(() => undefined);
