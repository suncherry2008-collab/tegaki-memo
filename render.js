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

// 1本のストロークを描く。pts は [x, y, 筆圧, x, y, 筆圧, ...] の平坦な配列。
// 点と点の中間点を通る2次曲線でつなぎ、角ばらない滑らかな線にする。
// (書いている最中の表示 editor.js の drawLivePiece も同じ描き方にして、ペンを離したときに線が変化しないようにしている)
// 蛍光ペンは「乗算」で重ねるので、下の罫線や文字が透けて見え、重ね塗りすると少し濃くなる。
export function drawStroke(ctx, s, minW = 0) {
  if (s.hl) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    drawPath(ctx, s, minW);
    ctx.restore();
  } else {
    drawPath(ctx, s, minW);
  }
}

function drawPath(ctx, s, minW) {
  const p = s.pts;
  const n = p.length / 3;
  const color = s.c || INK;   // 色が無い線(以前のメモ)は黒
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const W = (i) => Math.max(strokeWidth(s, p[i * 3 + 2]), minW);
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], W(0) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const mx = (i) => (p[i * 3] + p[i * 3 + 3]) / 2;
  const my = (i) => (p[i * 3 + 1] + p[i * 3 + 4]) / 2;
  let cur = W(0);
  ctx.lineWidth = cur;
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  ctx.lineTo(mx(0), my(0));
  for (let i = 1; i < n - 1; i++) {
    const w = W(i);
    if (w !== cur) {
      ctx.stroke();
      ctx.beginPath();
      ctx.lineWidth = w;
      cur = w;
      ctx.moveTo(mx(i - 1), my(i - 1));
    }
    ctx.quadraticCurveTo(p[i * 3], p[i * 3 + 1], mx(i), my(i));
  }
  ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
  ctx.stroke();
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
