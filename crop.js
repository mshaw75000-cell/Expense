/* Receipt detection + perspective crop. No dependencies. */
(function () {
  'use strict';

  /**
   * Find the four corners of the receipt (a bright paper shape) in a canvas.
   * Returns [tl, tr, br, bl] as {x, y} in canvas pixel coordinates.
   */
  function detectReceipt(canvas) {
    const W = canvas.width, H = canvas.height;
    const scale = Math.min(1, 360 / Math.max(W, H));
    const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
    const small = document.createElement('canvas');
    small.width = w; small.height = h;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(canvas, 0, 0, w, h);
    const px = sctx.getImageData(0, 0, w, h).data;

    // Brightness, penalising saturated colours (paper is bright and neutral).
    const lum = new Float32Array(w * h);
    const hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < lum.length; i++, j += 4) {
      const r = px[j], g = px[j + 1], b = px[j + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const v = Math.max(0, Math.min(255, 0.299 * r + 0.587 * g + 0.114 * b - 0.5 * (mx - mn)));
      lum[i] = v;
      hist[v | 0]++;
    }
    const thr = otsu(hist, lum.length);

    // Bright mask, then close small gaps (receipt text) with a dilate + erode.
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = lum[i] > thr ? 1 : 0;
    mask = erode(dilate(mask, w, h, 2), w, h, 2);

    // Largest connected bright region, preferring regions near the centre.
    const label = new Int32Array(w * h).fill(-1);
    const stack = new Int32Array(w * h);
    let best = null;
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || label[start] !== -1) continue;
      let sp = 0, count = 0, touches = 0, cx = 0, cy = 0;
      const id = start;
      stack[sp++] = start; label[start] = id;
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p / w) | 0;
        count++; cx += x; cy += y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches++;
        if (x > 0 && mask[p - 1] && label[p - 1] === -1) { label[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && label[p + 1] === -1) { label[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && label[p - w] === -1) { label[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && label[p + w] === -1) { label[p + w] = id; stack[sp++] = p + w; }
      }
      cx /= count; cy /= count;
      const dc = Math.hypot(cx / w - 0.5, cy / h - 0.5);
      const score = count * (1 - dc) * (touches > (w + h) ? 0.5 : 1);
      if (!best || score > best.score) best = { id, count, score };
    }

    const fallback = insetQuad(W, H, 0.04);
    if (!best || best.count < w * h * 0.06 || best.count > w * h * 0.97) return fallback;

    // Extreme points of the region give the four corners.
    let tl, tr, br, bl;
    let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity;
    for (let p = 0; p < label.length; p++) {
      if (label[p] !== best.id) continue;
      const x = p % w, y = (p / w) | 0;
      const s = x + y, d = x - y;
      if (s < sMin) { sMin = s; tl = { x, y }; }
      if (s > sMax) { sMax = s; br = { x, y }; }
      if (d > dMax) { dMax = d; tr = { x, y }; }
      if (d < dMin) { dMin = d; bl = { x, y }; }
    }
    const quad = [tl, tr, br, bl].map(p => ({
      x: Math.min(W, Math.max(0, (p.x + 0.5) / scale)),
      y: Math.min(H, Math.max(0, (p.y + 0.5) / scale)),
    }));
    if (polyArea(quad) < W * H * 0.05) return fallback;
    return quad;
  }

  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  function morph(src, w, h, r, isDilate) {
    // Separable box max/min filter.
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = isDilate ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        const s = src[y * w + xx];
        if (isDilate ? s : !s) { v = isDilate ? 1 : 0; break; }
      }
      tmp[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = isDilate ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        const s = tmp[yy * w + x];
        if (isDilate ? s : !s) { v = isDilate ? 1 : 0; break; }
      }
      out[y * w + x] = v;
    }
    return out;
  }
  const dilate = (m, w, h, r) => morph(m, w, h, r, true);
  const erode = (m, w, h, r) => morph(m, w, h, r, false);

  function insetQuad(W, H, f) {
    const dx = W * f, dy = H * f;
    return [{ x: dx, y: dy }, { x: W - dx, y: dy }, { x: W - dx, y: H - dy }, { x: dx, y: H - dy }];
  }

  function polyArea(q) {
    let a = 0;
    for (let i = 0; i < q.length; i++) {
      const p = q[i], n = q[(i + 1) % q.length];
      a += p.x * n.y - n.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  /** Homography mapping unit-square-ish dst rect corners -> src quad. */
  function homography(src, dst) {
    // Solve for H such that src = H * dst (8 unknowns).
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = dst[i], { x: u, y: v } = src[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const hvec = solve(A, b);
    return [...hvec, 1];
  }

  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      const d = M[c][c] || 1e-12;
      for (let k = c; k <= n; k++) M[c][k] /= d;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (!f) continue;
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map(row => row[n]);
  }

  /**
   * Warp the quad region of srcCanvas into a flat rectangle.
   * Returns a new canvas. maxSide caps output resolution.
   */
  function warp(srcCanvas, quad, { maxSide = 2000, enhance = false } = {}) {
    const [tl, tr, br, bl] = quad;
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let outW = Math.max(d(tl, tr), d(bl, br));
    let outH = Math.max(d(tl, bl), d(tr, br));
    const s = Math.min(1, maxSide / Math.max(outW, outH));
    outW = Math.max(1, Math.round(outW * s));
    outH = Math.max(1, Math.round(outH * s));

    const H = homography(quad, [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }]);
    const sw = srcCanvas.width, sh = srcCanvas.height;
    const src = srcCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const octx = out.getContext('2d');
    const img = octx.createImageData(outW, outH);
    const o = img.data;

    for (let y = 0; y < outH; y++) {
      const yc = y + 0.5;
      for (let x = 0; x < outW; x++) {
        const xc = x + 0.5;
        const den = H[6] * xc + H[7] * yc + H[8];
        let u = (H[0] * xc + H[1] * yc + H[2]) / den - 0.5;
        let v = (H[3] * xc + H[4] * yc + H[5]) / den - 0.5;
        if (u < 0) u = 0; else if (u > sw - 1) u = sw - 1;
        if (v < 0) v = 0; else if (v > sh - 1) v = sh - 1;
        const x0 = u | 0, y0 = v | 0;
        const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        const fx = u - x0, fy = v - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        const oi = (y * outW + x) * 4;
        for (let c = 0; c < 3; c++) {
          const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
          const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
          o[oi + c] = top + (bot - top) * fy;
        }
        o[oi + 3] = 255;
      }
    }
    if (enhance) enhanceImage(o);
    octx.putImageData(img, 0, 0);
    return out;
  }

  /** Grayscale + auto-levels so the receipt text is crisp and paper is white. */
  function enhanceImage(o) {
    const n = o.length / 4;
    const hist = new Uint32Array(256);
    for (let i = 0; i < o.length; i += 4) {
      const g = (0.299 * o[i] + 0.587 * o[i + 1] + 0.114 * o[i + 2]) | 0;
      o[i] = g; hist[g]++;
    }
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255; lo++) { acc += hist[lo]; if (acc > n * 0.01) break; }
    acc = 0;
    for (; hi > 0; hi--) { acc += hist[hi]; if (acc > n * 0.25) break; } // paper is the bulk
    if (hi - lo < 30) { lo = 0; hi = 255; }
    const range = hi - lo;
    for (let i = 0; i < o.length; i += 4) {
      let v = (o[i] - lo) / range;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      v = Math.pow(v, 1.4) * 255; // deepen ink
      o[i] = o[i + 1] = o[i + 2] = v;
    }
  }

  window.ReceiptCrop = { detectReceipt, warp, insetQuad };
})();
