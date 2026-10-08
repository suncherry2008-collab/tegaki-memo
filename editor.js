// 手書き画面(1ページ分)。どのページを表示するかは app.js が決める。
//
// 入力の扱い:
//   Apple Pencil(pen)・マウス → 書く / 蛍光ペン / 消す / 選択(囲んで移動・削除)/ 囲んでフラグ
//   指1本                      → スクロール(慣性つき)
//   指2本                      → ピンチで縮小・拡大(1ページ全体表示 〜 3倍)+移動
//   スクロールとピンチはブラウザに任せず、すべてここで処理する(touch-action: none)。
//   ブラウザ任せだと、iPad Safari ではペンの線が途中で打ち切られたり、ピンチに切り替わらなかったりするため。
//
// 描画の仕組み:
//   1枚の巨大なcanvasは使わない(iPadのcanvasサイズ・メモリ上限対策)。
//   ページを TILE px 四方のマス目に分け、見えている付近のマスだけcanvasを作って描く。
//   書いている最中の線は画面に重ねた live canvas に描き、ペンを離した時点でマスへ確定する。
//   さらに predict canvas に「最後の点から先読みした位置まで」を仮に描き、ペンとの遅れを小さく見せる。

import { PAGE_W, drawStroke, drawStrokesIn, drawBackground, strokeBBox, strokeWidth } from './render.js';
import { putPage } from './db.js';

const TILE = 512;                     // マス目の大きさ(CSS px)
const MAX_ZOOM = 3;                   // 拡大の上限(等倍 = 画面の横幅にページがぴったり)
const SNAP_ZOOM = 0.08;               // 等倍からこの範囲で指を離すと等倍に戻す
const MARKER_W = 24;                  // 蛍光ペンの太さ(ページ座標)
const ERASER_R = 12;                  // 消しゴムの半径(ページ座標)
const MIN_FLAG_SIZE = 24;             // これより小さい囲みは無視する
const PALM_RADIUS = 48;               // 指を置いた瞬間の接触がこれより大きければ手のひらとみなす(px)
const PAN_START = 8;                  // 指がこれ以上動いたらスクロールを始める(px)。手のひらの小さなずれでは動かさない
const FRICTION = 0.94;                // 慣性スクロールの減速(1フレームあたり)
const AFTER_PEN_MS = 500;             // ペンを離した直後の指操作を無視する時間
const UNDO_LIMIT = 100;
const HOLD_MS = 600;                  // 線を引いてこの時間ペンを止めると直線になる
const HOLD_TOLERANCE = 3;             // 「止めている」とみなす揺れの範囲(ページ座標)
const MIN_LINE = 60;                  // これより短い線は直線にしない(文字の画を守るため)
const SNAP_DEG = 4;                   // 水平・垂直からこの角度以内ならぴったり揃える
const PRESSURE_SMOOTH = 0.3;          // 筆圧のなめらかさ(小さいほど太さの変化がなだらか)
const SMOOTH_MIN = 0.5;               // 手ぶれ補正の強さ(ゆっくり書くとき)。1で補正なし。小さいほど強い
const SMOOTH_SPEED = 0.6;             // この速さ(ページ座標/ms)以上で書くと補正なし(遅れを出さないため)

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
  let tool = 'pen';        // pen / marker / eraser / select / flag
  let prevTool = 'pen';    // 消しゴムで消し終わったら戻る道具
  let sel = null;          // 選択中の線 { strokes: [...] }
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
    sel = null;
    clearTiles();
    if (!keepZoom) zoom = 1;
    layout({ px: 0, py: 0, vx: 0, vy: 0 });
    if (focusFlagId) focusFlag(focusFlagId);
  }

  async function close() {
    await flushSave();
    closePop();
    closeEraserMenu();
    clearSelection();
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
    renderSelection();
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
    drawBackground(ctx, page.bg, x0, y0, x1, y1, scale);
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
    if (e.target.closest('.flag-badge, .flag-pop, .sel-bar')) return;
    e.preventDefault();
    closePop();
    closeEraserMenu();
    stopInertia(); // 慣性スクロール中にペンを置いたら止める
    endTouchGesture();
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
      action = {
        ...a, kind: 'pen', stroke, straight: false, anchor: { x: p.x, y: p.y }, holdTimer: null,
        sm: { x: p.x, y: p.y, t: e.timeStamp }, raw: p,
      };
      if (marker) live.style.mixBlendMode = 'multiply'; // 書いている最中も文字が透けて見えるように
      armHold(action);
      redrawLive(action);
    } else if (tool === 'eraser') {
      action = { ...a, kind: 'eraser', ops: [], last: p };
      eraseAlong(p, p);
      showEraser(p);
    } else if (tool === 'select') {
      if (sel && insideSelection(p)) {
        startMove(a, p);
      } else {
        clearSelection();
        action = { ...a, kind: 'lasso', pts: [p.x, p.y] };
      }
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
      if (a.kind === 'pen') addPenPoint(smooth(a, p, ev.timeStamp));
      else if (a.kind === 'eraser') { eraseAlong(a.last, p); a.last = p; }
      else if (a.kind === 'move') a.cur = p;
      else a.pts.push(p.x, p.y);
    }
    if (a.kind === 'pen' && !a.straight) { redrawLive(a); drawTail(a, e); }
    if (a.kind === 'eraser') showEraser(a.last);
    if (a.kind === 'flag') drawLasso('#C99A00');
    if (a.kind === 'lasso') drawLasso('#5B6B82');
    if (a.kind === 'move') drawMove(a);
  }

  function onPointerUp(e) {
    if (!action || e.pointerId !== action.id) return;
    const a = action;
    // 手ぶれ補正で少し手前に残った線を、ペンを離した位置まで届かせる
    if (a.kind === 'pen' && !a.straight) addPenPoint({ x: a.raw.x, y: a.raw.y, p: a.raw.p });
    action = null;
    clearTimeout(a.holdTimer);
    penActive = false;
    lastPenAt = performance.now();
    clearLive();
    live.style.mixBlendMode = '';
    if (a.kind === 'pen') finishStroke(a.stroke);
    else if (a.kind === 'eraser') { finishErase(a); setTool(prevTool); } // 消し終わったら前の道具に戻る
    else if (a.kind === 'lasso') finishLasso(a);
    else if (a.kind === 'move') finishMove(a);
    else finishFlag(a);
  }

  // 手ぶれ補正:ゆっくり書くときは少しなめらかに、速く書くときはそのまま(遅れを出さない)
  function smooth(a, p, t) {
    a.raw = p;
    const sm = a.sm;
    const dt = Math.max(1, t - sm.t);
    const speed = Math.hypot(p.x - sm.x, p.y - sm.y) / dt;
    const k = Math.min(1, SMOOTH_MIN + (1 - SMOOTH_MIN) * speed / SMOOTH_SPEED);
    sm.x += (p.x - sm.x) * k;
    sm.y += (p.y - sm.y) * k;
    sm.t = t;
    return { x: sm.x, y: sm.y, p: p.p };
  }

  sheet.addEventListener('pointerdown', onPointerDown);
  sheet.addEventListener('pointermove', onPointerMove);
  sheet.addEventListener('pointerup', onPointerUp);
  sheet.addEventListener('pointercancel', onPointerUp);

  // ---------- 入力(指):スクロール・ピンチ・手のひら対策 ----------
  // 次のどれかに当てはまる操作は、すべての指が離れるまで無視する(誤スクロール・誤ピンチ防止)。
  //   ペンが触れている / ペンを離した直後 / 指を置いた瞬間の接触が手のひらのように大きい / Apple Pencil の接触

  let gesture = null;      // { kind: 'wait' | 'pan' | 'ignore', ... }
  let inertia = 0;         // 慣性スクロールの requestAnimationFrame 番号

  function stopInertia() {
    if (inertia) cancelAnimationFrame(inertia);
    inertia = 0;
  }

  function endTouchGesture() {
    if (pinch) endPinch();
    if (gesture && gesture.kind !== 'ignore') gesture = { kind: 'ignore' };
  }

  const fingers = (e) => [...e.touches].filter((t) => t.touchType !== 'stylus');

  function onTouchStart(e) {
    if (e.target.closest && e.target.closest('button')) return; // フラグの丸などのボタンはそのまま押せる
    stopInertia();
    const stylus = [...e.changedTouches].some((t) => t.touchType === 'stylus');
    const palm = [...e.changedTouches].some((t) => (t.radiusX || 0) > PALM_RADIUS);
    // 画面に触れている指がすべて今置かれたもの = 新しい操作の始まり。前の操作の状態は持ち越さない
    if (e.touches.length === e.changedTouches.length) {
      if (pinch) endPinch();
      gesture = null;
    }
    if (stylus || palm || penActive || action || performance.now() - lastPenAt < AFTER_PEN_MS) {
      if (pinch) endPinch();
      gesture = { kind: 'ignore' };
      return;
    }
    if (gesture && gesture.kind === 'ignore') return;
    const fs = fingers(e);
    if (fs.length === 2) {
      gesture = null;
      startPinch(fs);
    } else if (fs.length === 1 && !pinch) {
      const t = fs[0];
      gesture = { kind: 'wait', x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, hist: [] };
    } else if (fs.length > 2) {
      if (pinch) endPinch();
      gesture = { kind: 'ignore' };
    }
  }

  function onTouchMove(e) {
    if (e.cancelable) e.preventDefault();
    if (penActive || action) return;
    if (pinch) {
      const fs = fingers(e);
      if (fs.length >= 2) movePinch(fs);
      return;
    }
    if (!gesture || gesture.kind === 'ignore') return;
    const t = fingers(e)[0];
    if (!t) return;
    const g = gesture;
    if (g.kind === 'wait') {
      if (Math.hypot(t.clientX - g.x0, t.clientY - g.y0) < PAN_START) return;
      g.kind = 'pan';
    }
    scroller.scrollLeft -= t.clientX - g.x;
    scroller.scrollTop -= t.clientY - g.y;
    g.x = t.clientX;
    g.y = t.clientY;
    const now = performance.now();
    g.hist.push({ x: t.clientX, y: t.clientY, t: now });
    while (g.hist.length > 2 && now - g.hist[0].t > 100) g.hist.shift();
  }

  function onTouchEnd(e) {
    const fs = fingers(e);
    if (pinch && fs.length < 2) {
      endPinch();
      gesture = { kind: 'ignore' }; // 残った指で急に動かないよう、全部離すまで待つ
    }
    if (fs.length === 0) {
      const g = gesture;
      gesture = null;
      if (g && g.kind === 'pan') startInertia(g.hist);
    }
  }

  function startInertia(hist) {
    if (hist.length < 2) return;
    const a = hist[0], b = hist[hist.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0 || performance.now() - b.t > 60) return; // 指を止めてから離したときは滑らせない
    let vx = (b.x - a.x) / dt * 16, vy = (b.y - a.y) / dt * 16; // px / フレーム
    const step = () => {
      vx *= FRICTION;
      vy *= FRICTION;
      if (Math.hypot(vx, vy) < 0.4) { inertia = 0; return; }
      scroller.scrollLeft -= vx;
      scroller.scrollTop -= vy;
      inertia = requestAnimationFrame(step);
    };
    inertia = requestAnimationFrame(step);
  }

  scroller.addEventListener('touchstart', onTouchStart, { passive: false });
  scroller.addEventListener('touchmove', onTouchMove, { passive: false });
  scroller.addEventListener('touchend', onTouchEnd);
  scroller.addEventListener('touchcancel', onTouchEnd);
  // Safari のブラウザ側の拡大を止める
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    scroller.addEventListener(type, (e) => e.preventDefault());
  }

  // PC(マウス・トラックパッド)での確認用:ホイールでスクロール、Ctrl+ホイール/トラックパッドのピンチで拡大縮小
  scroller.addEventListener('wheel', (e) => {
    e.preventDefault();
    stopInertia();
    if (e.ctrlKey) {
      const sr = scroller.getBoundingClientRect();
      const vx = e.clientX - sr.left, vy = e.clientY - sr.top;
      const px = (scroller.scrollLeft + vx - sheet.offsetLeft) / scale;
      const py = (scroller.scrollTop + vy - sheet.offsetTop) / scale;
      zoom = clamp(zoom * Math.exp(-e.deltaY / 200), minZoom, MAX_ZOOM);
      layout({ px, py, vx, vy });
    } else {
      scroller.scrollLeft += e.deltaX;
      scroller.scrollTop += e.deltaY;
    }
  }, { passive: false });

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

  // 書いている最中の線を描き直す。保存後と同じ drawStroke で描くので、ペンを離しても線の形が変わらない。
  function redrawLive(a) {
    clearCanvas(liveCtx, live);
    setTransform(liveCtx, a);
    drawStroke(liveCtx, a.stroke);
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
  }

  // ペン先の少し先(先読み位置)まで仮に描き、ペンと線のずれを小さく見せる
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
    predCtx.moveTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    const predicted = e.getPredictedEvents ? e.getPredictedEvents() : [];
    if (predicted.length) {
      for (const ev of predicted) {
        const q = toPage(ev, a);
        predCtx.lineTo(q.x, q.y);
      }
    } else if (n >= 3) {
      // 先読みに対応していないブラウザ(Safari)では、直前の動きから少しだけ先を仮に描く(ペンを離すと消える)
      const dx = p[(n - 1) * 3] - p[(n - 3) * 3], dy = p[(n - 1) * 3 + 1] - p[(n - 3) * 3 + 1];
      const len = Math.hypot(dx, dy);
      const k = len ? Math.min(len * 0.5, 6) / len : 0;
      predCtx.lineTo(p[(n - 1) * 3] + dx * k, p[(n - 1) * 3 + 1] + dy * k);
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

  function drawLasso(col) {
    const p = action.pts;
    clearCanvas(liveCtx, live);
    setTransform(liveCtx, action);
    liveCtx.strokeStyle = col;
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

  // ---------- 選択(囲んで移動・まとめて削除) ----------
  // 選択を使って囲むと、囲みの中に半分以上入っている線が選ばれる(点線の枠で表示)。
  // 枠の中をペンでなぞると移動、枠の上の「削除」でまとめて消える。枠の外をタップすると選択をやめる。

  const selLayer = document.createElement('div');
  selLayer.className = 'sel-layer';
  sheet.appendChild(selLayer);

  function inPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
      const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function finishLasso(a) {
    const poly = a.pts;
    if (poly.length < 6) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < poly.length; i += 2) {
      x0 = Math.min(x0, poly[i]); x1 = Math.max(x1, poly[i]);
      y0 = Math.min(y0, poly[i + 1]); y1 = Math.max(y1, poly[i + 1]);
    }
    const picked = page.strokes.filter((s) => {
      if (s.b[2] < x0 || s.b[0] > x1 || s.b[3] < y0 || s.b[1] > y1) return false;
      let inn = 0, all = 0;
      for (let i = 0; i < s.pts.length; i += 3) { all++; if (inPolygon(s.pts[i], s.pts[i + 1], poly)) inn++; }
      return inn * 2 >= all;
    });
    if (!picked.length) return;
    sel = { strokes: picked };
    renderSelection();
  }

  function selRect() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of sel.strokes) {
      x0 = Math.min(x0, s.b[0]); y0 = Math.min(y0, s.b[1]);
      x1 = Math.max(x1, s.b[2]); y1 = Math.max(y1, s.b[3]);
    }
    return [x0, y0, x1, y1];
  }

  function insideSelection(p) {
    const [x0, y0, x1, y1] = selRect();
    const pad = 12;
    return p.x >= x0 - pad && p.x <= x1 + pad && p.y >= y0 - pad && p.y <= y1 + pad;
  }

  function renderSelection(dx = 0, dy = 0) {
    selLayer.textContent = '';
    if (!sel || !page) return;
    const [x0, y0, x1, y1] = selRect();
    const box = document.createElement('div');
    box.className = 'sel-box';
    box.style.cssText = `left:${(x0 + dx) * scale}px;top:${(y0 + dy) * scale}px;` +
      `width:${(x1 - x0) * scale}px;height:${(y1 - y0) * scale}px`;
    selLayer.appendChild(box);
    if (dx || dy) return; // 移動中はボタンを出さない
    const bar = document.createElement('div');
    bar.className = 'sel-bar';
    const del = document.createElement('button');
    del.type = 'button';
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>削除';
    del.addEventListener('click', deleteSelection);
    bar.appendChild(del);
    const count = document.createElement('span');
    count.textContent = `${sel.strokes.length}本`;
    bar.prepend(count);
    selLayer.appendChild(bar);
    const top = y0 * scale - 60;
    bar.style.left = Math.max(4, Math.min(x0 * scale, sheetW - 170)) + 'px';
    bar.style.top = (top < 4 ? y1 * scale + 10 : top) + 'px';
  }

  function clearSelection() {
    sel = null;
    selLayer.textContent = '';
  }

  function deleteSelection() {
    if (!sel) return;
    const items = sel.strokes.map((s) => ({ s, index: page.strokes.indexOf(s) }))
      .filter((x) => x.index >= 0).sort((a, b) => b.index - a.index);
    const ops = [];
    let rect = selRect();
    for (const { s, index } of items) {
      page.strokes.splice(index, 1);
      ops.push({ index, removed: s, added: [] });
    }
    clearSelection();
    rerenderRect(rect);
    if (ops.length) { pushUndo({ type: 'erase', ops }); markDirty(); }
  }

  // 移動:選んだ線をいったんページから外して、ペンについてくる形で上に描く
  function startMove(a, p) {
    const moving = sel.strokes.map((s) => ({ s, index: page.strokes.indexOf(s) })).filter((x) => x.index >= 0);
    for (const { index } of [...moving].sort((x, y) => y.index - x.index)) page.strokes.splice(index, 1);
    rerenderRect(selRect());
    action = { ...a, kind: 'move', start: p, cur: p, moving };
    drawMove(action);
  }

  function drawMove(a) {
    const dx = a.cur.x - a.start.x, dy = a.cur.y - a.start.y;
    clearCanvas(liveCtx, live);
    liveCtx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (a.ox + dx * scale), dpr * (a.oy + dy * scale));
    for (const pass of [true, false]) for (const { s } of a.moving) if (!!s.hl === pass) drawStroke(liveCtx, s);
    renderSelection(dx, dy);
  }

  function shiftStroke(s, dx, dy) {
    for (let i = 0; i < s.pts.length; i += 3) { s.pts[i] = r2(s.pts[i] + dx); s.pts[i + 1] = r2(s.pts[i + 1] + dy); }
    s.b = [s.b[0] + dx, s.b[1] + dy, s.b[2] + dx, s.b[3] + dy].map(r2);
  }

  function finishMove(a) {
    const dx = a.cur.x - a.start.x, dy = a.cur.y - a.start.y;
    const before = selRect();
    const moved = Math.hypot(dx, dy) >= 1;
    if (moved) for (const { s } of a.moving) shiftStroke(s, dx, dy);
    for (const { s, index } of [...a.moving].sort((x, y) => x.index - y.index)) {
      page.strokes.splice(Math.min(index, page.strokes.length), 0, s);
    }
    const after = selRect();
    rerenderRect(before);
    rerenderRect(after);
    renderSelection();
    if (moved) { pushUndo({ type: 'move', strokes: a.moving.map((m) => m.s), dx, dy }); markDirty(); }
  }

  // ---------- 道具・色・太さ ----------

  function setTool(t) {
    if (t === 'eraser' && tool === 'eraser') {   // 消しゴムをもう一度タップ → 種類を選ぶ
      if (eraserMenu.hidden) openEraserMenu(); else closeEraserMenu();
      return;
    }
    if (t === 'eraser' && tool !== 'eraser') prevTool = tool === 'flag' ? 'pen' : tool;
    if (t !== tool) clearSelection();
    tool = t;
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    // 左の「色・太さ」の枠は、最後に使ったペン(ペン/蛍光ペン)のものを表示する
    if (t === 'pen' || t === 'marker') toolbar.dataset.palette = t;
    hint.hidden = t !== 'flag' && t !== 'select';
    hint.textContent = t === 'select'
      ? '動かしたい・消したい文字をペンで囲んでください'
      : 'あとで確認したいところをペンで囲んでください';
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
    if (u.type === 'erase' || u.type === 'stroke') clearSelection();
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
    } else if (u.type === 'move') {
      clearSelection();
      for (const st of u.strokes) {
        const old = st.b.slice();
        shiftStroke(st, -u.dx, -u.dy);
        rerenderRect(old);
        rerenderRect(st.b);
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

  // ページの種類(罫線・方眼・無地)を変える。書いた内容はそのまま。
  function setBackground(bg) {
    if (!page || (page.bg || 'ruled') === bg) return;
    page.bg = bg;
    for (const c of tiles.values()) renderTile(c);
    markDirty();
  }

  return { open, close, flush: flushSave, setBackground };
}
