// 手書き画面。
//
// 入力の扱い:
//   Apple Pencil(pen)・マウス → 書く / 消す / 囲む
//   指(touch)                 → スクロールのみ(書かない)
//
// 描画の仕組み:
//   ページは縦に長くなるため、1枚の巨大なcanvasは使わない(iPadのcanvasサイズ上限対策)。
//   縦 TILE px ごとのcanvas(タイル)を、見えている付近だけ作って描く。
//   書いている最中の線は、画面に重ねた live canvas に描き、ペンを離した時点でタイルへ確定する。

import { PAGE_W, drawStroke, drawRuled, strokeBBox, widthOf } from './render.js';
import { putNote } from './db.js';

export const INITIAL_HEIGHT = 1414;   // A4縦の比率
const EXTEND_STEP = 700;              // 下端に近づいたら伸ばす量
const BOTTOM_MARGIN = 350;            // 下端からこの距離まで書いたら伸ばす
const TILE = 1024;                    // タイルの高さ(CSS px)
const PEN_WIDTH = 2.4;                // ペンの基本の太さ(ページ座標)
const ERASER_R = 10;                  // 消しゴムの半径(ページ座標)
const MIN_FLAG_SIZE = 24;             // これより小さい囲みは無視する
const PALM_RADIUS = 32;               // これより大きい接触は手のひらとみなす(px)
const AFTER_PEN_MS = 400;             // ペンを離した直後の指操作を無視する時間
const UNDO_LIMIT = 100;
const HOLD_MS = 600;                  // 線を引いてこの時間ペンを止めると直線になる
const HOLD_TOLERANCE = 3;             // 「止めている」とみなす揺れの範囲(ページ座標)
const MIN_LINE = 60;                  // これより短い線は直線にしない(文字の画を守るため)
const SNAP_DEG = 4;                   // 水平・垂直からこの角度以内ならぴったり揃える

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));
const r2 = (v) => Math.round(v * 100) / 100;

export function createEditor(els, { onError }) {
  const { scroller, sheet, flagLayer, live, undoBtn, hint, toolButtons, colorButtons } = els;
  const liveCtx = live.getContext('2d');

  let note = null;
  let scale = 1;
  let dpr = 1;
  let sheetW = 0;
  let sheetH = 0;
  let tool = 'pen';
  let color = colorButtons[0].dataset.color;
  let undoStack = [];
  let action = null;       // 書いている最中の操作
  let dirty = false;
  let saveTimer = null;
  let penActive = false;
  let lastPenAt = 0;
  let popEl = null;
  const tiles = new Map(); // タイル番号 → canvas

  // ---------- 開く・閉じる ----------

  function open(n, { focusFlagId = null } = {}) {
    note = n;
    undoStack = [];
    dirty = false;
    updateUndo();
    setTool('pen');
    clearTiles();
    scroller.scrollTop = 0;
    scale = 1;
    layout();
    if (focusFlagId) focusFlag(focusFlagId);
  }

  async function close() {
    await flushSave();
    closePop();
    clearTiles();
    clearLive();
    note = null;
  }

  // ---------- レイアウト ----------

  function layout() {
    if (!note) return;
    const w = scroller.clientWidth;
    if (!w) return;
    const logicalTop = scroller.scrollTop / scale;
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    sheetW = w;
    scale = w / PAGE_W;
    sheetH = Math.round(note.height * scale);
    sheet.style.width = w + 'px';
    sheet.style.height = sheetH + 'px';
    live.width = Math.round(live.clientWidth * dpr);
    live.height = Math.round(live.clientHeight * dpr);
    clearTiles();
    renderFlags();
    scroller.scrollTop = logicalTop * scale;
    updateTiles();
  }

  let layoutQueued = false;
  new ResizeObserver(() => {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => { layoutQueued = false; layout(); });
  }).observe(scroller);

  let scrollQueued = false;
  scroller.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; updateTiles(); });
  }, { passive: true });

  // ---------- タイル ----------

  function clearTiles() {
    for (const c of tiles.values()) { c.width = 0; c.height = 0; c.remove(); }
    tiles.clear();
  }

  function updateTiles() {
    if (!note || !sheetH) return;
    const top = scroller.scrollTop;
    const vh = scroller.clientHeight;
    const count = Math.ceil(sheetH / TILE);
    const first = Math.max(0, Math.floor(top / TILE) - 1);
    const last = Math.min(count - 1, Math.floor((top + vh) / TILE) + 1);
    for (const [i, c] of tiles) {
      if (i < first || i > last) { c.width = 0; c.height = 0; c.remove(); tiles.delete(i); }
    }
    for (let i = first; i <= last; i++) {
      if (tiles.has(i)) continue;
      const c = document.createElement('canvas');
      c.className = 'tile';
      sheet.insertBefore(c, flagLayer);
      tiles.set(i, c);
      renderTile(i, c);
    }
  }

  function tileContext(i, c) {
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, -dpr * i * TILE);
    return ctx;
  }

  function tileRange(i) {
    return [(i * TILE) / scale, ((i + 1) * TILE) / scale];
  }

  function renderTile(i, c) {
    const h = Math.min(TILE, sheetH - i * TILE);
    c.style.top = i * TILE + 'px';
    c.style.width = sheetW + 'px';
    c.style.height = h + 'px';
    c.width = Math.round(sheetW * dpr);
    c.height = Math.round(h * dpr);
    const ctx = tileContext(i, c);
    const [y0, y1] = tileRange(i);
    drawRuled(ctx, y0, y1, scale);
    for (const s of note.strokes) {
      if (s.b[3] >= y0 && s.b[1] <= y1) drawStroke(ctx, s);
    }
  }

  function paintOnTiles(s) {
    for (const [i, c] of tiles) {
      const [y0, y1] = tileRange(i);
      if (s.b[3] >= y0 && s.b[1] <= y1) drawStroke(tileContext(i, c), s);
    }
  }

  function rerenderRange(top, bottom) {
    for (const [i, c] of tiles) {
      const [y0, y1] = tileRange(i);
      if (bottom >= y0 && top <= y1) renderTile(i, c);
    }
  }

  function maybeExtend(maxY) {
    if (maxY <= note.height - BOTTOM_MARGIN) return;
    while (maxY > note.height - BOTTOM_MARGIN) note.height += EXTEND_STEP;
    sheetH = Math.round(note.height * scale);
    sheet.style.height = sheetH + 'px';
    clearTiles();
    updateTiles();
  }

  // ---------- 書いている最中の表示 ----------

  function clearLive() {
    liveCtx.setTransform(1, 0, 0, 1, 0, 0);
    liveCtx.clearRect(0, 0, live.width, live.height);
  }

  function setLiveTransform(a) {
    liveCtx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * a.ox, dpr * a.oy);
  }

  // ---------- 入力 ----------

  function toPage(e, a) {
    let p = 0.5;
    if (e.pointerType === 'pen') p = e.pressure > 0 ? e.pressure : 0.3;
    return { x: (e.clientX - a.left) / scale, y: (e.clientY - a.top) / scale, p };
  }

  function onPointerDown(e) {
    if (!note || action) return;
    if (e.pointerType === 'touch') return;                 // 指はスクロール用
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.flag-badge, .flag-pop')) return;
    e.preventDefault();
    closePop();
    sheet.setPointerCapture(e.pointerId);
    penActive = e.pointerType === 'pen';
    lastPenAt = performance.now();

    const sr = sheet.getBoundingClientRect();
    const lr = live.getBoundingClientRect();
    const a = { id: e.pointerId, left: sr.left, top: sr.top, ox: sr.left - lr.left, oy: sr.top - lr.top };
    const p = toPage(e, a);

    if (tool === 'pen') {
      action = {
        ...a, kind: 'pen',
        stroke: { id: uid(), w: PEN_WIDTH, c: color, pts: [p.x, p.y, p.p] },
        straight: false, anchor: { x: p.x, y: p.y }, holdTimer: null,
      };
      armHold(action);
      setLiveTransform(action);
      liveCtx.fillStyle = color;
      liveCtx.beginPath();
      liveCtx.arc(p.x, p.y, widthOf(PEN_WIDTH, p.p) / 2, 0, Math.PI * 2);
      liveCtx.fill();
    } else if (tool === 'eraser') {
      action = { ...a, kind: 'eraser', removed: [], last: p };
      eraseAlong(p, p);
      showEraser(p);
    } else if (tool === 'flag') {
      action = { ...a, kind: 'flag', pts: [p.x, p.y] };
    }
  }

  function onPointerMove(e) {
    if (!action || e.pointerId !== action.id) return;
    e.preventDefault();
    lastPenAt = performance.now();
    const list = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    for (const ev of list) {
      const p = toPage(ev, action);
      if (action.kind === 'pen') addPenPoint(p);
      else if (action.kind === 'eraser') { eraseAlong(action.last, p); action.last = p; }
      else action.pts.push(p.x, p.y);
    }
    if (action.kind === 'eraser') showEraser(action.last);
    if (action.kind === 'flag') drawLasso();
  }

  function onPointerUp(e) {
    if (!action || e.pointerId !== action.id) return;
    const a = action;
    action = null;
    clearTimeout(a.holdTimer);
    penActive = false;
    lastPenAt = performance.now();
    if (a.kind === 'pen') finishStroke(a.stroke);
    else if (a.kind === 'eraser') finishErase(a);
    else finishFlag(a);
    clearLive();
  }

  sheet.addEventListener('pointerdown', onPointerDown);
  sheet.addEventListener('pointermove', onPointerMove);
  sheet.addEventListener('pointerup', onPointerUp);
  sheet.addEventListener('pointercancel', onPointerUp);

  // iPad Safari: ペンで書いている間・手のひらが触れたときにスクロールさせない。
  // (touch-action: pan-y だけだとペンの縦方向の動きでもスクロールしてしまうため)
  function guardTouch(e) {
    if (e.target.closest && e.target.closest('button')) return;
    let block = penActive || performance.now() - lastPenAt < AFTER_PEN_MS;
    for (const t of e.touches) {
      if (t.touchType === 'stylus') block = true;
      else if ((t.radiusX || 0) > PALM_RADIUS) block = true;
    }
    if (block) e.preventDefault();
  }
  scroller.addEventListener('touchstart', guardTouch, { passive: false });
  scroller.addEventListener('touchmove', guardTouch, { passive: false });

  // ---------- ペン ----------

  function addPenPoint(p) {
    const a = action;
    if (a.straight) { setLineEnd(a, p); drawStraight(a); return; }
    if (Math.hypot(p.x - a.anchor.x, p.y - a.anchor.y) > HOLD_TOLERANCE) {
      a.anchor = { x: p.x, y: p.y };
      armHold(a);
    }
    const pts = a.stroke.pts;
    const n = pts.length;
    const lx = pts[n - 3], ly = pts[n - 2], lp = pts[n - 1];
    if (Math.hypot(p.x - lx, p.y - ly) < 0.4) return;
    pts.push(p.x, p.y, p.p);
    setLiveTransform(action);
    liveCtx.strokeStyle = a.stroke.c;
    liveCtx.lineCap = 'round';
    liveCtx.lineJoin = 'round';
    liveCtx.lineWidth = widthOf(PEN_WIDTH, (lp + p.p) / 2);
    liveCtx.beginPath();
    liveCtx.moveTo(lx, ly);
    liveCtx.lineTo(p.x, p.y);
    liveCtx.stroke();
  }

  // ---------- 止めると直線 ----------
  // 線を引いたままペンを HOLD_MS 止めると、始点から今の位置までの直線に置き換える。
  // その後はペンを離すまで終点がペンについてくる。

  function armHold(a) {
    clearTimeout(a.holdTimer);
    a.holdTimer = setTimeout(() => tryStraighten(a), HOLD_MS);
  }

  function tryStraighten(a) {
    if (action !== a || a.straight) return;
    const p = a.stroke.pts;
    const n = p.length;
    const sx = p[0], sy = p[1], ex = p[n - 3], ey = p[n - 2];
    const len = Math.hypot(ex - sx, ey - sy);
    if (len < MIN_LINE) return;
    // ぐにゃっとした線(文字や図)は直線にしない
    let dev = 0, pr = 0;
    for (let i = 0; i < n; i += 3) {
      dev = Math.max(dev, distToSeg(p[i], p[i + 1], sx, sy, ex, ey));
      pr += p[i + 2];
    }
    if (dev > Math.max(8, len * 0.15)) return;
    pr = pr / (n / 3);
    a.straight = true;
    a.stroke.pts = [sx, sy, pr, ex, ey, pr];
    setLineEnd(a, { x: ex, y: ey });
    drawStraight(a);
  }

  function setLineEnd(a, p) {
    const pts = a.stroke.pts;
    let x = p.x, y = p.y;
    const deg = Math.abs(Math.atan2(y - pts[1], x - pts[0]) * 180 / Math.PI);
    if (deg < SNAP_DEG || deg > 180 - SNAP_DEG) y = pts[1];          // 水平
    else if (Math.abs(deg - 90) < SNAP_DEG) x = pts[0];              // 垂直
    pts[3] = x;
    pts[4] = y;
  }

  function drawStraight(a) {
    const p = a.stroke.pts;
    clearLive();
    setLiveTransform(a);
    liveCtx.strokeStyle = a.stroke.c;
    liveCtx.lineCap = 'round';
    liveCtx.lineWidth = widthOf(PEN_WIDTH, p[2]);
    liveCtx.beginPath();
    liveCtx.moveTo(p[0], p[1]);
    liveCtx.lineTo(p[3], p[4]);
    liveCtx.stroke();
  }

  function finishStroke(s) {
    s.pts = s.pts.map(r2);
    s.b = strokeBBox(s.pts, s.w).map(r2);
    note.strokes.push(s);
    paintOnTiles(s);
    pushUndo({ type: 'stroke', stroke: s });
    maybeExtend(s.b[3]);
    markDirty();
  }

  // ---------- 消しゴム(触れた線を1本ずつ消す) ----------

  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function hits(s, a, b) {
    const R = ERASER_R + s.w;
    const minX = Math.min(a.x, b.x) - R, maxX = Math.max(a.x, b.x) + R;
    const minY = Math.min(a.y, b.y) - R, maxY = Math.max(a.y, b.y) + R;
    if (s.b[2] < minX || s.b[0] > maxX || s.b[3] < minY || s.b[1] > maxY) return false;
    const p = s.pts;
    for (let i = 0; i < p.length; i += 3) {
      if (distToSeg(p[i], p[i + 1], a.x, a.y, b.x, b.y) <= R) return true;
      if (i >= 3 && distToSeg(b.x, b.y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= R) return true;
    }
    return false;
  }

  function eraseAlong(a, b) {
    for (let i = note.strokes.length - 1; i >= 0; i--) {
      const s = note.strokes[i];
      if (!hits(s, a, b)) continue;
      note.strokes.splice(i, 1);
      action.removed.push({ stroke: s, index: i });
      rerenderRange(s.b[1], s.b[3]);
    }
  }

  function showEraser(p) {
    clearLive();
    setLiveTransform(action);
    liveCtx.strokeStyle = 'rgba(31,42,58,.45)';
    liveCtx.lineWidth = 1.5 / scale;
    liveCtx.beginPath();
    liveCtx.arc(p.x, p.y, ERASER_R, 0, Math.PI * 2);
    liveCtx.stroke();
  }

  function finishErase(a) {
    if (!a.removed.length) return;
    pushUndo({ type: 'erase', items: a.removed });
    markDirty();
  }

  // ---------- あとで確認(囲んでフラグ) ----------

  function drawLasso() {
    const p = action.pts;
    clearLive();
    setLiveTransform(action);
    liveCtx.strokeStyle = '#C99A00';
    liveCtx.lineWidth = 2 / scale;
    liveCtx.setLineDash([8 / scale, 6 / scale]);
    liveCtx.beginPath();
    liveCtx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) liveCtx.lineTo(p[i], p[i + 1]);
    liveCtx.stroke();
    liveCtx.setLineDash([]);
  }

  function finishFlag(a) {
    const p = a.pts;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
      y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
    }
    if (x1 - x0 < MIN_FLAG_SIZE || y1 - y0 < MIN_FLAG_SIZE) return;
    const pad = 6;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(PAGE_W, x1 + pad); y1 = Math.min(note.height, y1 + pad);
    const flag = { id: uid(), x: r2(x0), y: r2(y0), w: r2(x1 - x0), h: r2(y1 - y0), createdAt: Date.now() };
    note.flags.push(flag);
    pushUndo({ type: 'flag', flag });
    renderFlags(flag.id);
    markDirty();
    setTool('pen'); // 囲んだらすぐ書く操作に戻る
  }

  function removeFlag(flag) {
    const index = note.flags.indexOf(flag);
    if (index < 0) return;
    note.flags.splice(index, 1);
    pushUndo({ type: 'unflag', flag, index });
    closePop();
    renderFlags();
    markDirty();
  }

  function renderFlags(pulseId = null) {
    popEl = null;
    flagLayer.textContent = '';
    for (const f of note.flags) {
      const x = f.x * scale, y = f.y * scale, w = f.w * scale, h = f.h * scale;
      const area = document.createElement('div');
      area.className = 'flag-area' + (f.id === pulseId ? ' pulse' : '');
      area.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
      flagLayer.appendChild(area);

      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'flag-badge';
      badge.setAttribute('aria-label', 'あとで確認のフラグ');
      badge.innerHTML = '<span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4h11l-2.5 4L17 12H6"/></svg></span>';
      const bx = Math.min(x + w - 22, sheetW - 46);
      badge.style.left = bx + 'px';
      badge.style.top = Math.max(0, y - 22) + 'px';
      badge.addEventListener('click', () => openPop(f, bx, Math.max(0, y - 22)));
      flagLayer.appendChild(badge);
    }
  }

  function openPop(f, bx, by) {
    closePop();
    popEl = document.createElement('div');
    popEl.className = 'flag-pop';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'フラグを外す';
    btn.addEventListener('click', () => removeFlag(f));
    popEl.appendChild(btn);
    popEl.style.left = Math.max(8, Math.min(bx - 90, sheetW - 170)) + 'px';
    popEl.style.top = by + 48 + 'px';
    flagLayer.appendChild(popEl);
  }

  function closePop() {
    if (popEl) { popEl.remove(); popEl = null; }
  }

  document.addEventListener('pointerdown', (e) => {
    if (popEl && !e.target.closest('.flag-pop, .flag-badge')) closePop();
  }, true);

  function focusFlag(id) {
    const f = note.flags.find((x) => x.id === id);
    if (!f) return;
    const vh = scroller.clientHeight;
    scroller.scrollTop = Math.max(0, f.y * scale - Math.max(40, (vh - f.h * scale) / 2));
    updateTiles();
    renderFlags(f.id);
  }

  // ---------- 道具の切り替え ----------

  function setTool(t) {
    tool = t;
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    hint.hidden = t !== 'flag';
    closePop();
  }
  for (const b of toolButtons) b.addEventListener('click', () => setTool(b.dataset.tool));

  // 色を選ぶとペンに切り替わる
  function setColor(c) {
    color = c;
    for (const b of colorButtons) b.setAttribute('aria-pressed', String(b.dataset.color === c));
    setTool('pen');
  }
  for (const b of colorButtons) b.addEventListener('click', () => setColor(b.dataset.color));

  // ---------- 元に戻す ----------

  function pushUndo(entry) {
    undoStack.push(entry);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    updateUndo();
  }

  function updateUndo() {
    undoBtn.disabled = undoStack.length === 0;
  }

  function undo() {
    const u = undoStack.pop();
    if (!u || !note) return;
    if (u.type === 'stroke') {
      const i = note.strokes.lastIndexOf(u.stroke);
      if (i >= 0) note.strokes.splice(i, 1);
      rerenderRange(u.stroke.b[1], u.stroke.b[3]);
    } else if (u.type === 'erase') {
      for (let k = u.items.length - 1; k >= 0; k--) {
        const { stroke, index } = u.items[k];
        note.strokes.splice(Math.min(index, note.strokes.length), 0, stroke);
        rerenderRange(stroke.b[1], stroke.b[3]);
      }
    } else if (u.type === 'flag') {
      const i = note.flags.indexOf(u.flag);
      if (i >= 0) note.flags.splice(i, 1);
      renderFlags();
    } else if (u.type === 'unflag') {
      note.flags.splice(Math.min(u.index, note.flags.length), 0, u.flag);
      renderFlags(u.flag.id);
    }
    updateUndo();
    markDirty();
  }
  undoBtn.addEventListener('click', undo);

  // ---------- 保存(書くたびに自動) ----------

  function markDirty() {
    note.updatedAt = Date.now();
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 500);
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    const n = note;
    if (!n || !dirty) return;
    dirty = false;
    try {
      await putNote(n);
    } catch (err) {
      dirty = true;
      console.error(err);
      onError('保存できませんでした。iPadの空き容量を確認してください。');
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });
  window.addEventListener('pagehide', flushSave);

  return { open, close };
}
