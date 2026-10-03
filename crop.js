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
    const fallback = insetQuad(W, H, 0.04);

    // Two views of the photo, each tried at several cut-offs:
    //  • plain brightness – works when the background is dark;
    //  • brightness compared with the surrounding area – works on light tables, fabric
    //    and uneven lighting/shadows, because paper is brighter than what's right next to it.
    // Every candidate shape is scored on how four-sided it is, its size, and whether it
    // runs off the edge of the photo; the best one wins.
    const otsuT = otsu(hist, lum.length);
    let acc = 0, p99 = 255;
    for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc >= lum.length * 0.99) { p99 = t; break; } }
    const local = localContrast(lum, w, h, Math.round(Math.max(w, h) / 6));

    const tries = [];
    for (let t = Math.min(otsuT, p99 - 10); t < p99; t += 6) tries.push([lum, t]);
    for (const t of [6, 10, 15, 20, 26, 34]) tries.push([local, t]);

    let best = null;
    const label = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    for (const [map, thr] of tries) {
      let mask = new Uint8Array(w * h);
      for (let i = 0; i < mask.length; i++) mask[i] = map[i] > thr ? 1 : 0;
      mask = fillHoles(erode(dilate(mask, w, h, 2), w, h, 2), w, h, stack);
      mask = dilate(erode(mask, w, h, 2), w, h, 2); // drop thin strands joining paper to background
      label.fill(-1);
      for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || label[start] !== -1) continue;
        let sp = 0, count = 0, edge = 0;
        stack[sp++] = start; label[start] = start;
        let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity, tl, tr, br, bl;
        while (sp) {
          const p = stack[--sp];
          const x = p % w, y = (p / w) | 0;
          count++;
          if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge++;
          const sum = x + y, dif = x - y;
          if (sum < sMin) { sMin = sum; tl = { x, y }; }
          if (sum > sMax) { sMax = sum; br = { x, y }; }
          if (dif > dMax) { dMax = dif; tr = { x, y }; }
          if (dif < dMin) { dMin = dif; bl = { x, y }; }
          if (x > 0 && mask[p - 1] && label[p - 1] === -1) { label[p - 1] = start; stack[sp++] = p - 1; }
          if (x < w - 1 && mask[p + 1] && label[p + 1] === -1) { label[p + 1] = start; stack[sp++] = p + 1; }
          if (y > 0 && mask[p - w] && label[p - w] === -1) { label[p - w] = start; stack[sp++] = p - w; }
          if (y < h - 1 && mask[p + w] && label[p + w] === -1) { label[p + w] = start; stack[sp++] = p + w; }
        }
        const frac = count / (w * h);
        if (frac < 0.04 || frac > 0.95) continue;
        const quad = [tl, tr, br, bl];
        const qa = polyArea(quad);
        if (qa < 1) continue;
        const fill = Math.min(1, count / qa);          // 1.0 = cleanly four-sided
        if (fill < 0.75) continue;
        const edgeShare = edge / (2 * (w + h));          // how much it runs off the photo
        // Paper should be bright overall, not just a lit patch.
        let bright = 0;
        for (let i = 0; i < mask.length; i++) if (label[i] === start) bright += lum[i];
        bright /= count * 255;
        // A receipt is a rectangle (allowing for camera tilt): corners near 90°.
        const square = squareness(quad);
        const score = Math.pow(fill, 4) * Math.sqrt(frac) * bright * square * (1 - Math.min(0.9, edgeShare * 4));
        if (!best || score > best.score) best = { score, quad };
      }
    }
    if (!best) return fallback;

    const quad = best.quad.map(p => ({
      x: Math.min(W, Math.max(0, (p.x + 0.5) / scale)),
      y: Math.min(H, Math.max(0, (p.y + 0.5) / scale)),
    }));
    if (polyArea(quad) < W * H * 0.04) return fallback;
    return quad;
  }

  /** 1 for a perfect rectangle, falling towards 0 as any corner moves away from 90°. */
  function squareness(q) {
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      const p = q[i], a = q[(i + 3) % 4], b = q[(i + 1) % 4];
      const ux = a.x - p.x, uy = a.y - p.y, vx = b.x - p.x, vy = b.y - p.y;
      const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      if (!len) return 0;
      const deg = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / len))) * 180 / Math.PI;
      worst = Math.max(worst, Math.abs(90 - deg));
    }
    return Math.max(0.05, 1 - Math.pow(worst / 45, 2));
  }

  /** Brightness minus the average brightness of the surrounding area (radius r). */
  function localContrast(lum, w, h, r) {
    const integ = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += lum[y * w + x];
        integ[(y + 1) * (w + 1) + x + 1] = integ[y * (w + 1) + x + 1] + row;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      const sum = integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
      out[y * w + x] = lum[y * w + x] - sum / ((x1 - x0) * (y1 - y0));
    }
    return out;
  }

  /** Fill enclosed gaps (e.g. printed text) inside bright shapes. */
  function fillHoles(mask, w, h, stack) {
    const outside = new Uint8Array(w * h);
    let sp = 0;
    const push = p => { if (!mask[p] && !outside[p]) { outside[p] = 1; stack[sp++] = p; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
    return out;
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
