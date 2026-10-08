// 端末内保存(IndexedDB)。
//
// 「1日 = 1つの記録」、その中に複数のページを持つ。
//
// day  = {                       // days ストア
//   id: 'YYYY-MM-DD',            // 記録の日付(端末の時刻で判定)
//   pages: [pageId, ...],        // ページの並び順
//   createdAt, updatedAt
// }
// page = {                       // pages ストア。書くたびに保存されるのは開いているページだけ
//   id, day: 'YYYY-MM-DD',
//   h: number,                   // ページの高さ(ページ座標。横幅は1000固定)
//   bg: 'ruled' | 'grid' | 'plain', // ページの種類(罫線・方眼・無地)。無い場合は罫線
//   strokes: [{ id, w, c, pts: [x, y, 筆圧, ...], b: [minX, minY, maxX, maxY] }],
//            // w = 太さ、c = 色(無い場合は黒)、hl = 1 なら蛍光ペン
//   flags:   [{ id, x, y, w, h, createdAt }],   // 「あとで確認」で囲んだ範囲
//   createdAt, updatedAt
// }
//
// 旧形式(notes ストア、メモ1件 = 1レコード)は、バージョン2への更新時に
// 「同じ日のメモ = その日の記録のページ(古い順)」として移行する。notes ストアは念のため残す。

const DB_NAME = 'tegaki-memo';
const DB_VERSION = 2;
export const PAGE_H = 1414; // A4縦の比率

const pad2 = (n) => String(n).padStart(2, '0');
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

let dbPromise = null;

function migrateNotes(tx) {
  const req = tx.objectStore('notes').getAll();
  req.onsuccess = () => {
    const groups = new Map();
    for (const n of req.result) {
      const k = dayKey(n.createdAt);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }
    const days = tx.objectStore('days');
    const pages = tx.objectStore('pages');
    for (const [k, list] of groups) {
      list.sort((a, b) => a.createdAt - b.createdAt);
      for (const n of list) {
        pages.put({
          id: n.id, day: k, h: n.height || PAGE_H,
          strokes: n.strokes || [], flags: n.flags || [],
          createdAt: n.createdAt, updatedAt: n.updatedAt || n.createdAt,
        });
      }
      days.put({
        id: k, pages: list.map((n) => n.id),
        createdAt: list[0].createdAt,
        updatedAt: Math.max(...list.map((n) => n.updatedAt || n.createdAt)),
      });
    }
  };
}

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('days')) db.createObjectStore('days', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) {
          db.createObjectStore('pages', { keyPath: 'id' }).createIndex('day', 'day');
        }
        if (e.oldVersion === 1) migrateNotes(req.transaction);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// stores: 使うストア名の配列。fn(tx) が返したリクエストの結果を返す。
function run(stores, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const req = fn(tx);
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const getAllDays = () => run(['days'], 'readonly', (tx) => tx.objectStore('days').getAll());
export const getDay = (id) => run(['days'], 'readonly', (tx) => tx.objectStore('days').get(id));
export const putDay = (day) => run(['days'], 'readwrite', (tx) => tx.objectStore('days').put(day));

export const getAllPages = () => run(['pages'], 'readonly', (tx) => tx.objectStore('pages').getAll());
export const getPage = (id) => run(['pages'], 'readonly', (tx) => tx.objectStore('pages').get(id));
export const getPagesOfDay = (dayId) =>
  run(['pages'], 'readonly', (tx) => tx.objectStore('pages').index('day').getAll(dayId));
export const putPage = (page) => run(['pages'], 'readwrite', (tx) => tx.objectStore('pages').put(page));

// 日の記録と複数ページをまとめて保存する(ページ追加時など)
export const putDayWithPages = (day, pages) => run(['days', 'pages'], 'readwrite', (tx) => {
  for (const p of pages) tx.objectStore('pages').put(p);
  return tx.objectStore('days').put(day);
});

// ページを削除し、日の記録からも外す
export const deletePage = (day, pageId) => run(['days', 'pages'], 'readwrite', (tx) => {
  tx.objectStore('pages').delete(pageId);
  return tx.objectStore('days').put(day);
});
