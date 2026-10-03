/* Tiny PDF writer for the expense report: text, rectangles and JPEG images. No dependencies. */
(function () {
  'use strict';

  const PAGE_W = 612, PAGE_H = 792, M = 40; // US Letter, points

  const WINANSI = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
  function toAnsi(s) {
    let out = '';
    for (const ch of String(s ?? '')) {
      const c = ch.codePointAt(0);
      if (WINANSI[ch]) out += String.fromCharCode(WINANSI[ch]);
      else if (c === 9 || c === 10 || c === 13) out += ' ';
      else if (c < 32) continue;
      else if (c <= 255) out += ch;
      else out += '?';
    }
    return out;
  }
  const esc = s => toAnsi(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const measureCtx = document.createElement('canvas').getContext('2d');
  function textWidth(s, size, bold) {
    measureCtx.font = `${bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
    return measureCtx.measureText(String(s)).width;
  }
  function wrap(s, size, maxW, bold) {
    const lines = [];
    for (const para of String(s ?? '').split(/\n/)) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? line + ' ' + word : word;
        if (textWidth(test, size, bold) <= maxW || !line) line = test;
        else { lines.push(line); line = word; }
        while (textWidth(line, size, bold) > maxW && line.length > 1) { // very long word
          let cut = line.length - 1;
          while (cut > 1 && textWidth(line.slice(0, cut), size, bold) > maxW) cut--;
          lines.push(line.slice(0, cut)); line = line.slice(cut);
        }
      }
      lines.push(line);
    }
    return lines;
  }
  function fit(s, size, maxW, bold) {
    s = String(s ?? '');
    if (textWidth(s, size, bold) <= maxW) return s;
    while (s.length && textWidth(s + '…', size, bold) > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  function rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255].map(v => v.toFixed(3)).join(' ');
  }

  class Page {
    constructor() { this.ops = []; this.images = []; }
    rect(x, y, w, h, color) { this.ops.push(`${rgb(color)} rg ${x.toFixed(2)} ${(PAGE_H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); }
    line(x1, y1, x2, color, width = 0.75) { this.ops.push(`${rgb(color)} RG ${width} w ${x1} ${PAGE_H - y1} m ${x2} ${PAGE_H - y1} l S`); }
    // y is the text baseline measured from the top of the page.
    text(s, x, y, { size = 11, bold = false, color = '#13202e', align = 'left' } = {}) {
      if (align === 'right') x -= textWidth(s, size, bold);
      this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg ${x.toFixed(2)} ${(PAGE_H - y).toFixed(2)} Td (${esc(s)}) Tj ET`);
    }
    image(img, x, y, w, h) {
      const name = 'Im' + this.images.length;
      this.images.push({ name, img });
      this.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(PAGE_H - y - h).toFixed(2)} cm /${name} Do Q`);
    }
  }

  function money(n, cur) {
    if (n === '' || n == null || isNaN(n)) return '';
    return (cur || '$') + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /**
   * receipts: [{ jpeg: Uint8Array, w, h, description, purpose, amount, date, category }]
   */
  function buildExpenseReport({ name, receipts, primary = '#0b2a4a', accent = '#00a6a6', brand = 'mentis' }) {
    const pages = [];
    const muted = '#677585', ink = '#13202e';
    const total = receipts.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    const dates = receipts.map(r => r.date).filter(Boolean).sort();
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    function header(p, title) {
      p.rect(0, 0, PAGE_W, 64, primary);
      p.text(brand.toLowerCase(), M, 40, { size: 22, bold: true, color: '#ffffff' });
      p.text('.', M + textWidth(brand.toLowerCase(), 22, true), 40, { size: 22, bold: true, color: accent });
      p.text(title, PAGE_W - M, 40, { size: 13, bold: true, color: '#ffffff', align: 'right' });
    }
    function footer(p, i, n) {
      p.line(M, PAGE_H - 34, PAGE_W - M, '#dfe4ea');
      p.text(`${name || ''}${name ? '  ·  ' : ''}Generated ${today}`, M, PAGE_H - 20, { size: 8, color: muted });
      p.text(`Page ${i} of ${n}`, PAGE_W - M, PAGE_H - 20, { size: 8, color: muted, align: 'right' });
    }

    // ---- Summary page(s) ----
    const cols = { date: M, desc: M + 72, cat: M + 340, amt: PAGE_W - M };
    let p = new Page(); pages.push(p);
    header(p, 'Expense Report');
    let y = 100;
    p.text(name || 'Expense report', M, y, { size: 18, bold: true, color: ink }); y += 20;
    const range = dates.length ? (dates[0] === dates[dates.length - 1] ? fmtDate(dates[0]) : `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}`) : '';
    p.text(`${receipts.length} receipt${receipts.length === 1 ? '' : 's'}${range ? '  ·  ' + range : ''}`, M, y, { size: 11, color: muted }); y += 30;

    const tableHead = () => {
      p.rect(M, y - 14, PAGE_W - 2 * M, 22, '#eef1f5');
      p.text('DATE', cols.date + 6, y + 1, { size: 8, bold: true, color: muted });
      p.text('DESCRIPTION / PURPOSE', cols.desc, y + 1, { size: 8, bold: true, color: muted });
      p.text('CATEGORY', cols.cat, y + 1, { size: 8, bold: true, color: muted });
      p.text('AMOUNT', cols.amt - 6, y + 1, { size: 8, bold: true, color: muted, align: 'right' });
      y += 24;
    };
    tableHead();
    receipts.forEach((r, i) => {
      const purposeLines = r.purpose ? wrap(r.purpose, 9, cols.cat - cols.desc - 10).slice(0, 3) : [];
      const rowH = 16 + purposeLines.length * 11 + 8;
      if (y + rowH > PAGE_H - 90) {
        p = new Page(); pages.push(p); header(p, 'Expense Report (cont.)'); y = 100; tableHead();
      }
      p.text(fmtDate(r.date, true), cols.date + 6, y, { size: 10, color: ink });
      p.text(fit(`${i + 1}. ${r.description || '(no description)'}`, 10, cols.cat - cols.desc - 10, true), cols.desc, y, { size: 10, bold: true, color: ink });
      p.text(fit(r.category || '', 9, cols.amt - cols.cat - 70), cols.cat, y, { size: 9, color: muted });
      p.text(money(r.amount), cols.amt - 6, y, { size: 10, bold: true, color: ink, align: 'right' });
      let yy = y + 13;
      for (const l of purposeLines) { p.text(l, cols.desc, yy, { size: 9, color: muted }); yy += 11; }
      y += rowH;
      p.line(M, y - 12, PAGE_W - M, '#dfe4ea');
    });
    if (y + 40 > PAGE_H - 50) { p = new Page(); pages.push(p); header(p, 'Expense Report (cont.)'); y = 100; }
    p.rect(PAGE_W - M - 200, y - 6, 200, 30, primary);
    p.text('TOTAL', PAGE_W - M - 188, y + 13, { size: 10, bold: true, color: '#ffffff' });
    p.text(money(total), PAGE_W - M - 12, y + 13, { size: 13, bold: true, color: '#ffffff', align: 'right' });

    // ---- One page per receipt ----
    receipts.forEach((r, i) => {
      const pg = new Page(); pages.push(pg);
      header(pg, `Receipt ${i + 1} of ${receipts.length}`);
      let yy = 98;
      const amt = money(r.amount);
      const amtW = amt ? textWidth(amt, 16, true) + 12 : 0;
      for (const l of wrap(r.description || '(no description)', 16, PAGE_W - 2 * M - amtW, true).slice(0, 2)) {
        pg.text(l, M, yy, { size: 16, bold: true, color: ink }); yy += 19;
      }
      if (amt) pg.text(amt, PAGE_W - M, 98, { size: 16, bold: true, color: accent, align: 'right' });
      pg.text([fmtDate(r.date), r.category].filter(Boolean).join('  ·  '), M, yy, { size: 10, color: muted }); yy += 18;
      if (r.purpose) {
        pg.text('Purpose:', M, yy, { size: 10, bold: true, color: primary });
        const lines = wrap(r.purpose, 10, PAGE_W - 2 * M - 52).slice(0, 4);
        lines.forEach((l, k) => pg.text(l, M + 52, yy + k * 13, { size: 10, color: ink }));
        yy += lines.length * 13 + 4;
      }
      yy += 8;
      const boxW = PAGE_W - 2 * M, boxH = PAGE_H - 50 - yy;
      const s = Math.min(boxW / r.w, boxH / r.h);
      const iw = r.w * s, ih = r.h * s;
      pg.rect(M + (boxW - iw) / 2 - 1, yy - 1, iw + 2, ih + 2, '#dfe4ea');
      pg.image(r, M + (boxW - iw) / 2, yy, iw, ih);
    });

    pages.forEach((pg, i) => footer(pg, i + 1, pages.length));
    return serialize(pages);
  }

  function fmtDate(iso, short) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return short
      ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function serialize(pages) {
    const enc = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
    const chunks = [];
    let offset = 0;
    const push = part => { const b = typeof part === 'string' ? enc(part) : part; chunks.push(b); offset += b.length; };
    const offsets = [];
    let nextId = 1;
    const alloc = () => nextId++;
    const writeObj = (id, ...parts) => { offsets[id] = offset; push(`${id} 0 obj\n`); parts.forEach(push); push('\nendobj\n'); };

    const catalogId = alloc(), pagesId = alloc(), f1 = alloc(), f2 = alloc();
    const pageIds = pages.map(() => alloc());

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    writeObj(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    writeObj(pagesId, `<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${pages.length} >>`);
    writeObj(f1, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    writeObj(f2, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    pages.forEach((pg, i) => {
      const xobjs = pg.images.map(({ name, img }) => {
        const id = alloc();
        writeObj(id, `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`, img.jpeg, '\nendstream');
        return `/${name} ${id} 0 R`;
      });
      const content = pg.ops.join('\n');
      const cid = alloc();
      writeObj(cid, `<< /Length ${content.length} >>\nstream\n`, content, '\nendstream');
      writeObj(pageIds[i], `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> /XObject << ${xobjs.join(' ')} >> >> /Contents ${cid} 0 R >>`);
    });

    const xref = offset;
    let x = `xref\n0 ${nextId}\n0000000000 65535 f \n`;
    for (let id = 1; id < nextId; id++) x += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
    push(x);
    push(`trailer\n<< /Size ${nextId} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  window.ExpensePdf = { buildExpenseReport, money };
})();
