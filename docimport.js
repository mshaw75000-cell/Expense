/* Turning PDFs and email text into claims: PDF text + page images (PDF.js), and a receipt-style
   image of pasted email text so the claim report has something to show. */
(function (global) {
  'use strict';

  const CDN = {
    lib: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs',
    worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs',
  };
  let libPromise = null;
  function pdfjs() {
    if (!libPromise) {
      const paths = { ...CDN, ...(global.PDFJS_PATHS || {}) };
      libPromise = import(paths.lib).then(lib => {
        lib.GlobalWorkerOptions.workerSrc = paths.worker;
        return lib;
      }).catch(err => { libPromise = null; throw new Error('Could not load the PDF reader (are you offline?)'); });
    }
    return libPromise;
  }

  /**
   * Read a PDF: its text (rebuilt into lines) and images of its first pages.
   * Returns { text, pages: [canvas…], pageCount }.
   */
  async function readPdf(file, { maxPages = 4, width = 1400 } = {}) {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    const texts = [], pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      if (n <= 10) texts.push(linesOf(await page.getTextContent()));
      if (n <= maxPages) {
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(3, width / base.width) });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        pages.push(trimWhite(c));
      }
    }
    return { text: texts.join('\n'), pages, pageCount: doc.numPages };
  }

  /** PDF text comes as positioned fragments – rebuild them into reading-order lines. */
  function linesOf(content) {
    const rows = [];
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.transform[5], x = it.transform[4];
      let row = rows.find(r => Math.abs(r.y - y) <= Math.max(2, (it.height || 10) * 0.4));
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, s: it.str, w: it.width || 0 });
    }
    rows.sort((a, b) => b.y - a.y);
    return rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      let line = '', end = null;
      for (const i of r.items) {
        if (end != null) line += i.x - end > 8 ? '   ' : (i.x - end > 1 ? ' ' : '');
        line += i.s;
        end = i.x + i.w;
      }
      return line.trim();
    }).join('\n');
  }

  /** Crop the empty white margins off a rendered page (keeps a small border). */
  function trimWhite(c) {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const { data, width: w, height: h } = ctx.getImageData(0, 0, c.width, c.height);
    const ink = (x, y) => { const i = (y * w + x) * 4; return data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235; };
    let top = 0, bottom = h - 1, left = 0, right = w - 1;
    const rowHas = y => { for (let x = 0; x < w; x += 2) if (ink(x, y)) return true; return false; };
    const colHas = x => { for (let y = top; y <= bottom; y += 2) if (ink(x, y)) return true; return false; };
    while (top < bottom && !rowHas(top)) top++;
    while (bottom > top && !rowHas(bottom)) bottom--;
    while (left < right && !colHas(left)) left++;
    while (right > left && !colHas(right)) right--;
    if (bottom - top < 20 || right - left < 20) return c;
    const pad = 24;
    top = Math.max(0, top - pad); left = Math.max(0, left - pad);
    bottom = Math.min(h - 1, bottom + pad); right = Math.min(w - 1, right + pad);
    const o = document.createElement('canvas');
    o.width = right - left + 1; o.height = bottom - top + 1;
    o.getContext('2d').drawImage(c, left, top, o.width, o.height, 0, 0, o.width, o.height);
    return o;
  }

  /** Plain text out of pasted email content, .eml or .html files. */
  function cleanEmailText(raw) {
    let t = String(raw || '');
    if (/^(from|to|subject|date|content-type|mime-version):/im.test(t) && /\r?\n\r?\n/.test(t)) {
      // .eml: decode quoted-printable / base64 text parts crudely, keep the readable body
      const qp = /quoted-printable/i.test(t);
      if (qp) t = t.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      const b64 = /Content-Transfer-Encoding:\s*base64\s*\r?\n\r?\n([A-Za-z0-9+\/=\r\n]+)/i.exec(t);
      if (b64) { try { t += '\n' + decodeURIComponent(escape(atob(b64[1].replace(/\s+/g, '')))); } catch { /* keep as is */ } }
    }
    if (/<(html|body|table|div|td|p)\b/i.test(t)) {
      const doc = new DOMParser().parseFromString(t, 'text/html');
      doc.querySelectorAll('script, style, head').forEach(n => n.remove());
      doc.querySelectorAll('br, p, div, tr, li, h1, h2, h3, h4, table').forEach(n => n.append('\n'));
      doc.querySelectorAll('td, th').forEach(n => n.append('   '));
      t = doc.body ? doc.body.textContent : t;
    }
    return t.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** Draw text as a receipt-like image (for claims created from email text). */
  function textToImage(text, { title = '' } = {}) {
    const W = 1000, pad = 48, size = 26, lh = 36;
    const m = document.createElement('canvas').getContext('2d');
    m.font = `${size}px ui-monospace, Menlo, Consolas, monospace`;
    const wrapLine = line => {
      const out = [];
      let cur = '';
      for (const word of line.split(/(\s+)/)) {
        if (m.measureText(cur + word).width > W - 2 * pad && cur.trim()) { out.push(cur.trimEnd()); cur = word.trimStart(); }
        else cur += word;
      }
      out.push(cur);
      return out;
    };
    let lines = String(text).split('\n').flatMap(wrapLine);
    if (lines.length > 140) lines = [...lines.slice(0, 138), '…', `(${lines.length - 138} more lines not shown)`];
    const head = title ? 70 : 0;
    const c = document.createElement('canvas');
    c.width = W; c.height = pad * 2 + head + lines.length * lh;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    if (title) {
      x.fillStyle = '#5a6675'; x.font = `bold 22px -apple-system, Segoe UI, Roboto, sans-serif`;
      x.fillText(title, pad, pad + 20);
      x.fillStyle = '#dfe4ea'; x.fillRect(pad, pad + 40, W - 2 * pad, 2);
    }
    x.fillStyle = '#111'; x.font = `${size}px ui-monospace, Menlo, Consolas, monospace`;
    lines.forEach((l, i) => x.fillText(l, pad, pad + head + (i + 1) * lh - 10));
    return c;
  }

  global.DocImport = { readPdf, cleanEmailText, textToImage };
})(typeof window !== 'undefined' ? window : globalThis);
