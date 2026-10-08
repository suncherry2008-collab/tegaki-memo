// 描画まわりの共通処理。
// 座標はすべて「ページ座標」(横幅 PAGE_W = 1000 固定)で保存し、
// 表示時に画面幅へ拡大縮小する。縦向き・横向きが変わっても同じメモとして表示できる。

export const PAGE_W = 1000;
export const INK = '#1F2A3A';
const RULE_COLOR = '#E6E9EE';
const RULE_GAP = 48;

// 筆圧(0〜1)から線の太さを決める。軽く書いてもかすれにくいよう変化を穏やかにしている
// (筆圧0.5 = マウス = 基本の太さ)。1/8刻みに丸めて描画をまとめやすくする。
export function widthOf(base, pressure) {
  const p = Math.min(1, Math.max(0, pressure));
  return Math.round(base * (0.68 + 0.45 * Math.sqrt(p)) * 8) / 8;
}

// ストロークの外接矩形 [minX, minY, maxX, maxY]
export function strokeBBox(pts, w) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const pad = w * 1.6;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

// 線の太さ。蛍光ペン(hl)は筆圧に関係なく一定。
export function strokeWidth(s, pressure) {
  return s.hl ? s.w : widthOf(s.w, pressure);
}

// 丸めない太さ(輪郭の計算用)
function widthRaw(base, pressure) {
  const p = Math.min(1, Math.max(0, pressure));
  return base * (0.68 + 0.45 * Math.sqrt(p));
}

// 記録された点をなめらかな曲線(Catmull-Rom スプライン)で補間し、細かい点列にする。
// 点の少ない速い線でも角ばらない。戻り値は [x, y, 筆圧, ...]。
const STEP = 1.2; // 補間の細かさ(ページ座標)
export function smoothPoints(p) {
  const n = p.length / 3;
  if (n < 3) return p.slice();
  const out = [p[0], p[1], p[2]];
  const P = (i) => { i = Math.max(0, Math.min(n - 1, i)); return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]; };
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = P(i - 1), [x1, y1, p1] = P(i), [x2, y2, p2] = P(i + 1), [x3, y3] = P(i + 2);
    const k = Math.min(24, Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / STEP)));
    for (let j = 1; j <= k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      out.push(
        0.5 * (2 * x1 + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3),
        0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3),
        p1 + (p2 - p1) * t,
      );
    }
  }
  return out;
}

// 1本のストロークを描く。pts は [x, y, 筆圧, x, y, 筆圧, ...] の平坦な配列。
// ペン:線の両側の輪郭を計算して塗りつぶす(太さが筆圧でなめらかに変わり、継ぎ目が出ない)。
// 蛍光ペン:一定の太さの1本の線。「乗算」で重ねるので、下の罫線や文字が透けて見える。
// 書いている最中の表示(editor.js)も同じ関数で描くので、ペンを離しても線は変わらない。
export function drawStroke(ctx, s, minW = 0) {
  const color = s.c || INK;   // 色が無い線(以前のメモ)は黒
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (s.hl) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    drawMarker(ctx, s, minW);
    ctx.restore();
  } else {
    drawInk(ctx, s, minW);
  }
}

function drawMarker(ctx, s, minW) {
  const q = smoothPoints(s.pts);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(s.w, minW);
  ctx.beginPath();
  ctx.moveTo(q[0], q[1]);
  if (q.length === 3) ctx.lineTo(q[0] + 0.01, q[1]);
  for (let i = 3; i < q.length; i += 3) ctx.lineTo(q[i], q[i + 1]);
  ctx.stroke();
}

function drawInk(ctx, s, minW) {
  const q = smoothPoints(s.pts);
  const n = q.length / 3;
  const R = (i) => Math.max(widthRaw(s.w, q[i * 3 + 2]), minW) / 2;
  const dot = (i) => { ctx.moveTo(q[i * 3] + R(i), q[i * 3 + 1]); ctx.arc(q[i * 3], q[i * 3 + 1], R(i), 0, Math.PI * 2); };
  if (n === 1) { ctx.beginPath(); dot(0); ctx.fill(); return; }
  // 各点での進行方向に垂直な向きへ、太さの半分ずつずらした左右の輪郭
  const L = new Array(n * 2), Rt = new Array(n * 2);
  let tx = 0, ty = 0;
  const sharp = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let dx = q[b * 3] - q[a * 3], dy = q[b * 3 + 1] - q[a * 3 + 1];
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) { tx = dx / len; ty = dy / len; }
    const r = R(i);
    L[i * 2] = q[i * 3] - ty * r; L[i * 2 + 1] = q[i * 3 + 1] + tx * r;
    Rt[i * 2] = q[i * 3] + ty * r; Rt[i * 2 + 1] = q[i * 3 + 1] - tx * r;
    // 急に曲がるところは輪郭が欠けやすいので、丸で補う
    if (i > 0 && i < n - 1) {
      const ux = q[i * 3] - q[a * 3], uy = q[i * 3 + 1] - q[a * 3 + 1];
      const vx = q[b * 3] - q[i * 3], vy = q[b * 3 + 1] - q[i * 3 + 1];
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu > 1e-6 && lv > 1e-6 && (ux * vx + uy * vy) / (lu * lv) < 0.7) sharp.push(i);
    }
  }
  ctx.beginPath();
  ctx.moveTo(L[0], L[1]);
  for (let i = 1; i < n; i++) ctx.lineTo(L[i * 2], L[i * 2 + 1]);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(Rt[i * 2], Rt[i * 2 + 1]);
  ctx.closePath();
  ctx.fill();
  // 両端は丸く
  ctx.beginPath();
  dot(0);
  ctx.fill();
  ctx.beginPath();
  dot(n - 1);
  for (const i of sharp) { ctx.moveTo(q[i * 3] + R(i), q[i * 3 + 1]); ctx.arc(q[i * 3], q[i * 3 + 1], R(i), 0, Math.PI * 2); }
  ctx.fill();
}

// 矩形 [x0, y0, x1, y1] にかかる線を描く。蛍光ペンを先に描いて、文字の下に来るようにする。
export function drawStrokesIn(ctx, strokes, x0, y0, x1, y1, minW = 0) {
  for (const pass of [true, false]) {
    for (const s of strokes) {
      if (!!s.hl !== pass) continue;
      const b = s.b;
      if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
      drawStroke(ctx, s, minW);
    }
  }
}

// ページの背景。bg = 'ruled'(罫線・既定)/ 'grid'(方眼)/ 'plain'(無地)。
// [x0, y0, x1, y1](ページ座標)の範囲だけ描く。
export function drawBackground(ctx, bg, x0, y0, x1, y1, scale) {
  if (bg === 'plain') return;
  if (bg === 'grid') drawGrid(ctx, x0, y0, x1, y1, scale);
  else drawRuled(ctx, y0, y1, scale);
}

// 方眼。GRID_GAP(A4横幅1000に対して約5mm)ごとの線と、5マスごとの少し濃い線。
const GRID_GAP = 24;
const GRID_COLOR = '#E9ECF0';
const GRID_MAJOR_COLOR = '#D5DAE1';
function drawGrid(ctx, x0, y0, x1, y1, scale) {
  ctx.lineWidth = 1 / scale;
  for (const major of [false, true]) {
    ctx.strokeStyle = major ? GRID_MAJOR_COLOR : GRID_COLOR;
    ctx.beginPath();
    for (let x = Math.ceil(x0 / GRID_GAP) * GRID_GAP; x <= Math.min(x1, PAGE_W); x += GRID_GAP) {
      if ((Math.round(x / GRID_GAP) % 5 === 0) !== major) continue;
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    for (let y = Math.ceil(y0 / GRID_GAP) * GRID_GAP; y <= y1; y += GRID_GAP) {
      if ((Math.round(y / GRID_GAP) % 5 === 0) !== major) continue;
      ctx.moveTo(Math.max(0, x0), y);
      ctx.lineTo(Math.min(PAGE_W, x1), y);
    }
    ctx.stroke();
  }
}

// 薄い罫線。y0〜y1(ページ座標)の範囲だけ描く。
export function drawRuled(ctx, y0, y1, scale) {
  ctx.strokeStyle = RULE_COLOR;
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  let y = Math.max(Math.ceil(y0 / RULE_GAP) * RULE_GAP, RULE_GAP * 2);
  for (; y <= y1; y += RULE_GAP) {
    ctx.moveTo(0, y);
    ctx.lineTo(PAGE_W, y);
  }
  ctx.stroke();
}

// ページの一部(rect)を切り出した画像を作る。一覧のサムネイルやフラグ一覧で使う。
export function renderRegion(note, rect, maxW, maxH, maxScale = Infinity) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const s = Math.min(maxW / rect.w, maxH / rect.h, maxScale);
  const cw = Math.max(1, Math.round(rect.w * s));
  const ch = Math.max(1, Math.round(rect.h * s));
  const c = document.createElement('canvas');
  c.width = Math.round(cw * dpr);
  c.height = Math.round(ch * dpr);
  c.style.width = cw + 'px';
  c.style.height = ch + 'px';
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(dpr * s, 0, 0, dpr * s, -dpr * s * rect.x, -dpr * s * rect.y);
  const minW = 0.9 / s; // 縮小しても線が消えないようにする
  drawStrokesIn(ctx, note.strokes, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h, minW);
  return c;
}
