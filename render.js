// 描画まわりの共通処理。
// 座標はすべて「ページ座標」(横幅 PAGE_W = 1000 固定)で保存し、
// 表示時に画面幅へ拡大縮小する。縦向き・横向きが変わっても同じメモとして表示できる。

export const PAGE_W = 1000;
export const INK = '#1F2A3A';
const RULE_COLOR = '#E6E9EE';
const RULE_GAP = 48;

// 筆圧(0〜1)から線の太さを決める。0.25刻みに丸めて描画をまとめやすくする。
export function widthOf(base, pressure) {
  const p = Math.min(1, Math.max(0, pressure));
  return Math.round(base * (0.45 + 1.1 * p) * 4) / 4;
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

// 1本のストロークを描く。pts は [x, y, 筆圧, x, y, 筆圧, ...] の平坦な配列。
export function drawStroke(ctx, s, minW = 0) {
  const p = s.pts;
  const n = p.length / 3;
  const color = s.c || INK;   // 色が無い線(以前のメモ)は黒
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (n === 1) {
    const r = Math.max(widthOf(s.w, p[2]), minW) / 2;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  let curW = -1;
  for (let i = 1; i < n; i++) {
    const w = Math.max(widthOf(s.w, (p[i * 3 - 1] + p[i * 3 + 2]) / 2), minW);
    if (w !== curW) {
      if (curW > 0) ctx.stroke();
      ctx.beginPath();
      ctx.lineWidth = w;
      curW = w;
      ctx.moveTo(p[i * 3 - 3], p[i * 3 - 2]);
    }
    ctx.lineTo(p[i * 3], p[i * 3 + 1]);
  }
  ctx.stroke();
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

// メモの一部(rect)を切り出した画像を作る。一覧のサムネイルやフラグ一覧で使う。
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
  for (const st of note.strokes) {
    const b = st.b;
    if (b[2] < rect.x || b[0] > rect.x + rect.w || b[3] < rect.y || b[1] > rect.y + rect.h) continue;
    drawStroke(ctx, st, minW);
  }
  return c;
}
