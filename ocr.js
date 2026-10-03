/* Reads receipt text on the phone (Tesseract OCR) and pulls out vendor, total, GST and date. */
(function (global) {
  'use strict';

  const GST_RATE = 0.10; // Australian GST: GST = total / 11 on a GST-inclusive price
  const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

  /** GST included in a GST-inclusive total, e.g. 11.00 -> 1.00 */
  const gstFromTotal = total => round2(total * GST_RATE / (1 + GST_RATE));

  /* ---------------- OCR engine (loaded on first use, then cached) ---------------- */
  const CDN = {
    script: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
    langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
  };
  let workerPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (global.Tesseract) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the receipt reader (are you offline?)'));
      document.head.appendChild(s);
    });
  }

  function getWorker() {
    if (!workerPromise) {
      const paths = { ...CDN, ...(global.OCR_PATHS || {}) };
      workerPromise = loadScript(paths.script)
        .then(() => global.Tesseract.createWorker('eng', 1, {
          workerPath: paths.workerPath, corePath: paths.corePath, langPath: paths.langPath,
        }))
        .then(async w => {
          await w.setParameters({ tessedit_pageseg_mode: '4', preserve_interword_spaces: '1' }); // single column of text
          return w;
        })
        .catch(err => { workerPromise = null; throw err; });
    }
    return workerPromise;
  }

  /** Run OCR on a canvas/image/blob; returns plain text. */
  async function readText(image) {
    const worker = await getWorker();
    const { data } = await worker.recognize(image);
    return data.text || '';
  }

  /* ---------------- Receipt parsing ---------------- */
  // Money like 12.34, $1,234.56, 12,34 (OCR often turns . into ,), 12. 34
  const MONEY = /(-?)\$?\s?(\d{1,3}(?:,\d{3})+|\d+)\s?[.,]\s?(\d{2})(?!\d)/g;

  function amountsIn(line) {
    const out = [];
    let m;
    MONEY.lastIndex = 0;
    while ((m = MONEY.exec(line))) {
      const v = parseFloat(m[2].replace(/,/g, '') + '.' + m[3]);
      if (!m[1] && isFinite(v)) out.push(v);
    }
    return out;
  }

  function cleanLine(l) {
    return l.replace(/[|_~`^*<>«»{}\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const NOT_VENDOR = /\b(tax\s*invoice|invoice|receipt|abn|acn|ph(one)?|tel|fax|www\.|\.com|@|date|time|table|order|cashier|server|operator|terminal|eftpos|welcome|thank|docket|trans|store\s*#?\d|shop\s*\d|level\s*\d|street|st\b|road|rd\b|ave\b|avenue|hwy|highway|drive|dr\b|lane|nsw|vic|qld|wa\b|sa\b|tas|act\b|nt\b|australia)\b/i;

  function findVendor(lines) {
    const top = lines.slice(0, 8);
    // A registered business name in the header is the best signal.
    const company = top.find(l => /\b(pty\.?\s*ltd|limited|ltd|inc|group|holdings)\b/i.test(l) && letters(l) >= 4);
    if (company) return tidyName(company);
    let best = null, bestScore = 0;
    top.forEach((l, i) => {
      const n = letters(l);
      if (n < 3 || NOT_VENDOR.test(l) || amountsIn(l).length || /\d{2}[\/.-]\d{2}/.test(l)) return;
      const ratio = n / l.replace(/\s/g, '').length;
      if (ratio < 0.6) return;
      const upper = l === l.toUpperCase() ? 1.3 : 1;
      const score = Math.min(n, 24) * ratio * upper * (1 - i * 0.1);
      if (score > bestScore) { bestScore = score; best = l; }
    });
    return best ? tidyName(best) : '';
  }
  const letters = s => (s.match(/[a-z]/gi) || []).length;
  function tidyName(s) {
    s = s.replace(/[^\w&'’.\- ]/g, ' ').replace(/\s+/g, ' ').trim();
    // Title-case shouty names: "CAFE ROMA PTY LTD" -> "Cafe Roma Pty Ltd"
    if (s === s.toUpperCase()) s = s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bPty\b/, 'Pty').replace(/\bLtd\b/, 'Ltd');
    return s.slice(0, 60);
  }

  const TOTAL_WORDS = [
    [/\b(grand\s*total|total\s*(amount|due|payable|aud|inc|incl)|amount\s*(due|payable|paid)|balance\s*(due)?|to\s*pay)\b/i, 5],
    [/\btota[l1]\b|\bt0tal\b/i, 4],
    [/\b(eftpos|visa|mastercard|master\s*card|amex|credit|debit|card|paid|purchase)\b/i, 2],
  ];
  const NOT_TOTAL = /\b(sub\s*-?\s*total|subtotal|change|cash\s*out|rounding|savings?|discount|points|tip)\b/i;
  const GST_WORD = /\b(g\.?s\.?t|tax)\b/i;

  function findTotal(lines) {
    let best = null;
    lines.forEach((l, i) => {
      if (NOT_TOTAL.test(l)) return;
      const amts = amountsIn(l);
      if (!amts.length) return;
      // "Total includes GST $1.00" is a GST line, not the total.
      if (GST_WORD.test(l) && !/\b(inc|incl|including)\b.*\btotal\b|\btotal\b.*\b(inc|incl)\b/i.test(l)) return;
      if (/\bincludes?\b.*\bg\.?s\.?t\b/i.test(l)) return;
      for (const [re, weight] of TOTAL_WORDS) {
        if (re.test(l)) {
          const score = weight + i / lines.length; // later lines win ties
          const value = amts[amts.length - 1];
          if (!best || score > best.score) best = { value, score };
          break;
        }
      }
    });
    if (best) return best.value;
    // Fallback: the biggest amount on the receipt.
    const all = lines.flatMap(amountsIn).filter(v => v < 100000);
    return all.length ? Math.max(...all) : null;
  }

  function findGst(lines, total) {
    const candidates = [];
    lines.forEach(l => {
      if (!GST_WORD.test(l)) return;
      if (/\b(ex|excl|excluding)\b/i.test(l)) return; // "Total ex GST"
      for (const v of amountsIn(l)) {
        if (total == null || (v > 0 && v < total * 0.5)) candidates.push(v);
      }
    });
    if (!candidates.length) return null;
    if (total == null) return candidates[candidates.length - 1];
    // Prefer the candidate closest to 1/11th of the total.
    const expected = total / 11;
    return candidates.sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected))[0];
  }

  function findDate(lines) {
    for (const l of lines) {
      // Australian order: day/month/year
      let m = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/.exec(l);
      if (m) {
        let [, d, mo, y] = m.map(Number);
        if (y < 100) y += 2000;
        if (mo > 12 && d <= 12) [d, mo] = [mo, d];
        if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100) return iso(y, mo, d);
      }
      m = /\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{2,4})\b/i.exec(l);
      if (m) {
        let y = Number(m[3]); if (y < 100) y += 2000;
        const mo = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[2].toLowerCase()) / 3 + 1;
        return iso(y, mo, Number(m[1]));
      }
    }
    return '';
  }
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  function findAbn(text) {
    const m = /\bA\.?B\.?N\.?[:\s#]*((?:\d\s?){11})\b/i.exec(text);
    return m ? m[1].replace(/\s/g, '').replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4') : '';
  }

  /** Turn OCR text into { vendor, total, gst, gstFound, date, abn }. */
  function parseReceipt(text) {
    const lines = String(text).split(/\r?\n/).map(cleanLine).filter(Boolean);
    const total = findTotal(lines);
    const found = findGst(lines, total);
    return {
      vendor: findVendor(lines),
      total: total != null ? round2(total) : null,
      gst: found != null ? round2(found) : (total != null ? gstFromTotal(total) : null),
      gstFound: found != null,
      date: findDate(lines),
      abn: findAbn(text),
    };
  }

  const api = { readText, parseReceipt, gstFromTotal, round2, GST_RATE };
  global.ReceiptOcr = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
