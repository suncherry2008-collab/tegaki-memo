// 手書き画面(1ページ分)。どのページを表示するかは app.js が決める。
//
// 入力の扱い:
//   Apple Pencil(pen)・マウス → 書く / 蛍光ペン / 消す / 囲む
//   指1本                      → スクロール
//   指2本                      → ピンチで縮小・拡大(1ページ全体表示 〜 3倍)
//
// 描画の仕組み:
//   1枚の巨大なcanvasは使わない(iPadのcanvasサイズ・メモリ上限対策)。
//   ページを TILE px 四方のマス目に分け、見えている付近のマスだけcanvasを作って描く。
//   書いている最中の線は画面に重ねた live canvas に描き、ペンを離した時点でマスへ確定する。
//   さらに predict canvas に「最後の点から先読みした位置まで」を仮に描き、ペンとの遅れを小さく見せる。

import { PAGE_W, drawStroke, drawStrokesIn, drawRuled, strokeBBox, strokeWidth } from './render.js';
import { putPage } from './db.js';

const TILE = 512;                     // マス目の大きさ(CSS px)
const MAX_ZOOM = 3;                   // 拡大の上限(等倍 = 画面の横幅にページがぴったり)
const SNAP_ZOOM = 0.08;               // 等倍からこの範囲で指を離すと等倍に戻す
const MARKER_W = 24;                  // 蛍光ペンの太さ(ページ座標)
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
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function createEditor(els, { onChange, onError }) {
  const { toolbar, scroller, sheet, flagLayer, live, predict, undoBtn, hint,
    toolButtons, colorButtons, widthButtons, markerButtons,
    eraserMenu, eraserButtons, eraserLabel } = els;
  const liveCtx = live.getContext('2d', { desynchronized: true });
  const predCtx = predict.getContext('2d', { desynchronized: true });

  let page = null;
  let zoom = 1;
  let minZoom = 1;
  let scale = 1;           // ページ座標 → CSS px
  let dpr = 1;
  let sheetW = 0;
  let sheetH = 0;
  let tool = 'pen';        // pen / marker / eraser / flag
  let color = colorButtons[0].dataset.color;
  let markerColor = markerButtons[0].dataset.color;
  let penW = Number(widthButtons.find((b) => b.getAttribute('aria-pressed') === 'true').dataset.width);
  let eraserMode = 'partial'; // partial = こすった部分だけ / stroke = 線を1本まるごと
  let undoStack = [];
  let action = null;       // 書いている最中の操作
  let pinch = null;        // ピンチ操作中の状態
  let dirty = false;
  let saveTimer = null;
  let penActive = false;
  let lastPenAt = 0;
  let touchBlocked = false;
  let popEl = null;
  let pulseId = null;      // 目立たせるフラグ(一覧から開いたとき・囲んだ直後)
  let pulseTimer = null;
  const tiles = new Map(); // 'row,col' → canvas

  // ---------- 開く・閉じる ----------

  // keepZoom: 同じ日の中でページを切り替えたときは倍率を保つ
  function open(p, { focusFlagId = null, keepZoom = false } = {}) {
    page = p;
    undoStack = [];
    dirty = false;
    updateUndo();
    closePop();
    closeEraserMenu();
    clearTiles();
    if (!keepZoom) zoom = 1;
    layout({ px: 0, py: 0, vx: 0, vy: 0 });
    if (focusFlagId) focusFlag(focusFlagId);
  }

  async function close() {
    await flushSave();
    closePop();
    closeEraserMenu();
    clearTiles();
    clearLive();
    page = null;
  }

  // ---------- レイアウト(倍率・大きさ・スクロール位置) ----------

  // anchor: ページ上の点 (px, py) を、画面上の位置 (vx, vy)(スクロール領域の左上から)に合わせる。
  // 省略時は、今見ている位置(横は中央、縦は上端)を保つ。
  function layout(anchor) {
    if (!page) return;
    const cw = scroller.clientWidth;
    const ch = scroller.clientHeight;
    if (!cw) return;
    if (!anchor && scale) {
      anchor = {
        px: (scroller.scrollLeft + cw / 2 - sheet.offsetLeft) / scale,
        py: (scroller.scrollTop - sheet.offsetTop) / scale,
        vx: cw / 2, vy: 0,
      };
    }
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    const base = cw / PAGE_W;
    minZoom = Math.min(1, (ch - 24) / (page.h * base)); // 1ページ全体が収まる倍率
    zoom = clamp(zoom, minZoom, MAX_ZOOM);
    scale = base * zoom;
    sheetW = Math.round(PAGE_W * scale);
    sheetH = Math.round(page.h * scale);
    sheet.style.width = sheetW + 'px';
    sheet.style.height = sheetH + 'px';
    sheet.style.margin = zoom < 1 ? '12px auto' : '0 auto';
    for (const c of [live, predict]) {
      c.width = Math.round(c.clientWidth * dpr);
      c.height = Math.round(c.clientHeight * dpr);
    }
    clearTiles();
    renderFlags();
    if (anchor) {
      scroller.scrollLeft = sheet.offsetLeft + anchor.px * scale - anchor.vx;
      scroller.scrollTop = sheet.offsetTop + anchor.py * scale - anchor.vy;
    }
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

  // ---------- マス目(タイル) ----------

  function clearTiles() {
    for (const c of tiles.values()) { c.width = 0; c.height = 0; c.remove(); }
    tiles.clear();
  }

  function updateTiles() {
    if (!page || !sheetH || pinch) return;
    const x0 = scroller.scrollLeft - sheet.offsetLeft;
    const y0 = scroller.scrollTop - sheet.offsetTop;
    const cols = Math.ceil(sheetW / TILE);
    const rows = Math.ceil(sheetH / TILE);
    const c0 = clamp(Math.floor(x0 / TILE), 0, cols - 1);
    const c1 = clamp(Math.floor((x0 + scroller.clientWidth) / TILE), 0, cols - 1);
    const r0 = clamp(Math.floor(y0 / TILE) - 1, 0, rows - 1);
    const r1 = clamp(Math.floor((y0 + scroller.clientHeight) / TILE) + 1, 0, rows - 1);
    for (const [key, c] of tiles) {
      const [r, col] = key.split(',').map(Number);
      if (r < r0 || r > r1 || col < c0 || col > c1) { c.width = 0; c.height = 0; c.remove(); tiles.delete(key); }
    }
    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        const key = r + ',' + col;
        if (tiles.has(key)) continue;
        const c = document.createElement('canvas');
        c.className = 'tile';
        c.dataset.r = r;
        c.dataset.c = col;
        sheet.insertBefore(c, flagLayer);
        tiles.set(key, c);
        renderTile(c);
      }
    }
  }

  function tileContext(c) {
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, -dpr * c.dataset.c * TILE, -dpr * c.dataset.r * TILE);
    return ctx;
  }

  // マスが受け持つ範囲(ページ座標)[x0, y0, x1, y1]
  function tileRect(c) {
    const x = c.dataset.c * TILE, y = c.dataset.r * TILE;
    return [x / scale, y / scale, (x + TILE) / scale, (y + TILE) / scale];
  }

  function renderTile(c) {
    const x = c.dataset.c * TILE, y = c.dataset.r * TILE;
    const w = Math.min(TILE, sheetW - x), h = Math.min(TILE, sheetH - y);
    c.style.left = x + 'px';
    c.style.top = y + 'px';
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = tileContext(c);
    const [x0, y0, x1, y1] = tileRect(c);
    drawRuled(ctx, y0, y1, scale);
    drawStrokesIn(ctx, page.strokes, x0, y0, x1, y1);
  }

  const overlaps = (b, t) => b[2] >= t[0] && b[0] <= t[2] && b[3] >= t[1] && b[1] <= t[3];

  function paintOnTiles(s) {
    for (const c of tiles.values()) if (overlaps(s.b, tileRect(c))) drawStroke(tileContext(c), s);
  }

  function rerenderRect(b) {
    for (const c of tiles.values()) if (overlaps(b, tileRect(c))) renderTile(c);
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

  // ---------- 入力(ペン) ----------

  function toPage(e, a) {
    let p = 0.5;
    if (e.pointerType === 'pen') p = e.pressure > 0 ? e.pressure : 0.3;
    return { x: (e.clientX - a.left) / scale, y: (e.clientY - a.top) / scale, p };
  }

  function onPointerDown(e) {
    if (!page || action || pinch) return;
    if (e.pointerType === 'touch') return;                 // 指はスクロール・ピンチ用
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.flag-badge, .flag-pop')) return;
    e.preventDefault();
    closePop();
    closeEraserMenu();
    // 書いている間はスクロールを完全に止める(慣性スクロール中にペンを置いた場合も止まる)
    scroller.style.overflow = 'hidden';
    sheet.setPointerCapture(e.pointerId);
    penActive = e.pointerType === 'pen';
    lastPenAt = performance.now();

    const sr = sheet.getBoundingClientRect();
    const lr = live.getBoundingClientRect();
    const a = { id: e.pointerId, left: sr.left, top: sr.top, ox: sr.left - lr.left, oy: sr.top - lr.top };
    const p = toPage(e, a);

    if (tool === 'pen' || tool === 'marker') {
      const marker = tool === 'marker';
      if (marker) p.p = 0.5;
      const stroke = marker
        ? { id: uid(), w: MARKER_W, c: markerColor, hl: 1, pts: [p.x, p.y, p.p] }
        : { id: uid(), w: penW, c: color, pts: [p.x, p.y, p.p] };
      action = { ...a, kind: 'pen', stroke, straight: false, anchor: { x: p.x, y: p.y }, holdTimer: null };
      if (marker) live.style.mixBlendMode = 'multiply'; // 書いている最中も文字が透けて見えるように
      armHold(action);
      setTransform(liveCtx, action);
      liveCtx.fillStyle = stroke.c;
      liveCtx.beginPath();
      liveCtx.arc(p.x, p.y, strokeWidth(stroke, p.p) / 2, 0, Math.PI * 2);
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
    scroller.style.overflow = '';
    if (a.kind === 'pen') finishStroke(a.stroke);
    else if (a.kind === 'eraser') finishErase(a);
    else finishFlag(a);
    clearLive();
    live.style.mixBlendMode = '';
  }

  sheet.addEventListener('pointerdown', onPointerDown);
  sheet.addEventListener('pointermove', onPointerMove);
  sheet.addEventListener('pointerup', onPointerUp);
  sheet.addEventListener('pointercancel', onPointerUp);

  // ---------- 入力(指):誤スクロール・手のひら対策とピンチ ----------
  // ペンが触れている/離した直後/手のひらのような大きな接触 のどれかがあった操作は、
  // すべての指が離れるまでスクロールもピンチもさせない。

  function onTouch(e) {
    if (e.target.closest && e.target.closest('button')) return;
    if (e.type === 'touchstart' && (penActive || performance.now() - lastPenAt < AFTER_PEN_MS)) {
      touchBlocked = true;
    }
    for (const t of e.touches) {
      if (t.touchType === 'stylus' || (t.radiusX || 0) > PALM_RADIUS) touchBlocked = true;
    }
    if (!touchBlocked && !penActive && !action && e.touches.length === 2) {
      e.preventDefault();
      if (!pinch) startPinch(e.touches);
      else movePinch(e.touches);
      return;
    }
    if (pinch) endPinch();
    if (touchBlocked || penActive) e.preventDefault();
  }
  function onTouchEnd(e) {
    if (pinch && e.touches.length < 2) endPinch();
    if (e.touches.length === 0) touchBlocked = false;
  }
  scroller.addEventListener('touchstart', onTouch, { passive: false });
  scroller.addEventListener('touchmove', onTouch, { passive: false });
  scroller.addEventListener('touchend', onTouchEnd);
  scroller.addEventListener('touchcancel', onTouchEnd);

  // ピンチ中は見た目だけ拡大縮小(CSS)し、指を離したときにその倍率で描き直す
  function startPinch(ts) {
    const [a, b] = ts;
    const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
    const sr = sheet.getBoundingClientRect();
    closePop();
    closeEraserMenu();
    pinch = {
      d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
      z0: zoom, k: 1, mx0: mx, my0: my, mx, my,
      px: (mx - sr.left) / scale, py: (my - sr.top) / scale,
    };
    sheet.style.transformOrigin = `${mx - sr.left}px ${my - sr.top}px`;
  }

  function movePinch(ts) {
    const [a, b] = ts;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    pinch.mx = (a.clientX + b.clientX) / 2;
    pinch.my = (a.clientY + b.clientY) / 2;
    pinch.k = clamp(pinch.z0 * d / pinch.d0, minZoom, MAX_ZOOM) / pinch.z0;
    sheet.style.transform = `translate(${pinch.mx - pinch.mx0}px, ${pinch.my - pinch.my0}px) scale(${pinch.k})`;
  }

  function endPinch() {
    const p = pinch;
    pinch = null;
    sheet.style.transform = '';
    sheet.style.transformOrigin = '';
    let z = p.z0 * p.k;
    if (Math.abs(z - 1) < SNAP_ZOOM) z = 1;
    zoom = z;
    const sr = scroller.getBoundingClientRect();
    layout({ px: p.px, py: p.py, vx: p.mx - sr.left, vy: p.my - sr.top });
  }

  // ---------- ペン・蛍光ペン ----------

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
      liveCtx.lineWidth = strokeWidth(s, p[2]);
      liveCtx.moveTo(p[0], p[1]);
      liveCtx.lineTo(mx(0), my(0));
    } else {
      liveCtx.lineWidth = strokeWidth(s, p[(i - 1) * 3 + 2]);
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
    const pr = a.stroke.hl ? 0.5 : pts[n - 1] * (1 - PRESSURE_SMOOTH) + p.p * PRESSURE_SMOOTH;
    pts.push(p.x, p.y, pr);
    setTransform(liveCtx, a);
    drawLivePiece(a.stroke, pts.length / 3 - 1);
  }

  // まだ確定していない末尾(最後の中間点 → 最新の点 → 先読み位置)を仮に描く
  function drawTail(a, e) {
    const s = a.stroke;
    const p = s.pts;
    const n = p.length / 3;
    clearCanvas(predCtx, predict);
    if (n < 2) return;
    setTransform(predCtx, a);
    predCtx.globalAlpha = s.hl ? 0.6 : 1;
    predCtx.strokeStyle = s.c;
    predCtx.lineCap = 'round';
    predCtx.lineJoin = 'round';
    predCtx.lineWidth = strokeWidth(s, p[n * 3 - 1]);
    predCtx.beginPath();
    predCtx.moveTo((p[(n - 2) * 3] + p[(n - 1) * 3]) / 2, (p[(n - 2) * 3 + 1] + p[(n - 1) * 3 + 1]) / 2);
    predCtx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    const predicted = e.getPredictedEvents ? e.getPredictedEvents() : [];
    for (const ev of predicted) {
      const q = toPage(ev, a);
      predCtx.lineTo(q.x, q.y);
    }
    predCtx.stroke();
    predCtx.globalAlpha = 1;
  }

  function finishStroke(s) {
    s.pts = s.pts.map(r2);
    s.b = strokeBBox(s.pts, s.w).map(r2);
    page.strokes.push(s);
    if (s.hl) rerenderRect(s.b);   // 蛍光ペンは文字の下に来るよう、その範囲を描き直す
    else paintOnTiles(s);
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
    const s = a.stroke;
    const p = s.pts;
    clearLive();
    setTransform(liveCtx, a);
    liveCtx.strokeStyle = s.c;
    liveCtx.lineCap = 'round';
    liveCtx.lineWidth = strokeWidth(s, p[2]);
    liveCtx.beginPath();
    liveCtx.moveTo(p[0], p[1]);
    liveCtx.lineTo(p[3], p[4]);
    liveCtx.stroke();
  }

  // ---------- 消しゴム(部分消し / 線ごと消す) ----------

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
    const dirtyRect = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = page.strokes.length - 1; i >= 0; i--) {
      const s = page.strokes[i];
      if (!hits(s, a, b)) continue;
      let added = [];
      if (eraserMode === 'partial') {
        const pieces = cut(s, a, b);
        if (!pieces) continue;
        added = pieces.map((pts) => {
          const ns = { id: uid(), w: s.w, pts: pts.map(r2) };
          if (s.c) ns.c = s.c;
          if (s.hl) ns.hl = 1;
          ns.b = strokeBBox(ns.pts, ns.w).map(r2);
          return ns;
        });
      }
      page.strokes.splice(i, 1, ...added);
      action.ops.push({ index: i, removed: s, added });
      dirtyRect[0] = Math.min(dirtyRect[0], s.b[0]);
      dirtyRect[1] = Math.min(dirtyRect[1], s.b[1]);
      dirtyRect[2] = Math.max(dirtyRect[2], s.b[2]);
      dirtyRect[3] = Math.max(dirtyRect[3], s.b[3]);
    }
    if (dirtyRect[2] >= dirtyRect[0]) rerenderRect(dirtyRect);
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

  // 消しゴムの種類メニュー(消しゴムを選んだ状態でもう一度タップすると開く)
  function openEraserMenu() {
    const btn = toolButtons.find((b) => b.dataset.tool === 'eraser');
    const r = btn.getBoundingClientRect();
    eraserMenu.hidden = false;
    eraserMenu.style.top = r.bottom + 6 + 'px';
    eraserMenu.style.left = Math.max(8, Math.min(r.left + r.width / 2 - eraserMenu.offsetWidth / 2,
      window.innerWidth - eraserMenu.offsetWidth - 8)) + 'px';
  }
  function closeEraserMenu() { eraserMenu.hidden = true; }

  function setEraserMode(m) {
    eraserMode = m;
    for (const b of eraserButtons) b.setAttribute('aria-pressed', String(b.dataset.eraser === m));
    eraserLabel.textContent = m === 'partial' ? '部分消し' : '線ごと消す';
    closeEraserMenu();
  }
  for (const b of eraserButtons) b.addEventListener('click', () => setEraserMode(b.dataset.eraser));

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
    if (!eraserMenu.hidden && !e.target.closest('.eraser-menu, [data-tool="eraser"]')) closeEraserMenu();
  }, true);

  function focusFlag(id) {
    const f = page.flags.find((x) => x.id === id);
    if (!f) return;
    const vh = scroller.clientHeight;
    scroller.scrollTop = sheet.offsetTop + f.y * scale - Math.max(40, (vh - f.h * scale) / 2);
    scroller.scrollLeft = sheet.offsetLeft + f.x * scale - 40;
    updateTiles();
    pulse(f.id);
    renderFlags();
  }

  // ---------- 道具・色・太さ ----------

  function setTool(t) {
    if (t === 'eraser' && tool === 'eraser') {   // 消しゴムをもう一度タップ → 種類を選ぶ
      if (eraserMenu.hidden) openEraserMenu(); else closeEraserMenu();
      return;
    }
    tool = t;
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    // 左の「色・太さ」の枠は、最後に使ったペン(ペン/蛍光ペン)のものを表示する
    if (t === 'pen' || t === 'marker') toolbar.dataset.palette = t;
    hint.hidden = t !== 'flag';
    closePop();
    closeEraserMenu();
  }
  for (const b of toolButtons) b.addEventListener('click', () => setTool(b.dataset.tool));

  // 色や太さを選ぶと、そのペンに切り替わる
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

  function setMarkerColor(c) {
    markerColor = c;
    for (const b of markerButtons) b.setAttribute('aria-pressed', String(b.dataset.color === c));
    setTool('marker');
  }
  for (const b of markerButtons) b.addEventListener('click', () => setMarkerColor(b.dataset.color));

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
      rerenderRect(u.stroke.b);
    } else if (u.type === 'erase') {
      for (let k = u.ops.length - 1; k >= 0; k--) {
        const op = u.ops[k];
        for (const s of op.added) {
          const i = page.strokes.indexOf(s);
          if (i >= 0) page.strokes.splice(i, 1);
        }
        page.strokes.splice(Math.min(op.index, page.strokes.length), 0, op.removed);
        rerenderRect(op.removed.b);
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
