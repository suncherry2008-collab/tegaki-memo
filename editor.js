// 手書き画面(1ページ分)。どのページを表示するかは app.js が決める。
//
// 入力の扱い:
//   Apple Pencil(pen)・マウス → 書く / 消す / 囲む
//   指(touch)                 → スクロールのみ(書かない)
//
// 描画の仕組み:
//   1枚の巨大なcanvasは使わない(iPadのcanvasサイズ上限対策)。
//   縦 TILE px ごとのcanvas(タイル)を、見えている付近だけ作って描く。
//   書いている最中の線は画面に重ねた live canvas に描き、ペンを離した時点でタイルへ確定する。
//   さらに predict canvas に「最後の点から先読みした位置まで」を仮に描き、ペンとの遅れを小さく見せる。

import { PAGE_W, drawStroke, drawRuled, strokeBBox, widthOf } from './render.js';
import { putPage } from './db.js';

const TILE = 1024;                    // タイルの高さ(CSS px)
const ERASER_R = 12;                  // 消しゴムの半径(ページ座標)
const MIN_FLAG_SIZE = 24;             // これより小さい囲みは無視する
const PALM_RADIUS = 32;               // これより大きい接触は手のひらとみなす(px)
const AFTER_PEN_MS = 500;             // ペンを離した直後の指操作を無視する時間
const UNDO_LIMIT = 100;
const HOLD_MS = 600;                  // 線を引いてこの時間ペンを止めると直線になる
const HOLD_TOLERANCE = 3;             // 「止めている」とみなす揺れの範囲(ページ座標)
const MIN_LINE = 60;                  // これより短い線は直線にしない(文字の画を守るため)
const SNAP_DEG = 4;                   // 水平・垂直からこの角度以内ならぴったり揃える
const PRESSURE_SMOOTH = 0.35;         // 筆圧のなめらかさ(小さいほど太さの変化がなだらか)

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));
const r2 = (v) => Math.round(v * 100) / 100;

export function createEditor(els, { onChange, onError }) {
  const { scroller, sheet, flagLayer, live, predict, undoBtn, hint,
    toolButtons, colorButtons, widthButtons } = els;
  const liveCtx = live.getContext('2d', { desynchronized: true });
  const predCtx = predict.getContext('2d', { desynchronized: true });

  let page = null;
  let scale = 1;
  let dpr = 1;
  let sheetW = 0;
  let sheetH = 0;
  let tool = 'pen';
  let color = colorButtons[0].dataset.color;
  let penW = Number(widthButtons.find((b) => b.getAttribute('aria-pressed') === 'true').dataset.width);
  let undoStack = [];
  let action = null;       // 書いている最中の操作
  let dirty = false;
  let saveTimer = null;
  let penActive = false;
  let lastPenAt = 0;
  let touchBlocked = false;
  let popEl = null;
  let pulseId = null;      // 目立たせるフラグ(一覧から開いたとき・囲んだ直後)
  let pulseTimer = null;
  const tiles = new Map(); // タイル番号 → canvas

  // ---------- 開く・閉じる ----------

  function open(p, { focusFlagId = null } = {}) {
    page = p;
    undoStack = [];
    dirty = false;
    updateUndo();
    closePop();
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
    page = null;
  }

  // ---------- レイアウト ----------

  function layout() {
    if (!page) return;
    const w = scroller.clientWidth;
    if (!w) return;
    const logicalTop = scroller.scrollTop / scale;
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    sheetW = w;
    scale = w / PAGE_W;
    sheetH = Math.round(page.h * scale);
    sheet.style.width = w + 'px';
    sheet.style.height = sheetH + 'px';
    for (const c of [live, predict]) {
      c.width = Math.round(c.clientWidth * dpr);
      c.height = Math.round(c.clientHeight * dpr);
    }
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
    if (!page || !sheetH) return;
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
    for (const s of page.strokes) {
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

  // ---------- 書いている最中の表示 ----------

  function clearCanvas(ctx, c) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
  }
  function clearLive() { clearCanvas(liveCtx, live); clearCanvas(predCtx, predict); }

  function setTransform(ctx, a) {
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * a.ox, dpr * a.oy);
  }

  // ---------- 入力 ----------

  function toPage(e, a) {
    let p = 0.5;
    if (e.pointerType === 'pen') p = e.pressure > 0 ? e.pressure : 0.3;
    return { x: (e.clientX - a.left) / scale, y: (e.clientY - a.top) / scale, p };
  }

  function onPointerDown(e) {
    if (!page || action) return;
    if (e.pointerType === 'touch') return;                 // 指はスクロール用
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.flag-badge, .flag-pop')) return;
    e.preventDefault();
    closePop();
    // 書いている間はスクロールを完全に止める(慣性スクロール中にペンを置いた場合も止まる)
    scroller.style.overflowY = 'hidden';
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
        stroke: { id: uid(), w: penW, c: color, pts: [p.x, p.y, p.p] },
        straight: false, anchor: { x: p.x, y: p.y }, holdTimer: null,
      };
      armHold(action);
      setTransform(liveCtx, action);
      liveCtx.fillStyle = color;
      liveCtx.beginPath();
      liveCtx.arc(p.x, p.y, widthOf(penW, p.p) / 2, 0, Math.PI * 2);
      liveCtx.fill();
    } else if (tool === 'eraser') {
      action = { ...a, kind: 'eraser', ops: [], last: p };
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
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const list = coalesced.length ? coalesced : [e];
    const a = action;
    for (const ev of list) {
      const p = toPage(ev, a);
      if (a.kind === 'pen') addPenPoint(p);
      else if (a.kind === 'eraser') { eraseAlong(a.last, p); a.last = p; }
      else a.pts.push(p.x, p.y);
    }
    if (a.kind === 'pen' && !a.straight) drawTail(a, e);
    if (a.kind === 'eraser') showEraser(a.last);
    if (a.kind === 'flag') drawLasso();
  }

  function onPointerUp(e) {
    if (!action || e.pointerId !== action.id) return;
    const a = action;
    action = null;
    clearTimeout(a.holdTimer);
    penActive = false;
    lastPenAt = performance.now();
    scroller.style.overflowY = '';
    if (a.kind === 'pen') finishStroke(a.stroke);
    else if (a.kind === 'eraser') finishErase(a);
    else finishFlag(a);
    clearLive();
  }

  sheet.addEventListener('pointerdown', onPointerDown);
  sheet.addEventListener('pointermove', onPointerMove);
  sheet.addEventListener('pointerup', onPointerUp);
  sheet.addEventListener('pointercancel', onPointerUp);

  // iPad Safari の誤スクロール・手のひら対策。
  // ペンが触れている/離した直後/手のひらのような大きな接触 のどれかがあった操作は、
  // すべての指が離れるまでスクロールさせない。
  function onTouch(e) {
    if (e.target.closest && e.target.closest('button')) return;
    if (e.type === 'touchstart' && (penActive || performance.now() - lastPenAt < AFTER_PEN_MS)) {
      touchBlocked = true;
    }
    for (const t of e.touches) {
      if (t.touchType === 'stylus' || (t.radiusX || 0) > PALM_RADIUS) touchBlocked = true;
    }
    if (touchBlocked || penActive) e.preventDefault();
  }
  function onTouchEnd(e) {
    if (e.touches.length === 0) touchBlocked = false;
  }
  scroller.addEventListener('touchstart', onTouch, { passive: false });
  scroller.addEventListener('touchmove', onTouch, { passive: false });
  scroller.addEventListener('touchend', onTouchEnd);
  scroller.addEventListener('touchcancel', onTouchEnd);

  // ---------- ペン ----------

  // 最新の点 i が加わったときに、確定した区間(中間点から中間点まで)を描く。
  // render.js の drawStroke と同じ曲線になるようにしている。
  function drawLivePiece(s, i) {
    const p = s.pts;
    const mx = (k) => (p[k * 3] + p[k * 3 + 3]) / 2;
    const my = (k) => (p[k * 3 + 1] + p[k * 3 + 4]) / 2;
    liveCtx.strokeStyle = s.c;
    liveCtx.lineCap = 'round';
    liveCtx.lineJoin = 'round';
    liveCtx.beginPath();
    if (i === 1) {
      liveCtx.lineWidth = widthOf(s.w, p[2]);
      liveCtx.moveTo(p[0], p[1]);
      liveCtx.lineTo(mx(0), my(0));
    } else {
      liveCtx.lineWidth = widthOf(s.w, p[(i - 1) * 3 + 2]);
      liveCtx.moveTo(mx(i - 2), my(i - 2));
      liveCtx.quadraticCurveTo(p[(i - 1) * 3], p[(i - 1) * 3 + 1], mx(i - 1), my(i - 1));
    }
    liveCtx.stroke();
  }

  function addPenPoint(p) {
    const a = action;
    if (a.straight) { setLineEnd(a, p); drawStraight(a); return; }
    if (Math.hypot(p.x - a.anchor.x, p.y - a.anchor.y) > HOLD_TOLERANCE) {
      a.anchor = { x: p.x, y: p.y };
      armHold(a);
    }
    const pts = a.stroke.pts;
    const n = pts.length;
    if (Math.hypot(p.x - pts[n - 3], p.y - pts[n - 2]) < 0.35) return;
    const pr = pts[n - 1] * (1 - PRESSURE_SMOOTH) + p.p * PRESSURE_SMOOTH;
    pts.push(p.x, p.y, pr);
    setTransform(liveCtx, a);
    drawLivePiece(a.stroke, pts.length / 3 - 1);
  }

  // まだ確定していない末尾(最後の中間点 → 最新の点 → 先読み位置)を仮に描く
  function drawTail(a, e) {
    const p = a.stroke.pts;
    const n = p.length / 3;
    clearCanvas(predCtx, predict);
    if (n < 2) return;
    setTransform(predCtx, a);
    predCtx.strokeStyle = a.stroke.c;
    predCtx.lineCap = 'round';
    predCtx.lineJoin = 'round';
    predCtx.lineWidth = widthOf(a.stroke.w, p[n * 3 - 1]);
    predCtx.beginPath();
    predCtx.moveTo((p[(n - 2) * 3] + p[(n - 1) * 3]) / 2, (p[(n - 2) * 3 + 1] + p[(n - 1) * 3 + 1]) / 2);
    predCtx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    const predicted = e.getPredictedEvents ? e.getPredictedEvents() : [];
    for (const ev of predicted) {
      const q = toPage(ev, a);
      predCtx.lineTo(q.x, q.y);
    }
    predCtx.stroke();
  }

  function finishStroke(s) {
    s.pts = s.pts.map(r2);
    s.b = strokeBBox(s.pts, s.w).map(r2);
    page.strokes.push(s);
    paintOnTiles(s);
    pushUndo({ type: 'stroke', stroke: s });
    markDirty();
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
    setTransform(liveCtx, a);
    liveCtx.strokeStyle = a.stroke.c;
    liveCtx.lineCap = 'round';
    liveCtx.lineWidth = widthOf(a.stroke.w, p[2]);
    liveCtx.beginPath();
    liveCtx.moveTo(p[0], p[1]);
    liveCtx.lineTo(p[3], p[4]);
    liveCtx.stroke();
  }

  // ---------- 消しゴム(こすったところだけ消える) ----------

  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function hits(s, a, b) {
    const R = ERASER_R + s.w / 2;
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

  // 点の間隔が step より広いところに点を補って、部分的に消せるようにする
  function densify(pts, step) {
    const out = [pts[0], pts[1], pts[2]];
    for (let i = 3; i < pts.length; i += 3) {
      const x0 = pts[i - 3], y0 = pts[i - 2], p0 = pts[i - 1];
      const x1 = pts[i], y1 = pts[i + 1], p1 = pts[i + 2];
      const k = Math.floor(Math.hypot(x1 - x0, y1 - y0) / step);
      for (let j = 1; j <= k; j++) {
        const t = j / (k + 1);
        out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t);
      }
      out.push(x1, y1, p1);
    }
    return out;
  }

  // 消しゴムが触れた部分を取り除き、残りの部分を別々の線として返す。触れていなければ null。
  function cut(s, a, b) {
    const R = ERASER_R + s.w / 2;
    const src = densify(s.pts, 1.5);
    const pieces = [];
    let cur = [];
    let removed = false;
    for (let i = 0; i < src.length; i += 3) {
      if (distToSeg(src[i], src[i + 1], a.x, a.y, b.x, b.y) <= R) {
        removed = true;
        if (cur.length >= 6) pieces.push(cur);
        cur = [];
      } else {
        cur.push(src[i], src[i + 1], src[i + 2]);
      }
    }
    if (!removed) return null;
    if (cur.length >= 6) pieces.push(cur);
    return pieces;
  }

  function eraseAlong(a, b) {
    let top = Infinity, bottom = -Infinity;
    for (let i = page.strokes.length - 1; i >= 0; i--) {
      const s = page.strokes[i];
      if (!hits(s, a, b)) continue;
      const pieces = cut(s, a, b);
      if (!pieces) continue;
      const added = pieces.map((pts) => {
        const ns = { id: uid(), w: s.w, pts: pts.map(r2) };
        if (s.c) ns.c = s.c;
        ns.b = strokeBBox(ns.pts, ns.w).map(r2);
        return ns;
      });
      page.strokes.splice(i, 1, ...added);
      action.ops.push({ index: i, removed: s, added });
      top = Math.min(top, s.b[1]);
      bottom = Math.max(bottom, s.b[3]);
    }
    if (bottom >= top) rerenderRange(top, bottom);
  }

  function showEraser(p) {
    clearCanvas(liveCtx, live);
    setTransform(liveCtx, action);
    liveCtx.strokeStyle = 'rgba(31,42,58,.5)';
    liveCtx.fillStyle = 'rgba(31,42,58,.06)';
    liveCtx.lineWidth = 1.5 / scale;
    liveCtx.beginPath();
    liveCtx.arc(p.x, p.y, ERASER_R, 0, Math.PI * 2);
    liveCtx.fill();
    liveCtx.stroke();
  }

  function finishErase(a) {
    if (!a.ops.length) return;
    pushUndo({ type: 'erase', ops: a.ops });
    markDirty();
  }

  // ---------- あとで確認(囲んでフラグ) ----------

  function drawLasso() {
    const p = action.pts;
    clearCanvas(liveCtx, live);
    setTransform(liveCtx, action);
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
    x1 = Math.min(PAGE_W, x1 + pad); y1 = Math.min(page.h, y1 + pad);
    const flag = { id: uid(), x: r2(x0), y: r2(y0), w: r2(x1 - x0), h: r2(y1 - y0), createdAt: Date.now() };
    page.flags.push(flag);
    pushUndo({ type: 'flag', flag });
    pulse(flag.id);
    renderFlags();
    markDirty();
    setTool('pen'); // 囲んだらすぐ書く操作に戻る
  }

  function removeFlag(flag) {
    const index = page.flags.indexOf(flag);
    if (index < 0) return;
    page.flags.splice(index, 1);
    pushUndo({ type: 'unflag', flag, index });
    closePop();
    renderFlags();
    markDirty();
  }

  function pulse(id) {
    pulseId = id;
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => { pulseId = null; }, 1200);
  }

  function renderFlags() {
    popEl = null;
    flagLayer.textContent = '';
    for (const f of page.flags) {
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
    const f = page.flags.find((x) => x.id === id);
    if (!f) return;
    const vh = scroller.clientHeight;
    scroller.scrollTop = Math.max(0, f.y * scale - Math.max(40, (vh - f.h * scale) / 2));
    updateTiles();
    pulse(f.id);
    renderFlags();
  }

  // ---------- 道具・色・太さ ----------

  function setTool(t) {
    tool = t;
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    hint.hidden = t !== 'flag';
    closePop();
  }
  for (const b of toolButtons) b.addEventListener('click', () => setTool(b.dataset.tool));

  // 色や太さを選ぶとペンに切り替わる
  function setColor(c) {
    color = c;
    for (const b of colorButtons) b.setAttribute('aria-pressed', String(b.dataset.color === c));
    setTool('pen');
  }
  for (const b of colorButtons) b.addEventListener('click', () => setColor(b.dataset.color));

  function setWidth(w) {
    penW = w;
    for (const b of widthButtons) b.setAttribute('aria-pressed', String(Number(b.dataset.width) === w));
    setTool('pen');
  }
  for (const b of widthButtons) b.addEventListener('click', () => setWidth(Number(b.dataset.width)));

  // ---------- 元に戻す(開いているページの中だけ) ----------

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
    if (!u || !page) return;
    if (u.type === 'stroke') {
      const i = page.strokes.lastIndexOf(u.stroke);
      if (i >= 0) page.strokes.splice(i, 1);
      rerenderRange(u.stroke.b[1], u.stroke.b[3]);
    } else if (u.type === 'erase') {
      for (let k = u.ops.length - 1; k >= 0; k--) {
        const op = u.ops[k];
        for (const s of op.added) {
          const i = page.strokes.indexOf(s);
          if (i >= 0) page.strokes.splice(i, 1);
        }
        page.strokes.splice(Math.min(op.index, page.strokes.length), 0, op.removed);
        rerenderRange(op.removed.b[1], op.removed.b[3]);
      }
    } else if (u.type === 'flag') {
      const i = page.flags.indexOf(u.flag);
      if (i >= 0) page.flags.splice(i, 1);
      renderFlags();
    } else if (u.type === 'unflag') {
      page.flags.splice(Math.min(u.index, page.flags.length), 0, u.flag);
      pulse(u.flag.id);
      renderFlags();
    }
    updateUndo();
    markDirty();
  }
  undoBtn.addEventListener('click', undo);

  // ---------- 保存(書くたびに自動) ----------

  function markDirty() {
    page.updatedAt = Date.now();
    dirty = true;
    onChange(page);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 500);
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    const p = page;
    if (!p || !dirty) return;
    dirty = false;
    try {
      await putPage(p);
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

  return { open, close, flush: flushSave };
}
