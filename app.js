// 画面遷移(#/ メモ一覧, #/flags あとで確認, #/new, #/note/ID, #/note/ID/flag/FID)と一覧表示。

import * as db from './db.js';
import { createEditor, INITIAL_HEIGHT } from './editor.js';
import { PAGE_W, renderRegion } from './render.js';

const $ = (id) => document.getElementById(id);

const homeView = $('view-home');
const editorView = $('view-editor');
const homeMain = $('home-main');
const tabNotes = $('tab-notes');
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
}, { onError: (msg) => showToast(msg) });

let editorOpen = false;
let backTo = '#/';
let routeSeq = 0;

// ---------- 日付 ----------

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
function formatDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}年` : '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]}) ${hh}:${mm}`;
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
  await showHome(parts[0] === 'flags' ? 'flags' : 'notes', seq);
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

async function showHome(tab, seq) {
  const notes = (await db.getAllNotes()).map(normalize);
  if (seq !== routeSeq) return;
  notes.sort((a, b) => b.createdAt - a.createdAt);
  backTo = tab === 'flags' ? '#/flags' : '#/';

  editorView.hidden = true;
  homeView.hidden = false;
  tabNotes.setAttribute('aria-selected', String(tab === 'notes'));
  tabFlags.setAttribute('aria-selected', String(tab === 'flags'));
  updateFlagCount(notes);
  homeMain.scrollTop = 0;
  if (tab === 'notes') renderNoteList(notes);
  else renderFlagList(notes);
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

function renderNoteList(notes) {
  homeMain.textContent = '';
  if (!notes.length) {
    homeMain.appendChild(emptyMessage('まだメモがありません。「新しいメモ」から書き始められます。'));
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'note-grid';
  const jobs = [];
  for (const note of notes) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'note-card';
    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = formatDate(note.createdAt);
    if (note.flags.length) {
      const mark = document.createElement('span');
      mark.className = 'card-flag';
      mark.textContent = `あとで確認 ${note.flags.length}`;
      date.appendChild(mark);
    }
    btn.append(thumb, date);
    btn.addEventListener('click', () => { location.hash = `#/note/${note.id}`; });
    li.appendChild(btn);
    ul.appendChild(li);
    jobs.push(() => thumb.appendChild(renderRegion(note, { x: 0, y: 0, w: PAGE_W, h: 700 }, 320, 224)));
  }
  homeMain.appendChild(ul);
  drawLater(jobs);
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
