// Shared IndexedDB helper for stashing the just-recorded task video so the
// review/annotation editor tab can load it without a server round-trip.
// Loaded by both offscreen.html (writer) and editor.html (reader) — they run in
// the same chrome-extension:// origin, so they share this database.

const RECORDINGS_DB = 'ui-rater-recordings';
const RECORDINGS_STORE = 'recordings';

function openRecordingsDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RECORDINGS_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDINGS_STORE)) {
        db.createObjectStore(RECORDINGS_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function recordingKey(participantId, taskIndex) {
  return `${participantId}__task${taskIndex}`;
}

async function putRecording(key, blob) {
  const db = await openRecordingsDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(RECORDINGS_STORE, 'readwrite');
      tx.objectStore(RECORDINGS_STORE).put({ blob, createdAt: Date.now() }, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function getRecording(key) {
  const db = await openRecordingsDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(RECORDINGS_STORE, 'readonly');
      const r = tx.objectStore(RECORDINGS_STORE).get(key);
      r.onsuccess = () => resolve(r.result ? r.result.blob : null);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

async function deleteRecording(key) {
  const db = await openRecordingsDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(RECORDINGS_STORE, 'readwrite');
      tx.objectStore(RECORDINGS_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
