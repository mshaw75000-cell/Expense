/* Tiny PDF writer for the expense report: text, rectangles and JPEG images. No dependencies. */
(function () {
  'use strict';

  const PAGE_W = 612, PAGE_H = 792, M = 40; // US Letter, points

  const WINANSI = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
  function toAnsi(s) {
    let out = '';
    for (const ch of String(s ?? '').replace(/→/g, '->').replace(/✎/g, '')) {
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
      else if (align === 'center') x -= textWidth(s, size, bold) / 2;
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
   * Monthly claim report.
   * receipts: [{ ref, unit, jpeg, w, h, vendor, purpose, category, amount, gst, date, abn,
   *              attachments: [{ jpeg, w, h }] }]  – already in report order
   * exceptions: [{ ref, type, vendor, detail }] – only on a resubmission
   */
  function buildClaimReport({ name, monthLabel, submissionNo = 1, previous = null, receipts, exceptions = [], personal = false,
    primary = '#0b2a4a', accent = '#00a6a6', brand = 'mentis' }) {
    const pages = [];
    const muted = '#677585', ink = '#13202e', warn = '#b26a00';
    const sum = (list, k) => list.reduce((t, r) => t + (parseFloat(r[k]) || 0), 0);
    const hasGst = r => r.gst !== '' && r.gst != null && !isNaN(parseFloat(r.gst));
    const exOf = r => (r.amount === '' || r.amount == null) ? '' : (parseFloat(r.amount) || 0) - (parseFloat(r.gst) || 0);
    const today = new Date().toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric' });
    const units = [...new Set(receipts.map(r => r.unit || 'Unassigned'))];
    const total = sum(receipts, 'amount'), totalGst = sum(receipts, 'gst');
    const resub = submissionNo > 1;

    function header(p, title) {
      p.rect(0, 0, PAGE_W, 64, primary);
      p.text(brand.toLowerCase(), M, 40, { size: 22, bold: true, color: '#ffffff' });
      p.text('.', M + textWidth(brand.toLowerCase(), 22, true), 40, { size: 22, bold: true, color: accent });
      p.text(title, PAGE_W - M, 40, { size: 13, bold: true, color: '#ffffff', align: 'right' });
    }
    function footer(p, i, n) {
      p.line(M, PAGE_H - 34, PAGE_W - M, '#dfe4ea');
      p.text(`${name || ''}${name ? '  ·  ' : ''}${monthLabel} claim${resub ? ` (resubmission ${submissionNo - 1})` : ''}  ·  Generated ${today}`, M, PAGE_H - 20, { size: 8, color: muted });
      p.text(`Page ${i} of ${n}`, PAGE_W - M, PAGE_H - 20, { size: 8, color: muted, align: 'right' });
    }

    // ---- Summary ----
    const cols = { ref: M + 4, date: M + 34, desc: M + 82, ex: PAGE_W - M - 150, gst: PAGE_W - M - 82, amt: PAGE_W - M };
    let p = new Page(); pages.push(p);
    const docTitle = personal ? 'Reimbursement Claim' : 'Expense Claim';
    header(p, docTitle);
    let y = 100;
    p.text(`${name || 'Expense claim'} – ${monthLabel}`, M, y, { size: 18, bold: true, color: ink }); y += 18;
    p.text(`${receipts.length} line${receipts.length === 1 ? '' : 's'}  ·  ${units.join(', ')}`, M, y, { size: 11, color: muted }); y += 16;
    if (personal) {
      p.rect(M, y - 4, PAGE_W - 2 * M, 22, '#e8eef7');
      p.text('PAID PERSONALLY – please reimburse the total to the claimant.', M + 10, y + 10, { size: 10, bold: true, color: primary });
      y += 28;
    }
    if (resub) {
      p.rect(M, y - 4, PAGE_W - 2 * M, 34, '#fff4e0');
      p.text(`RESUBMISSION ${submissionNo - 1} – replaces the claim sent ${previous ? previous.date : 'earlier'}`, M + 10, y + 10, { size: 10, bold: true, color: warn });
      p.text(`${exceptions.length} change${exceptions.length === 1 ? '' : 's'} since then – see the exception report.`, M + 10, y + 23, { size: 9, color: ink });
      y += 40;
    }
    y += 14;

    const tableHead = () => {
      p.rect(M, y - 14, PAGE_W - 2 * M, 22, '#eef1f5');
      p.text('REF', cols.ref, y + 1, { size: 8, bold: true, color: muted });
      p.text('DATE', cols.date, y + 1, { size: 8, bold: true, color: muted });
      p.text('VENDOR / EXPENSE TYPE / PURPOSE', cols.desc, y + 1, { size: 8, bold: true, color: muted });
      p.text('EX GST', cols.ex - 6, y + 1, { size: 8, bold: true, color: muted, align: 'right' });
      p.text('GST', cols.gst - 6, y + 1, { size: 8, bold: true, color: muted, align: 'right' });
      p.text('TOTAL', cols.amt - 6, y + 1, { size: 8, bold: true, color: muted, align: 'right' });
      y += 24;
    };
    const newPage = () => { p = new Page(); pages.push(p); header(p, docTitle + ' (cont.)'); y = 100; };
    tableHead();
    for (const unit of units) {
      const list = receipts.filter(r => (r.unit || 'Unassigned') === unit);
      if (y + 60 > PAGE_H - 90) { newPage(); tableHead(); }
      p.text(unit.toUpperCase(), M + 4, y, { size: 10, bold: true, color: primary });
      y += 16;
      for (const r of list) {
        const descW = cols.ex - cols.desc - 60;
        const fx = r.currency && r.currency !== 'AUD' ? `${r.currency} ${(parseFloat(r.fxAmount) || 0).toFixed(2)}${r.rate ? ` @ ${r.rate.toFixed(4)}` : ''}${r.audEstimated ? ' (AUD ESTIMATED)' : ''}` : '';
        const flags = [r.splitOfRef ? `Split of ${r.splitOfRef}` : '', r.travelText || '', r.taxInvIssue ? 'NO TAX INVOICE' : '', r.attendeesText ? `${(r.attendees || []).filter(p => p.name).length} attendee(s)` : ''].filter(Boolean).join(' · ');
        const sub = [fx, r.category, r.purpose, flags].filter(Boolean).join(' · ');
        const subLines = sub ? wrap(sub, 9, descW).slice(0, 3) : [];
        const rowH = 16 + subLines.length * 11 + 8;
        if (y + rowH > PAGE_H - 90) { newPage(); tableHead(); }
        p.text(r.ref, cols.ref, y, { size: 9, color: muted });
        p.text(fmtDate(r.date, true), cols.date, y, { size: 10, color: ink });
        p.text(fit(r.vendor || '(no vendor)', 10, descW, true), cols.desc, y, { size: 10, bold: true, color: ink });
        p.text(money(exOf(r)), cols.ex - 6, y, { size: 10, color: ink, align: 'right' });
        p.text(hasGst(r) ? money(r.gst) : '–', cols.gst - 6, y, { size: 10, color: ink, align: 'right' });
        p.text(money(r.amount), cols.amt - 6, y, { size: 10, bold: true, color: ink, align: 'right' });
        let yy = y + 13;
        for (const l of subLines) { p.text(l, cols.desc, yy, { size: 9, color: muted }); yy += 11; }
        y += rowH;
        p.line(M, y - 12, PAGE_W - M, '#dfe4ea');
      }
      const ut = sum(list, 'amount'), ug = sum(list, 'gst');
      p.text(`${unit} subtotal`, cols.desc, y, { size: 10, bold: true, color: primary });
      p.text(money(ut - ug), cols.ex - 6, y, { size: 10, bold: true, color: ink, align: 'right' });
      p.text(money(ug), cols.gst - 6, y, { size: 10, bold: true, color: ink, align: 'right' });
      p.text(money(ut), cols.amt - 6, y, { size: 10, bold: true, color: ink, align: 'right' });
      y += 26;
    }
    if (y + 90 + units.length * 16 > PAGE_H - 50) newPage();
    const bx = PAGE_W - M - 240;
    units.forEach(u => {
      const list = receipts.filter(r => (r.unit || 'Unassigned') === u);
      p.text(`${u}`, bx + 12, y, { size: 10, color: muted });
      p.text(money(sum(list, 'amount')), PAGE_W - M - 12, y, { size: 10, color: ink, align: 'right' });
      y += 16;
    });
    p.text('Total ex GST', bx + 12, y, { size: 10, color: muted });
    p.text(money(total - totalGst) || '$0.00', PAGE_W - M - 12, y, { size: 10, color: ink, align: 'right' }); y += 16;
    p.text('GST', bx + 12, y, { size: 10, color: muted });
    p.text(money(totalGst) || '$0.00', PAGE_W - M - 12, y, { size: 10, color: ink, align: 'right' }); y += 12;
    p.rect(bx, y, 240, 30, primary);
    p.text(personal ? 'TO REIMBURSE (INC GST)' : 'TOTAL CLAIM (INC GST)', bx + 12, y + 19, { size: 10, bold: true, color: '#ffffff' });
    p.text(money(total) || '$0.00', PAGE_W - M - 12, y + 19, { size: 13, bold: true, color: '#ffffff', align: 'right' });
    y += 60;
    if (y + 40 < PAGE_H - 50) {
      p.text('I confirm these expenses were incurred for business purposes.', M, y, { size: 9, color: muted }); y += 26;
      p.line(M, y, M + 200, '#13202e', 0.5);
      p.text(`${name || 'Claimant'}  ·  ${today}`, M, y + 12, { size: 9, color: muted });
    }

    // ---- Exception report (resubmissions) ----
    if (resub) {
      newPage();
      header(p, 'Exception Report');
      y = 100;
      p.text(`Changes since the ${monthLabel} claim was submitted`, M, y, { size: 16, bold: true, color: ink }); y += 18;
      p.text(`Previously submitted ${previous ? previous.date : ''}${previous && previous.to ? ' to ' + previous.to : ''}  ·  This is resubmission ${submissionNo - 1}`, M, y, { size: 10, color: muted }); y += 24;
      if (previous) {
        const diff = total - previous.total;
        p.text(`Previous total ${money(previous.total)}   →   New total ${money(total)}   (${diff >= 0 ? '+' : '–'}${money(Math.abs(diff))})`, M, y, { size: 11, bold: true, color: diff ? warn : ink }); y += 26;
      }
      const head = () => {
        p.rect(M, y - 14, PAGE_W - 2 * M, 22, '#eef1f5');
        p.text('REF', M + 4, y + 1, { size: 8, bold: true, color: muted });
        p.text('CHANGE', M + 40, y + 1, { size: 8, bold: true, color: muted });
        p.text('VENDOR', M + 110, y + 1, { size: 8, bold: true, color: muted });
        p.text('DETAIL', M + 240, y + 1, { size: 8, bold: true, color: muted });
        y += 24;
      };
      head();
      if (!exceptions.length) { p.text('No line changes – resent as submitted.', M + 4, y, { size: 10, color: muted }); y += 16; }
      for (const e of exceptions) {
        const lines = wrap(e.detail, 9, PAGE_W - M - (M + 240)).slice(0, 4);
        const rowH = Math.max(16, lines.length * 12) + 8;
        if (y + rowH > PAGE_H - 60) { newPage(); header(p, 'Exception Report (cont.)'); y = 100; head(); }
        p.text(e.ref || '', M + 4, y, { size: 9, color: muted });
        p.text(e.type, M + 40, y, { size: 9, bold: true, color: e.type === 'Removed' ? '#c0392b' : e.type === 'Added' ? '#047878' : warn });
        p.text(fit(e.vendor || '', 9, 125), M + 110, y, { size: 9, color: ink });
        lines.forEach((l, k) => p.text(l, M + 240, y + k * 12, { size: 9, color: ink }));
        y += rowH;
        p.line(M, y - 12, PAGE_W - M, '#dfe4ea');
      }
    }

    // ---- Receipt pages, each followed by its supporting photos ----
    const imagePage = (title, heading, img, info) => {
      const pg = new Page(); pages.push(pg);
      header(pg, title);
      let yy = 98;
      yy = heading(pg, yy);
      const boxW = PAGE_W - 2 * M, boxH = PAGE_H - 50 - yy;
      if (!img.jpeg) { // claim submitted before its receipt
        pg.rect(M, yy, boxW, 120, '#fff4e0');
        pg.text('RECEIPT TO FOLLOW', PAGE_W / 2, yy + 52, { size: 16, bold: true, color: warn, align: 'center' });
        pg.text('The receipt for this expense hasn’t been attached yet.', PAGE_W / 2, yy + 74, { size: 10, color: ink, align: 'center' });
        return;
      }
      const sc = Math.min(boxW / img.w, boxH / img.h);
      const iw = img.w * sc, ih = img.h * sc;
      pg.rect(M + (boxW - iw) / 2 - 1, yy - 1, iw + 2, ih + 2, '#dfe4ea');
      pg.image(img, M + (boxW - iw) / 2, yy, iw, ih);
    };
    receipts.forEach(r => {
      if (r.splitIndex > 0) return; // a split bill's receipt page is shown once, on its first line
      imagePage(`${r.ref} · ${r.unit || ''}`, (pg, yy) => {
        const amt = money(r.receiptTotal ?? r.amount);
        const amtW = amt ? textWidth(amt, 16, true) + 12 : 0;
        for (const l of wrap(r.vendor || '(no vendor)', 16, PAGE_W - 2 * M - amtW, true).slice(0, 2)) {
          pg.text(l, M, yy, { size: 16, bold: true, color: ink }); yy += 19;
        }
        if (amt) {
          pg.text(amt, PAGE_W - M, 98, { size: 16, bold: true, color: accent, align: 'right' });
          const rg = r.receiptGst ?? r.gst, rt = r.receiptTotal ?? r.amount;
          pg.text(`GST ${rg !== '' && rg != null ? money(rg) : '$0.00'}  ·  Ex GST ${money((parseFloat(rt) || 0) - (parseFloat(rg) || 0))}`, PAGE_W - M, 113, { size: 9, color: muted, align: 'right' });
        }
        pg.text([fmtDate(r.date), ...(r.splitSummary ? ['Split bill'] : [r.unit, r.category])].filter(Boolean).join('  ·  '), M, yy, { size: 10, color: muted }); yy += 18;
        if (r.currency && r.currency !== 'AUD') {
          pg.text(`Paid in ${r.currency}: ${r.currency} ${(parseFloat(r.fxAmount) || 0).toFixed(2)}  =  AUD ${money(r.amount).replace('$', '$')}${r.rate ? `  (rate ${r.rate.toFixed(4)})` : ''}  ·  AUD ${r.audEstimated ? `ESTIMATED from the daily rate${r.audEstimateDate ? ' for ' + fmtDate(r.audEstimateDate) : ''}` : r.audSource === 'bank' ? 'from bank statement' : 'entered by claimant'}`, M, yy, { size: 10, bold: true, color: primary }); yy += 16;
        }
        if (r.purpose) {
          pg.text('Purpose:', M, yy, { size: 10, bold: true, color: primary });
          const lines = wrap(r.purpose, 10, PAGE_W - 2 * M - 52).slice(0, 4);
          lines.forEach((l, k) => pg.text(l, M + 52, yy + k * 13, { size: 10, color: ink }));
          yy += lines.length * 13 + 4;
        }
        if (r.splitSummary) {
          pg.text('Split:', M, yy, { size: 10, bold: true, color: primary });
          r.splitSummary.forEach((x, k) => pg.text(`${x.ref}  ${x.category || ''}  ·  ${x.unit || ''}  ·  ${money(x.amount)}`, M + 52, yy + k * 13, { size: 10, color: ink }));
          yy += r.splitSummary.length * 13 + 4;
        }
        if (r.travelText) { pg.text(r.travelText, M, yy, { size: 10, bold: true, color: primary }); yy += 15; }
        if (r.attendeesText) {
          pg.text('People:', M, yy, { size: 10, bold: true, color: primary });
          const lines = wrap(r.attendeesText, 10, PAGE_W - 2 * M - 52).slice(0, 4);
          lines.forEach((l, k) => pg.text(l, M + 52, yy + k * 13, { size: 10, color: ink }));
          yy += lines.length * 13 + 4;
        }
        if (r.taxInvIssue) { pg.text('NO TAX INVOICE / SUPPLIER ABN – GST may not be claimable', M, yy, { size: 10, bold: true, color: warn }); yy += 15; }
        else if (r.abn) { pg.text(`Supplier ABN ${r.abn}`, M, yy, { size: 9, color: muted }); yy += 13; }
        if (r.attachments && r.attachments.length) {
          pg.text(`${r.attachments.length} supporting document${r.attachments.length === 1 ? '' : 's'} on the following page${r.attachments.length === 1 ? '' : 's'}`, M, yy, { size: 9, color: muted }); yy += 14;
        }
        return yy + 8;
      }, r);
      (r.attachments || []).forEach((a, k) => {
        imagePage(`${r.ref} · supporting ${k + 1}/${r.attachments.length}`, (pg, yy) => {
          pg.text(`Supporting document ${k + 1} of ${r.attachments.length}`, M, yy, { size: 14, bold: true, color: ink }); yy += 17;
          pg.text(`For ${r.ref}: ${r.vendor || ''}  ·  ${fmtDate(r.date)}  ·  ${money(r.amount)}`, M, yy, { size: 10, color: muted });
          return yy + 16;
        }, a);
      });
    });

    pages.forEach((pg, i) => footer(pg, i + 1, pages.length));
    return serialize(pages);
  }

  function fmtDate(iso, short) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return short
      ? dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
      : dt.toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' });
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

  window.ExpensePdf = { buildClaimReport, money, fmtDate };
})();
