// IndexedDB: Aufnahmen (Metadaten, Transkript, Zusammenfassung) und Audio-Stücke.
// Audio wird als ArrayBuffer gespeichert (robuster als Blob in Safari).

const DB_NAME = 'straub-hoert-zu';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        // Schlüssel: [Aufnahme-ID, Teil, laufende Nummer]
        db.createObjectStore('chunks', { keyPath: ['recId', 'part', 'seq'] });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => console.warn('IndexedDB blockiert');
  });
  return dbPromise;
}

/** Führt eine Transaktion aus. body(tx, out) setzt out.value. Bei verlorener Verbindung ein Neuversuch. */
async function run(stores, mode, body, retry = true) {
  const db = await openDB();
  let tx;
  try {
    tx = db.transaction(stores, mode);
  } catch (err) {
    // Safari schließt Verbindungen manchmal im Hintergrund.
    dbPromise = null;
    if (retry) return run(stores, mode, body, false);
    throw err;
  }
  return new Promise((resolve, reject) => {
    const out = { value: undefined };
    tx.oncomplete = () => resolve(out.value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Datenbank-Transaktion abgebrochen'));
    try {
      body(tx, out);
    } catch (err) {
      try { tx.abort(); } catch { /* egal */ }
      reject(err);
    }
  });
}

export function putRecording(rec) {
  return run('recordings', 'readwrite', (tx, out) => {
    tx.objectStore('recordings').put(rec);
    out.value = rec;
  });
}

export function getRecording(id) {
  return run('recordings', 'readonly', (tx, out) => {
    const r = tx.objectStore('recordings').get(id);
    r.onsuccess = () => { out.value = r.result || null; };
  });
}

export function getAllRecordings() {
  return run('recordings', 'readonly', (tx, out) => {
    const r = tx.objectStore('recordings').getAll();
    r.onsuccess = () => {
      out.value = (r.result || []).sort((a, b) => b.createdAt - a.createdAt);
    };
  });
}

/** Liest den aktuellen Stand, wendet fn an (synchron) und speichert – ohne verlorene Updates. */
export function updateRecording(id, fn) {
  return run('recordings', 'readwrite', (tx, out) => {
    const store = tx.objectStore('recordings');
    const r = store.get(id);
    r.onsuccess = () => {
      const rec = r.result;
      if (!rec) { out.value = null; return; }
      const next = fn(rec) || rec;
      store.put(next);
      out.value = next;
    };
  });
}

export function deleteRecording(id) {
  return run(['recordings', 'chunks'], 'readwrite', (tx) => {
    tx.objectStore('recordings').delete(id);
    tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0, 0], [id, Infinity, Infinity]));
  });
}

export function putChunk(recId, part, seq, data) {
  return run('chunks', 'readwrite', (tx) => {
    tx.objectStore('chunks').put({ recId, part, seq, data });
  });
}

/** Alle Stücke eines Teils in Reihenfolge als Blob. */
export function getPartBlob(recId, part, mime) {
  return run('chunks', 'readonly', (tx, out) => {
    const r = tx.objectStore('chunks').getAll(IDBKeyRange.bound([recId, part, 0], [recId, part, Infinity]));
    r.onsuccess = () => {
      const list = (r.result || []).sort((a, b) => a.seq - b.seq).map((c) => c.data);
      out.value = new Blob(list, { type: mime || 'audio/mp4' });
    };
  });
}

/** Gesamtgröße des gespeicherten Audios einer Aufnahme (Bytes). */
export function getAudioBytes(recId) {
  return run('chunks', 'readonly', (tx, out) => {
    let total = 0;
    const r = tx.objectStore('chunks').openCursor(IDBKeyRange.bound([recId, 0, 0], [recId, Infinity, Infinity]));
    r.onsuccess = () => {
      const cur = r.result;
      if (cur) { total += cur.value.data?.byteLength || 0; cur.continue(); } else { out.value = total; }
    };
  });
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* nicht unterstützt */ }
}
