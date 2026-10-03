/* Bank statement import (CSV / OFX / QFX / QIF) and matching against expense claims. */
(function (global) {
  'use strict';

  /* ---------------- Parsing helpers ---------------- */
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const validYMD = (y, m, d) => y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;

  /** Australian-style dates: 12/09/2026, 12-09-26, 2026-09-12, 12 Sep 2026, 20260912 */
  function parseDate(s) {
    s = String(s || '').trim().replace(/^"|"$/g, '');
    let m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(s);
    if (m) { const [y, mo, d] = [+m[1], +m[2], +m[3]]; return validYMD(y, mo, d) ? iso(y, mo, d) : null; }
    m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})\b/.exec(s);
    if (m) {
      let [d, mo, y] = [+m[1], +m[2], +m[3]];
      if (y < 100) y += 2000;
      if (mo > 12 && d <= 12) [d, mo] = [mo, d];
      return validYMD(y, mo, d) ? iso(y, mo, d) : null;
    }
    m = /^(\d{1,2})[\s\-]*([a-z]{3,4})[a-z]*[\s\-,]*(\d{2,4})/i.exec(s);
    if (m && MONTHS[m[2].toLowerCase()]) {
      let y = +m[3]; if (y < 100) y += 2000;
      const mo = MONTHS[m[2].toLowerCase()], d = +m[1];
      return validYMD(y, mo, d) ? iso(y, mo, d) : null;
    }
    m = /^(\d{4})(\d{2})(\d{2})/.exec(s); // OFX 20260912...
    if (m) { const [y, mo, d] = [+m[1], +m[2], +m[3]]; return validYMD(y, mo, d) ? iso(y, mo, d) : null; }
    return null;
  }

  /** "$1,234.56", "-12.30", "(12.30)", "12.30 DR", "12.30CR" → number (DR / brackets = negative) */
  function parseAmount(s) {
    s = String(s ?? '').trim().replace(/^"|"$/g, '');
    if (!s || !/\d/.test(s)) return null;
    let neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s) || /\bdr\b|dr$/i.test(s);
    const cleaned = s.replace(/[^0-9.]/g, '');
    if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') return null;
    const v = parseFloat(cleaned);
    if (!isFinite(v)) return null;
    if (/\bcr\b|cr$/i.test(s)) neg = false;
    return neg ? -v : v;
  }

  function splitCsvLine(line, sep) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  /* ---------------- CSV with automatic column detection ---------------- */
  function parseCsv(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return { transactions: [], note: 'The file is empty.' };
    const sep = [',', ';', '\t'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
    let rows = lines.map(l => splitCsvLine(l, sep));

    // Find where the data starts (some banks put account details above the table).
    const isDataRow = r => r.some(c => parseDate(c)) && r.some(c => parseAmount(c) != null && !parseDate(c));
    let start = rows.findIndex(isDataRow);
    if (start < 0) return { transactions: [], note: 'Couldn’t find dates and amounts in this file.' };
    const header = start > 0 ? rows[start - 1].map(h => h.toLowerCase()) : [];
    rows = rows.slice(start).filter(isDataRow);
    const nCols = Math.max(...rows.map(r => r.length));

    const stats = Array.from({ length: nCols }, (_, c) => {
      let dates = 0, nums = 0, text = 0, absSum = 0, neg = 0, filled = 0;
      for (const r of rows) {
        const v = r[c] ?? '';
        if (v) filled++;
        if (parseDate(v)) dates++;
        else {
          const a = parseAmount(v);
          if (a != null && /^[\s$()\-+.,0-9a-z]*$/i.test(v) && !/[a-z]{3,}/i.test(v)) { nums++; absSum += Math.abs(a); if (a < 0) neg++; }
          else if (v) text += v.length;
        }
      }
      return { c, dates, nums, text, avg: nums ? absSum / nums : 0, neg, filled, h: header[c] || '' };
    });

    const dateCol = stats.slice().sort((a, b) => b.dates - a.dates)[0].c;
    const byHeader = re => stats.find(s => re.test(s.h));
    const debitCol = byHeader(/debit|withdraw|money out|paid out|spent/);
    const creditCol = byHeader(/credit|deposit|money in|paid in/);
    const amountCol = byHeader(/^amount|amount$|amount \(|transaction amount|value/) ;
    const descCol = byHeader(/desc|narrat|detail|particular|payee|merchant|transaction$|memo|reference/) ||
      stats.filter(s => s.c !== dateCol).sort((a, b) => b.text - a.text)[0];
    const numericCols = stats.filter(s => s.c !== dateCol && s.nums >= rows.length * 0.5 && !/balance/.test(s.h));

    let getSpend, note = '';
    if (debitCol && debitCol !== creditCol) {
      getSpend = r => { const v = parseAmount(r[debitCol.c]); return v ? Math.abs(v) : null; };
    } else {
      // One amount column: on bank accounts spending is negative; on some card exports it's positive.
      const col = amountCol || numericCols.sort((a, b) => a.avg - b.avg)[0];
      if (!col) return { transactions: [], note: 'Couldn’t find the amount column.' };
      const negShare = col.neg / Math.max(1, col.nums);
      const spendNegative = negShare >= 0.5;
      note = spendNegative ? '' : 'Spending shows as positive amounts in this file.';
      getSpend = r => {
        const v = parseAmount(r[col.c]);
        if (v == null) return null;
        return spendNegative ? (v < 0 ? -v : null) : (v > 0 ? v : null);
      };
    }

    const transactions = [];
    for (const r of rows) {
      const date = parseDate(r[dateCol]);
      const amount = getSpend(r);
      if (!date || !amount) continue;
      const desc = (descCol ? r[descCol.c] : r.filter((_, i) => i !== dateCol).join(' ')) || '';
      transactions.push({ date, amount: Math.round(amount * 100) / 100, desc: desc.replace(/\s+/g, ' ').trim() });
    }
    return { transactions, note };
  }

  /* ---------------- OFX / QFX ---------------- */
  function parseOfx(text) {
    const transactions = [];
    const blocks = text.split(/<STMTTRN>/i).slice(1);
    for (const b of blocks) {
      const tag = t => { const m = new RegExp(`<${t}>([^<\\r\\n]*)`, 'i').exec(b); return m ? m[1].trim() : ''; };
      const date = parseDate(tag('DTPOSTED'));
      const amt = parseAmount(tag('TRNAMT'));
      if (!date || amt == null || amt >= 0) continue;
      transactions.push({ date, amount: Math.round(-amt * 100) / 100, desc: [tag('NAME'), tag('MEMO')].filter(Boolean).join(' ') });
    }
    return { transactions, note: '' };
  }

  /* ---------------- QIF ---------------- */
  function parseQif(text) {
    const transactions = [];
    for (const rec of text.split(/^\^/m)) {
      let date = null, amt = null, desc = '';
      for (const line of rec.split(/\r?\n/)) {
        const k = line[0], v = line.slice(1).trim();
        if (k === 'D') date = parseDate(v.replace(/'/g, '/'));
        else if (k === 'T' || k === 'U') amt = parseAmount(v);
        else if (k === 'P' || (k === 'M' && !desc)) desc = v;
      }
      if (date && amt != null && amt < 0) transactions.push({ date, amount: Math.round(-amt * 100) / 100, desc });
    }
    return { transactions, note: '' };
  }

  function parseStatement(text, filename = '') {
    let out;
    if (/<OFX>|<STMTTRN>/i.test(text) || /\.(ofx|qfx)$/i.test(filename)) out = parseOfx(text);
    else if (/^!Type:/im.test(text) || /\.qif$/i.test(filename)) out = parseQif(text);
    else out = parseCsv(text);
    out.transactions.sort((a, b) => a.date.localeCompare(b.date));
    out.transactions.forEach((t, i) => { t.key = `${t.date}|${t.amount.toFixed(2)}|${t.desc.toLowerCase().slice(0, 40)}|${i}`; });
    if (out.transactions.length) {
      out.from = out.transactions[0].date;
      out.to = out.transactions[out.transactions.length - 1].date;
    }
    return out;
  }

  /* ---------------- Matching ---------------- */
  const STOP = new Set('pty ltd the and aus au australia qld nsw vic wa sa tas act nt card visa mastercard eftpos purchase debit credit value date tap pay paypal sq square ref receipt tax invoice inv www com net'.split(' '));
  const tokens = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  function similarity(a, b) {
    const A = tokens(a), B = new Set(tokens(b));
    if (!A.length || !B.size) return 0;
    let hit = 0;
    for (const w of A) if (B.has(w) || [...B].some(x => x.length >= 4 && w.length >= 4 && (x.startsWith(w) || w.startsWith(x)))) hit++;
    return hit / Math.min(A.length, B.size);
  }
  const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
  const shift = (isoDate, n) => new Date(Date.parse(isoDate) + n * 86400000).toISOString().slice(0, 10);

  /**
   * Compare statement transactions with claims.
   * Returns { matched, mismatched, unclaimed, notOnStatement } – see app for how each is shown.
   */
  function reconcile(transactions, receipts, { from, to } = {}) {
    const lo = from ? shift(from, -5) : '0000', hi = to ? shift(to, 2) : '9999';
    const claims = receipts.filter(r => r.date && r.date >= lo && r.date <= hi && parseFloat(r.amount));
    const usedT = new Set(), usedR = new Set();
    const matched = [], mismatched = [];
    const name = r => [r.vendor, r.purpose].filter(Boolean).join(' ');

    // 1. Same amount, dates within 5 days (cards often post a few days after the purchase).
    const pairs = [];
    transactions.forEach((t, ti) => claims.forEach((r, ri) => {
      const amt = parseFloat(r.amount);
      if (Math.abs(amt - t.amount) > 0.01) return;
      const d = days(t.date, r.date);
      if (d > 5) return;
      pairs.push({ ti, ri, score: d - similarity(r.vendor, t.desc) * 3 });
    }));
    pairs.sort((a, b) => a.score - b.score);
    for (const p of pairs) {
      if (usedT.has(p.ti) || usedR.has(p.ri)) continue;
      usedT.add(p.ti); usedR.add(p.ri);
      matched.push({ tx: transactions[p.ti], claim: claims[p.ri] });
    }

    // 2. Probably the same purchase but something is wrong: same vendor and close date but a
    //    different amount, or same amount and vendor but the claim date is well off.
    const near = [];
    transactions.forEach((t, ti) => {
      if (usedT.has(ti)) return;
      claims.forEach((r, ri) => {
        if (usedR.has(ri)) return;
        const sim = similarity(r.vendor || name(r), t.desc);
        const amt = parseFloat(r.amount);
        const d = days(t.date, r.date);
        const sameAmt = Math.abs(amt - t.amount) <= 0.01;
        if (!sameAmt && sim >= 0.5 && d <= 3) near.push({ ti, ri, kind: 'amount', score: d + Math.abs(amt - t.amount) / Math.max(amt, t.amount) });
        else if (sameAmt && sim >= 0.5 && d > 5 && d <= 45) near.push({ ti, ri, kind: 'date', score: 10 + d });
        else if (!sameAmt && sim < 0.5 && d <= 1 && Math.abs(amt - t.amount) <= Math.max(1, t.amount * 0.1)) near.push({ ti, ri, kind: 'amount', score: 20 + d });
      });
    });
    near.sort((a, b) => a.score - b.score);
    for (const p of near) {
      if (usedT.has(p.ti) || usedR.has(p.ri)) continue;
      usedT.add(p.ti); usedR.add(p.ri);
      const t = transactions[p.ti], r = claims[p.ri];
      mismatched.push({
        tx: t, claim: r, kind: p.kind,
        issue: p.kind === 'amount'
          ? `Claimed $${parseFloat(r.amount).toFixed(2)} but the bank shows $${t.amount.toFixed(2)}`
          : `Claim dated ${r.date} but the bank shows ${t.date}`,
      });
    }

    const unclaimed = transactions.filter((_, i) => !usedT.has(i));
    const notOnStatement = claims.filter((_, i) => !usedR.has(i));
    return { matched, mismatched, unclaimed, notOnStatement };
  }

  const api = { parseStatement, reconcile, parseDate, parseAmount, similarity };
  global.Recon = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
