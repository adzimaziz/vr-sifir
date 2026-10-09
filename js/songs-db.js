// Songs the player adds from the headset's storage, kept in IndexedDB so
// they stay available offline.

const DB_NAME = 'vr-sifir';
const STORE = 'songs';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req && req.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export async function listSongs() {
  const all = await tx('readonly', (s) => s.getAll());
  return (all || []).map(({ id, name, added }) => ({ id, name, added })).sort((a, b) => a.added - b.added);
}

export function getSong(id) {
  return tx('readonly', (s) => s.get(id));
}

export async function addSong(file) {
  const rec = {
    id: 'local-' + Date.now(),
    name: file.name.replace(/\.[^.]+$/, ''),
    added: Date.now(),
    blob: file,
  };
  await tx('readwrite', (s) => s.put(rec));
  return rec;
}

export function deleteSong(id) {
  return tx('readwrite', (s) => s.delete(id));
}
