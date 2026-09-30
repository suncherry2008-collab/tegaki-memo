// 画面遷移と一覧表示。
//   #/ メモ一覧(日付ごと)  #/calendar[/YYYY-MM | /YYYY-MM-DD] カレンダー  #/flags あとで確認
//   #/new 新しいメモ  #/note/ID  #/note/ID/flag/FID

import * as db from './db.js';
import { createEditor, INITIAL_HEIGHT } from './editor.js';
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

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));

const editor = createEditor({
  scroller: $('ed-scroller'),
  sheet: $('ed-sheet'),
  flagLayer: $('ed-flags'),
  live: $('ed-live'),
  undoBtn: $('ed-undo'),
  hint: $('ed-hint'),
  toolButtons: [...document.querySelectorAll('#view-editor .tool[data-tool]')],
  colorButtons: [...document.querySelectorAll('#view-editor .color')],
}, { onError: (msg) => showToast(msg) });

let editorOpen = false;
let backTo = '#/';
let routeSeq = 0;

// ---------- 日付 ----------

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const pad2 = (n) => String(n).padStart(2, '0');

function formatDay(ms) {
  const d = new Date(ms);
  const y = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}年` : '';
  return `${y}${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;
}
function formatTime(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function formatDate(ms) {
  return `${formatDay(ms)} ${formatTime(ms)}`;
}
// 端末の時刻での日付キー 'YYYY-MM-DD'
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ---------- 画面遷移 ----------

function normalize(n) {
  n.strokes = n.strokes || [];
  n.flags = n.flags || [];
  n.height = n.height || INITIAL_HEIGHT;
  return n;
}

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

  if (parts[0] === 'new') {
    const now = Date.now();
    showEditor({ id: uid(), createdAt: now, updatedAt: now, height: INITIAL_HEIGHT, strokes: [], flags: [] });
    return;
  }
  if (parts[0] === 'note' && parts[1]) {
    const note = await db.getNote(parts[1]);
    if (seq !== routeSeq) return;
    if (!note) { location.replace('#/'); return; }
    showEditor(normalize(note), parts[2] === 'flag' ? parts[3] : null);
    return;
  }
  const tab = parts[0] === 'flags' ? 'flags' : parts[0] === 'calendar' ? 'calendar' : 'notes';
  await showHome(tab, parts[1], seq);
}

function showEditor(note, focusFlagId = null) {
  homeView.hidden = true;
  editorView.hidden = false;
  $('ed-date').textContent = formatDate(note.createdAt);
  editorOpen = true;
  editor.open(note, { focusFlagId });
}

$('ed-back').addEventListener('click', () => { location.hash = backTo; });

// ---------- ホーム(メモ一覧 / あとで確認) ----------

async function showHome(tab, param, seq) {
  const notes = (await db.getAllNotes()).map(normalize);
  if (seq !== routeSeq) return;
  notes.sort((a, b) => b.createdAt - a.createdAt);
  backTo = location.hash || '#/';

  editorView.hidden = true;
  homeView.hidden = false;
  tabNotes.setAttribute('aria-selected', String(tab === 'notes'));
  tabCalendar.setAttribute('aria-selected', String(tab === 'calendar'));
  tabFlags.setAttribute('aria-selected', String(tab === 'flags'));
  updateFlagCount(notes);
  if (tab === 'notes') { homeMain.scrollTop = 0; renderNoteList(notes); }
  else if (tab === 'calendar') renderCalendar(notes, param);
  else { homeMain.scrollTop = 0; renderFlagList(notes); }
}

function updateFlagCount(notes) {
  const n = notes.reduce((sum, x) => sum + x.flags.length, 0);
  flagCount.textContent = n;
  flagCount.hidden = n === 0;
}

function emptyMessage(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

// サムネイルは少しずつ描く(メモが多くても一覧がすぐ出るように)
function drawLater(jobs) {
  const step = () => {
    const batch = jobs.splice(0, 6);
    for (const job of batch) job();
    if (jobs.length) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// メモのカード(サムネイル + 下のラベル)
function noteCard(note, label, jobs) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'note-card';
  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  const date = document.createElement('span');
  date.className = 'date';
  date.textContent = label;
  if (note.flags.length) {
    const mark = document.createElement('span');
    mark.className = 'card-flag';
    mark.textContent = `あとで確認 ${note.flags.length}`;
    date.appendChild(mark);
  }
  btn.append(thumb, date);
  btn.addEventListener('click', () => { location.hash = `#/note/${note.id}`; });
  li.appendChild(btn);
  jobs.push(() => thumb.appendChild(renderRegion(note, { x: 0, y: 0, w: PAGE_W, h: 700 }, 320, 224)));
  return li;
}

// メモ一覧:日付ごとに区切って新しい順に並べる
function renderNoteList(notes) {
  homeMain.textContent = '';
  if (!notes.length) {
    homeMain.appendChild(emptyMessage('まだメモがありません。「新しいメモ」から書き始められます。'));
    return;
  }
  const jobs = [];
  let key = null;
  let ul = null;
  for (const note of notes) {
    const k = dayKey(note.createdAt);
    if (k !== key) {
      key = k;
      const h = document.createElement('h2');
      h.className = 'day-head';
      h.textContent = formatDay(note.createdAt);
      ul = document.createElement('ul');
      ul.className = 'note-grid';
      homeMain.append(h, ul);
    }
    ul.appendChild(noteCard(note, formatTime(note.createdAt), jobs));
  }
  drawLater(jobs);
}

// カレンダー:メモを書いた日に印が付く。日付をタップするとその日のメモが下に並ぶ。
function renderCalendar(notes, param) {
  const today = new Date();
  let y = today.getFullYear();
  let m = today.getMonth();
  let selected = dayKey(today.getTime());
  if (param && /^\d{4}-\d{2}(-\d{2})?$/.test(param)) {
    y = +param.slice(0, 4);
    m = +param.slice(5, 7) - 1;
    selected = param.length === 10 ? param : null;
  }

  const byDay = new Map();
  for (const n of notes) {
    const k = dayKey(n.createdAt);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(n);
  }

  homeMain.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'calendar';

  // 月の切り替え
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

  // 日付のマス
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
  const days = new Date(y, m + 1, 0).getDate();
  const todayKey = dayKey(today.getTime());
  for (let d = 1; d <= days; d++) {
    const k = `${y}-${pad2(m + 1)}-${pad2(d)}`;
    const list = byDay.get(k) || [];
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-day';
    if (list.length) cell.classList.add('has');
    if (k === todayKey) cell.classList.add('today');
    if (k === selected) cell.setAttribute('aria-pressed', 'true');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = d;
    cell.appendChild(num);
    if (list.length) {
      const marks = document.createElement('span');
      marks.className = 'marks';
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = `${list.length}件`;
      marks.appendChild(cnt);
      if (list.some((n) => n.flags.length)) {
        const f = document.createElement('span');
        f.className = 'fdot';
        f.setAttribute('aria-label', 'あとで確認あり');
        marks.appendChild(f);
      }
      cell.appendChild(marks);
    }
    cell.setAttribute('aria-label', `${m + 1}月${d}日 メモ${list.length}件`);
    cell.addEventListener('click', () => location.replace(`#/calendar/${k}`));
    grid.appendChild(cell);
  }
  wrap.append(nav, grid);
  homeMain.appendChild(wrap);

  // 選んだ日のメモ
  if (selected) {
    const [sy, sm, sd] = selected.split('-').map(Number);
    const h = document.createElement('h2');
    h.className = 'day-head';
    h.textContent = formatDay(new Date(sy, sm - 1, sd).getTime());
    homeMain.appendChild(h);
    const list = byDay.get(selected) || [];
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'day-empty';
      p.textContent = 'この日のメモはありません。';
      homeMain.appendChild(p);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'note-grid';
      const jobs = [];
      for (const n of list) ul.appendChild(noteCard(n, formatTime(n.createdAt), jobs));
      homeMain.appendChild(ul);
      drawLater(jobs);
    }
  }
}

function renderFlagList(notes) {
  homeMain.textContent = '';
  const items = [];
  for (const note of notes) for (const flag of note.flags) items.push({ note, flag });
  if (!items.length) {
    homeMain.appendChild(emptyMessage('あとで確認するものはありません。メモの中で「あとで確認」を選び、書いたところを囲むとここに並びます。'));
    return;
  }
  items.sort((a, b) => b.flag.createdAt - a.flag.createdAt);

  const ul = document.createElement('ul');
  ul.className = 'flag-list';
  const jobs = [];
  for (const { note, flag } of items) {
    const li = document.createElement('li');
    li.className = 'flag-item';

    const open = () => { location.hash = `#/note/${note.id}/flag/${flag.id}`; };

    const thumbBtn = document.createElement('button');
    thumbBtn.type = 'button';
    thumbBtn.className = 'flag-thumb';
    thumbBtn.setAttribute('aria-label', 'メモを開く');
    thumbBtn.addEventListener('click', open);

    const meta = document.createElement('div');
    meta.className = 'flag-meta';
    const date = document.createElement('span');
    date.className = 'flag-date';
    date.textContent = formatDate(note.createdAt);
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn';
    openBtn.textContent = 'メモを開く';
    openBtn.addEventListener('click', open);
    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'btn btn-done';
    doneBtn.textContent = '確認済み';
    doneBtn.addEventListener('click', () => markDone(note, flag, li, notes));
    meta.append(date, openBtn, doneBtn);

    li.append(thumbBtn, meta);
    ul.appendChild(li);
    jobs.push(() => {
      const w = Math.max(200, thumbBtn.clientWidth || 480);
      thumbBtn.appendChild(renderRegion(note, flag, w, 220, 1.3));
    });
  }
  homeMain.appendChild(ul);
  drawLater(jobs);
}

// 「確認済み」= フラグを外す。誤タップに備えて数秒間は元に戻せる。
async function markDone(note, flag, li, notes) {
  const index = note.flags.indexOf(flag);
  if (index < 0) return;
  note.flags.splice(index, 1);
  note.updatedAt = Date.now();
  li.hidden = true;
  updateFlagCount(notes);
  try {
    await db.putNote(note);
  } catch (err) {
    console.error(err);
    note.flags.splice(index, 0, flag);
    li.hidden = false;
    updateFlagCount(notes);
    showToast('保存できませんでした。iPadの空き容量を確認してください。');
    return;
  }
  showToast('フラグを外しました', '元に戻す', async () => {
    note.flags.splice(Math.min(index, note.flags.length), 0, flag);
    await db.putNote(note);
    li.hidden = false;
    updateFlagCount(notes);
  });
  if (!notes.some((n) => n.flags.length)) {
    homeMain.appendChild(emptyMessage('確認するものはすべて終わりました。'));
  }
}

tabNotes.addEventListener('click', () => { location.hash = '#/'; });
tabCalendar.addEventListener('click', () => { location.hash = '#/calendar'; });
tabFlags.addEventListener('click', () => { location.hash = '#/flags'; });
$('btn-new').addEventListener('click', () => { location.hash = '#/new'; });

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

// 端末の容量が逼迫してもメモが消されにくくする
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// オフライン用。開発中(localhost)はキャッシュが邪魔になるので ?sw=1 のときだけ登録する。
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && window.isSecureContext && (!isLocal || location.search.includes('sw=1'))) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('service worker', err));
}

window.addEventListener('hashchange', route);
route();
