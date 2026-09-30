// 端末内保存(IndexedDB)。メモ1件 = 1レコード。
//
// note = {
//   id: string,
//   createdAt: number,   // 作成日時(ms)。一覧の日付表示に使う
//   updatedAt: number,
//   height: number,      // ページの高さ(ページ座標)。書き進めると自動で伸びる
//   strokes: [{ id, w, pts: [x, y, 筆圧, ...], b: [minX, minY, maxX, maxY] }],
//   flags:   [{ id, x, y, w, h, createdAt }]   // 「あとで確認」で囲んだ範囲
// }

const DB_NAME = 'tegaki-memo';
const DB_VERSION = 1;
const STORE = 'notes';

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const getAllNotes = () => run('readonly', (s) => s.getAll());
export const getNote = (id) => run('readonly', (s) => s.get(id));
export const putNote = (note) => run('readwrite', (s) => s.put(note));
