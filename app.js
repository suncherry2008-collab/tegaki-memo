// 画面遷移と一覧表示。
//   #/ 記録一覧   #/calendar[/YYYY-MM] カレンダー   #/flags あとで確認
//   #/today 今日の記録   #/day/YYYY-MM-DD[/page/ページID[/flag/フラグID]]
// 記録は「1日 = 1つの記録」。その中に複数のページがある。

import * as db from './db.js';
import { createEditor } from './editor.js';
import { PAGE_W, renderRegion } from './render.js';

const $ = (id) => document.getElementById(id);

const homeView = $('view-home');
const editorView = $('view-editor');
const homeMain = $('home-main');
const tabNotes = $('tab-notes');
const tabCalendar = $('tab-calendar');
const tabFlags = $('tab-flags');
const flagCount = $('flag-count');
const toast = $('toast');
const pgDate = $('pg-date');
const pgLabel = $('pg-label');
const pgPrev = $('pg-prev');
const pgNext = $('pg-next');
const pgAdd = $('pg-add');
const pgDel = $('pg-del');

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));

const editor = createEditor({
  scroller: $('ed-scroller'),
  sheet: $('ed-sheet'),
  flagLayer: $('ed-flags'),
  live: $('ed-live'),
  predict: $('ed-predict'),
  undoBtn: $('ed-undo'),
  hint: $('ed-hint'),
  toolButtons: [...document.querySelectorAll('#view-editor .tool[data-tool]')],
  colorButtons: [...document.querySelectorAll('#view-editor .color')],
  widthButtons: [...document.querySelectorAll('#view-editor .width')],
}, { onChange: onPageChange, onError: (msg) => showToast(msg) });

let editorOpen = false;
let backTo = '#/';
let routeSeq = 0;

// ---------- 日付 ----------

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = db.dayKey;
const isDayKey = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k || '');
const keyToDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };

function formatDay(k) {
  const d = keyToDate(k);
  const y = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}年` : '';
  return `${y}${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;
}

// ---------- 画面遷移 ----------

async function leaveEditor() {
  if (!editorOpen) return;
  editorOpen = false;
  await editor.close();
}

async function route() {
  const seq = ++routeSeq;
  const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
  await leaveEditor();
  if (seq !== routeSeq) return;

  // 以前の形式のリンク(#/new, #/note/ID)
  if (parts[0] === 'new') { location.replace('#/today'); return; }
  if (parts[0] === 'note' && parts[1]) {
    const p = await db.getPage(parts[1]);
    const flag = parts[2] === 'flag' ? `/flag/${parts[3]}` : '';
    location.replace(p ? `#/day/${p.day}/page/${p.id}${flag}` : '#/');
    return;
  }

  if (parts[0] === 'today') { location.replace(`#/day/${dayKey(Date.now())}`); return; }
  if (parts[0] === 'day' && isDayKey(parts[1])) {
    await openDay(parts[1], parts[2] === 'page' ? parts[3] : null, parts[4] === 'flag' ? parts[5] : null, seq);
    return;
  }
  const tab = parts[0] === 'flags' ? 'flags' : parts[0] === 'calendar' ? 'calendar' : 'notes';
  await showHome(tab, parts[1], seq);
}

$('ed-back').addEventListener('click', () => { location.hash = backTo; });

// ---------- 1日の記録(ページの切り替え・追加・削除) ----------

let day = null;          // 開いている日の記録
let pages = [];          // その日のページ(並び順どおり)
let cur = 0;             // 開いているページの番号
let dayStored = false;   // 日の記録がすでに保存されているか
const unsaved = new Set(); // まだ保存していない(何も書いていない)ページ

function newPage(dayId) {
  const now = Date.now();
  return { id: uid(), day: dayId, h: db.PAGE_H, strokes: [], flags: [], createdAt: now, updatedAt: now };
}

async function openDay(dayId, pageId, flagId, seq) {
  const stored = await db.getDay(dayId);
  const list = stored ? await db.getPagesOfDay(dayId) : [];
  if (seq !== routeSeq) return;
  unsaved.clear();
  if (stored) {
    day = stored;
    dayStored = true;
    const byId = new Map(list.map((p) => [p.id, p]));
    pages = day.pages.map((id) => byId.get(id)).filter(Boolean);
  } else {
    const now = Date.now();
    day = { id: dayId, pages: [], createdAt: now, updatedAt: now };
    dayStored = false;
    pages = [];
  }
  if (!pages.length) {
    const p = newPage(dayId);
    pages.push(p);
    day.pages = [p.id];
    unsaved.add(p.id);
  }
  // 指定のページ、なければ最後のページ(続きを書けるように)
  let i = pageId ? pages.findIndex((p) => p.id === pageId) : -1;
  if (i < 0) i = pages.length - 1;

  homeView.hidden = true;
  editorView.hidden = false;
  pgDate.textContent = formatDay(dayId);
  editorOpen = true;
  showPage(i, flagId);
}

function showPage(i, flagId = null) {
  cur = i;
  editor.open(pages[i], { focusFlagId: flagId });
  pgLabel.textContent = `${i + 1} / ${pages.length}`;
  pgPrev.disabled = i === 0;
  pgNext.disabled = i === pages.length - 1;
  pgDel.disabled = pages.length <= 1;
  history.replaceState(null, '', `#/day/${day.id}/page/${pages[i].id}`);
}

async function goToPage(i) {
  if (i < 0 || i >= pages.length || i === cur) return;
  await editor.flush();
  showPage(i);
}

// 書いたとき:その日の記録がまだ保存されていなければ保存する
function onPageChange(p) {
  unsaved.delete(p.id);
  day.updatedAt = Date.now();
  if (!dayStored) {
    dayStored = true;
    db.putDay(day).catch((err) => { console.error(err); dayStored = false; });
  }
}

async function addPage() {
  await editor.flush();
  const p = newPage(day.id);
  pages.push(p);
  day.pages.push(p.id);
  day.updatedAt = Date.now();
  const toSave = pages.filter((x) => unsaved.has(x.id) || x === p);
  try {
    await db.putDayWithPages(day, toSave);
    dayStored = true;
    unsaved.clear();
  } catch (err) {
    console.error(err);
    showToast('保存できませんでした。iPadの空き容量を確認してください。');
  }
  showPage(pages.length - 1);
}

async function deletePage() {
  if (pages.length <= 1) return;
  const p = pages[cur];
  const hasFlags = p.flags.length > 0;
  const msg = `${cur + 1}ページ目を削除しますか?` +
    (hasFlags ? '\nこのページの「あとで確認」も消えます。' : '') + '\nこの操作は元に戻せません。';
  if (!window.confirm(msg)) return;
  await editor.flush();
  const removedAt = cur;
  pages.splice(cur, 1);
  day.pages = pages.map((x) => x.id);
  day.updatedAt = Date.now();
  unsaved.delete(p.id);
  try {
    if (dayStored) await db.deletePage(day, p.id);
  } catch (err) {
    console.error(err);
    showToast('削除できませんでした。');
  }
  showPage(Math.max(0, removedAt - 1)); // 削除したページの1つ前を表示
}

pgPrev.addEventListener('click', () => goToPage(cur - 1));
pgNext.addEventListener('click', () => goToPage(cur + 1));
pgAdd.addEventListener('click', addPage);
pgDel.addEventListener('click', deletePage);

// ---------- ホーム(記録一覧 / カレンダー / あとで確認) ----------

async function loadAll() {
  const [days, allPages] = await Promise.all([db.getAllDays(), db.getAllPages()]);
  const byId = new Map(allPages.map((p) => [p.id, p]));
  for (const d of days) d.pageList = d.pages.map((id) => byId.get(id)).filter(Boolean);
  days.sort((a, b) => (a.id < b.id ? 1 : -1)); // 新しい日付が先
  return days;
}

async function showHome(tab, param, seq) {
  const days = await loadAll();
  if (seq !== routeSeq) return;
  backTo = location.hash || '#/';

  editorView.hidden = true;
  homeView.hidden = false;
  tabNotes.setAttribute('aria-selected', String(tab === 'notes'));
  tabCalendar.setAttribute('aria-selected', String(tab === 'calendar'));
  tabFlags.setAttribute('aria-selected', String(tab === 'flags'));
  updateFlagCount(days);
  if (tab === 'notes') { homeMain.scrollTop = 0; renderDayList(days); }
  else if (tab === 'calendar') renderCalendar(days, param);
  else { homeMain.scrollTop = 0; renderFlagList(days); }
}

const flagsOf = (d) => d.pageList.reduce((n, p) => n + p.flags.length, 0);

function updateFlagCount(days) {
  const n = days.reduce((sum, d) => sum + flagsOf(d), 0);
  flagCount.textContent = n;
  flagCount.hidden = n === 0;
}

function emptyMessage(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

// サムネイルは少しずつ描く(記録が多くても一覧がすぐ出るように)
function drawLater(jobs) {
  const step = () => {
    const batch = jobs.splice(0, 6);
    for (const job of batch) job();
    if (jobs.length) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// 1日分の記録のカード(1ページ目のサムネイル + 日付・ページ数)
function dayCard(d, jobs) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'note-card';
  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  const label = document.createElement('span');
  label.className = 'date';
  const name = document.createElement('span');
  name.className = 'day-name';
  name.textContent = formatDay(d.id);
  const count = document.createElement('span');
  count.textContent = `${d.pageList.length}ページ`;
  label.append(name, count);
  const f = flagsOf(d);
  if (f) {
    const mark = document.createElement('span');
    mark.className = 'card-flag';
    mark.textContent = `あとで確認 ${f}`;
    label.appendChild(mark);
  }
  btn.append(thumb, label);
  btn.addEventListener('click', () => { location.hash = `#/day/${d.id}`; });
  li.appendChild(btn);
  const first = d.pageList[0];
  if (first) jobs.push(() => thumb.appendChild(renderRegion(first, { x: 0, y: 0, w: PAGE_W, h: 700 }, 320, 224)));
  return li;
}

// 記録一覧:1日 = 1枚。月ごとに区切って新しい順に並べる
function renderDayList(days) {
  homeMain.textContent = '';
  const list = days.filter((d) => d.pageList.length);
  if (!list.length) {
    homeMain.appendChild(emptyMessage('まだ記録がありません。「今日の記録」から書き始められます。'));
    return;
  }
  const jobs = [];
  let month = null;
  let ul = null;
  for (const d of list) {
    const m = d.id.slice(0, 7);
    if (m !== month) {
      month = m;
      const h = document.createElement('h2');
      h.className = 'day-head';
      h.textContent = `${+m.slice(0, 4)}年${+m.slice(5, 7)}月`;
      ul = document.createElement('ul');
      ul.className = 'note-grid';
      homeMain.append(h, ul);
    }
    ul.appendChild(dayCard(d, jobs));
  }
  drawLater(jobs);
}

// カレンダー:記録がある日にページ数が出る。日付をタップするとその日の記録を開く(過去の日にも書ける)
function renderCalendar(days, param) {
  const today = new Date();
  let y = today.getFullYear();
  let m = today.getMonth();
  if (param && /^\d{4}-\d{2}$/.test(param)) {
    y = +param.slice(0, 4);
    m = +param.slice(5, 7) - 1;
  }
  const byDay = new Map(days.filter((d) => d.pageList.length).map((d) => [d.id, d]));

  homeMain.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'calendar';

  const nav = document.createElement('div');
  nav.className = 'cal-nav';
  const monthKey = (yy, mm) => { const d = new Date(yy, mm, 1); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'cal-move';
  prev.setAttribute('aria-label', '前の月');
  prev.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
  prev.addEventListener('click', () => location.replace(`#/calendar/${monthKey(y, m - 1)}`));
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'cal-move';
  next.setAttribute('aria-label', '次の月');
  next.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
  next.addEventListener('click', () => location.replace(`#/calendar/${monthKey(y, m + 1)}`));
  const title = document.createElement('h2');
  title.className = 'cal-title';
  title.textContent = `${y}年${m + 1}月`;
  nav.append(prev, title, next);

  const grid = document.createElement('div');
  grid.className = 'cal-grid';
  WEEK.forEach((w, i) => {
    const h = document.createElement('span');
    h.className = 'cal-week' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '');
    h.textContent = w;
    grid.appendChild(h);
  });
  const first = new Date(y, m, 1).getDay();
  for (let i = 0; i < first; i++) grid.appendChild(document.createElement('span'));
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayKey = dayKey(today.getTime());
  for (let d = 1; d <= daysInMonth; d++) {
    const k = `${y}-${pad2(m + 1)}-${pad2(d)}`;
    const rec = byDay.get(k);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-day';
    if (rec) cell.classList.add('has');
    if (k === todayKey) cell.classList.add('today');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = d;
    cell.appendChild(num);
    if (rec) {
      const marks = document.createElement('span');
      marks.className = 'marks';
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = `${rec.pageList.length}p`;
      marks.appendChild(cnt);
      if (flagsOf(rec)) {
        const f = document.createElement('span');
        f.className = 'fdot';
        marks.appendChild(f);
      }
      cell.appendChild(marks);
    }
    if (k > todayKey) {
      cell.disabled = true; // 未来の日には書かない
    } else {
      cell.addEventListener('click', () => { location.hash = `#/day/${k}`; });
    }
    cell.setAttribute('aria-label', `${m + 1}月${d}日` + (rec ? ` ${rec.pageList.length}ページ` : ' 記録なし'));
    grid.appendChild(cell);
  }
  wrap.append(nav, grid);
  homeMain.appendChild(wrap);
}

// あとで確認:囲んだ部分だけを、日付とページ番号つきで並べる
function renderFlagList(days) {
  homeMain.textContent = '';
  const items = [];
  for (const d of days) {
    d.pageList.forEach((page, index) => {
      for (const flag of page.flags) items.push({ d, page, index, flag });
    });
  }
  if (!items.length) {
    homeMain.appendChild(emptyMessage('あとで確認するものはありません。記録の中で「あとで確認」を選び、書いたところを囲むとここに並びます。'));
    return;
  }
  items.sort((a, b) => b.flag.createdAt - a.flag.createdAt);

  const ul = document.createElement('ul');
  ul.className = 'flag-list';
  const jobs = [];
  for (const { d, page, index, flag } of items) {
    const li = document.createElement('li');
    li.className = 'flag-item';

    const open = () => { location.hash = `#/day/${d.id}/page/${page.id}/flag/${flag.id}`; };

    const thumbBtn = document.createElement('button');
    thumbBtn.type = 'button';
    thumbBtn.className = 'flag-thumb';
    thumbBtn.setAttribute('aria-label', 'このページを開く');
    thumbBtn.addEventListener('click', open);

    const meta = document.createElement('div');
    meta.className = 'flag-meta';
    const date = document.createElement('span');
    date.className = 'flag-date';
    date.textContent = `${formatDay(d.id)} ${index + 1}ページ目`;
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn';
    openBtn.textContent = 'ページを開く';
    openBtn.addEventListener('click', open);
    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'btn btn-done';
    doneBtn.textContent = '確認済み';
    doneBtn.addEventListener('click', () => markDone(page, flag, li, days));
    meta.append(date, openBtn, doneBtn);

    li.append(thumbBtn, meta);
    ul.appendChild(li);
    jobs.push(() => {
      const w = Math.max(200, thumbBtn.clientWidth || 480);
      thumbBtn.appendChild(renderRegion(page, flag, w, 220, 1.3));
    });
  }
  homeMain.appendChild(ul);
  drawLater(jobs);
}

// 「確認済み」= フラグを外す。誤タップに備えて数秒間は元に戻せる。
async function markDone(page, flag, li, days) {
  const index = page.flags.indexOf(flag);
  if (index < 0) return;
  page.flags.splice(index, 1);
  page.updatedAt = Date.now();
  li.hidden = true;
  updateFlagCount(days);
  try {
    await db.putPage(page);
  } catch (err) {
    console.error(err);
    page.flags.splice(index, 0, flag);
    li.hidden = false;
    updateFlagCount(days);
    showToast('保存できませんでした。iPadの空き容量を確認してください。');
    return;
  }
  showToast('フラグを外しました', '元に戻す', async () => {
    page.flags.splice(Math.min(index, page.flags.length), 0, flag);
    await db.putPage(page);
    li.hidden = false;
    updateFlagCount(days);
  });
  if (!days.some((d) => flagsOf(d))) {
    homeMain.appendChild(emptyMessage('確認するものはすべて終わりました。'));
  }
}

tabNotes.addEventListener('click', () => { location.hash = '#/'; });
tabCalendar.addEventListener('click', () => { location.hash = '#/calendar'; });
tabFlags.addEventListener('click', () => { location.hash = '#/flags'; });
$('btn-new').addEventListener('click', () => { location.hash = '#/today'; });

// ---------- お知らせ ----------

let toastTimer = null;
function showToast(text, actionLabel, onAction) {
  clearTimeout(toastTimer);
  toast.textContent = '';
  const span = document.createElement('span');
  span.textContent = text;
  toast.appendChild(span);
  if (actionLabel) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = actionLabel;
    b.addEventListener('click', async () => {
      toast.hidden = true;
      await onAction();
      const empty = homeMain.querySelector('.empty');
      if (empty && homeMain.querySelector('.flag-item:not([hidden])')) empty.remove();
    });
    toast.appendChild(b);
  }
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}

// ---------- iPad向けの設定 ----------

// ピンチでの画面拡大を防ぐ(Safari)
document.addEventListener('gesturestart', (e) => e.preventDefault());

// 端末の容量が逼迫しても記録が消されにくくする
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// オフライン用。開発中(localhost)はキャッシュが邪魔になるので ?sw=1 のときだけ登録する。
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && window.isSecureContext && (!isLocal || location.search.includes('sw=1'))) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('service worker', err));
}

window.addEventListener('hashchange', route);
route();
