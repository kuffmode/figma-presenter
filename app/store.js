// Offline cache in IndexedDB: deck descriptions, shader sources and asset blobs.
const DB = "figma-presenter", VERSION = 1;
let dbp;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => { req.result.createObjectStore("kv"); req.result.createObjectStore("blobs"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode), req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = t.onabort = () => reject(t.error);
  });
}
export const get = (store, key) => tx(store, "readonly", s => s.get(key));
export const set = (store, key, value) => tx(store, "readwrite", s => s.put(value, key));
export const del = (store, key) => tx(store, "readwrite", s => s.delete(key));
export const keys = store => tx(store, "readonly", s => s.getAllKeys());
