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
          await w.setParameters({ preserve_interword_spaces: '1' });
          return w;
        })
        .catch(err => { workerPromise = null; throw err; });
    }
    return workerPromise;
  }

  /**
   * Prepare a photo for reading: grey, a little extra contrast, and enlarged so small
   * receipt print is about 30px tall (thermal receipts read far better this way).
   */
  function prepare(canvas) {
    const s = Math.min(2.5, Math.max(1, 1600 / canvas.width));
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.filter = 'grayscale(1) contrast(1.6)';
    x.drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }

  /** Run OCR on a canvas; mode '6' = one block of text, '4' = column of lines. */
  async function readText(canvas, mode = '6') {
    const worker = await getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: mode });
    const { data } = await worker.recognize(prepare(canvas));
    return data.text || '';
  }

  /** Read the receipt; if the first pass misses the money lines, try a second layout and combine. */
  async function readReceipt(canvas) {
    let text = await readText(canvas, '6');
    let r = parseReceipt(text);
    if (r.method === 'none' || !r.gstFound) {
      const more = await readText(canvas, '4');
      const merged = parseReceipt(text + '\n' + more);
      if (merged.total != null && (r.total == null || !r.gstFound)) { r = { ...merged, vendor: r.vendor || merged.vendor }; text += '\n' + more; }
    }
    return { text, ...r };
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

  const TOTAL_WORD = /\b(grand\s*total|tota[l1]|t0tal|amount\s*(due|payable|paid)|balance\s*due|to\s*pay|eftpos|visa|mastercard|amex|card|purchase)\b/i;
  const SUBTOTAL_WORD = /\b(sub\s*-?\s*total|ex\.?\s*g\.?s\.?t|excl?\.?\s*g\.?s\.?t|excluding\s*g\.?s\.?t|before\s*g\.?s\.?t|pre\s*-?\s*g\.?s\.?t|net(\s*amount|\s*tota[l1)]?)?)(\b|$)/i;
  // GST label, allowing for common misreads like "G.5.T", "GEST", "G S T", or a "10%" rate.
  const GST_WORD = /(\bg\s?\.?\s?[s5]\s?\.?\s?t\b|\bgest\b|\btax\b|\b10\s?%)/i;
  // Lines whose amounts are never the total: cash handed over, change, points, savings…
  const IGNORE_LINE = /\b(cash|tendered|change|rounding|savings?|saved|you\s*saved|discount|points|rewards?|tip|gift\s*card\s*bal)/i;
  const DATE_TIME = /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b|\b\d{1,2}:\d{2}(:\d{2})?\b/g;
  const near = (a, b, tol = 0.011) => Math.abs(a - b) <= tol;

  /** Every dollar amount on the receipt, tagged with what its line says. */
  function collectAmounts(lines) {
    const out = [];
    lines.forEach((l, i) => {
      const isTotal = TOTAL_WORD.test(l);
      if (IGNORE_LINE.test(l) && !isTotal) return;
      const stripped = l.replace(DATE_TIME, ' ');
      for (const v of amountsIn(stripped)) {
        if (v <= 0 || v >= 100000) continue;
        const isSub = SUBTOTAL_WORD.test(l);
        const isGst = GST_WORD.test(l) && !isSub;
        out.push({ v, i, line: l, isTotal: isTotal && !isSub && !/\bincludes?\b/i.test(l), isGst, isSub });
      }
    });
    return out;
  }

  /**
   * Work out total and GST using the receipt's own arithmetic:
   *   1. Look for three figures where  ex-GST + GST = total  (e.g. 30.00 + 3.00 = 33.00).
   *      The GST should sit on a GST line, or be about 1/11 of the total.
   *   2. Otherwise the total is the highest dollar value on the receipt
   *      (ignoring cash handed over, change, points and similar).
   *   3. GST is then the amount on a GST line closest to 1/11 of the total.
   */
  function findAmounts(lines) {
    const amts = collectAmounts(lines);
    if (!amts.length) return { total: null, gst: null, gstFound: false, method: 'none' };
    const values = [...new Set(amts.map(a => a.v))].sort((a, b) => b - a);
    const tagged = (v, key) => amts.some(a => near(a.v, v, 0.001) && a[key]);

    // 1. ex + gst = total
    let best = null;
    for (const c of values) {
      for (const b of values) {
        if (b >= c / 2) continue;
        const a = c - b;
        if (!values.some(x => near(x, a))) continue;
        const gstLabel = tagged(b, 'isGst');
        const exLabel = tagged(a, 'isSub');
        const totalLabel = tagged(c, 'isTotal');
        const oneEleventh = near(b, c / 11, Math.max(0.02, c * 0.002));
        if (!gstLabel && !oneEleventh) continue; // two items happening to add up – ignore
        const score = (gstLabel ? 3 : 0) + (exLabel ? 2 : 0) + (totalLabel ? 2 : 0) + (oneEleventh ? 1 : 0);
        if (score < 3 && !(oneEleventh && c === values[0])) continue; // unlabelled: only trust it for the top amount
        if (!best || score > best.score || (score === best.score && c > best.total)) best = { total: c, gst: b, ex: a, score };
      }
    }
    if (best) return { total: best.total, gst: best.gst, gstFound: true, method: 'sum' };

    // 1b. Net + GST where GST is 10% of net (e.g. 62.73 + 6.27 = 69.00), even if the
    //     total itself didn't read cleanly.
    let pair = null;
    for (const a of values) for (const b of values) {
      if (b >= a || !near(b, a * 0.1, Math.max(0.02, a * 0.001))) continue;
      if (!tagged(b, 'isGst') && !tagged(a, 'isSub')) continue;
      const c = Math.round((a + b) * 100) / 100;
      if (!pair || c > pair.total) pair = { total: c, gst: b };
    }
    const labelledTotals = amts.filter(x => x.isTotal).map(x => x.v);
    if (pair && !labelledTotals.some(v => v > pair.total * 1.01)) return { total: pair.total, gst: pair.gst, gstFound: true, method: 'net+gst' };

    // 2. Highest dollar value – unless it looks like an OCR misread next to a labelled total.
    let total = values[0];
    if (labelledTotals.length && !labelledTotals.some(v => near(v, total))) {
      const top = Math.max(...labelledTotals);
      // A total printed on two or more TOTAL lines beats a stray bigger number (often a misread).
      const repeated = labelledTotals.filter(v => near(v, top)).length >= 2;
      if (repeated || total > top * 3) total = top;
    }

    // 3. GST line amount closest to 1/11 of the total.
    const expected = total / 11;
    const gstCands = amts.filter(a => a.isGst && a.v < total / 2).map(a => a.v)
      .sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected));
    if (gstCands.length) return { total, gst: gstCands[0], gstFound: true, method: 'highest' };
    return { total, gst: null, gstFound: false, method: 'highest' };
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

  /** Turn OCR text into { vendor, total, gst, gstFound, method, date, abn }. */
  function parseReceipt(text) {
    const lines = String(text).split(/\r?\n/).map(cleanLine).filter(Boolean);
    const { total, gst, gstFound, method } = findAmounts(lines);
    return {
      vendor: findVendor(lines),
      total: total != null ? round2(total) : null,
      gst: gstFound ? round2(gst) : (total != null ? gstFromTotal(total) : null),
      gstFound,
      method,
      date: findDate(lines),
      abn: findAbn(text),
      category: guessCategory(text),
    };
  }

  /* ---------------- Expense type guess ---------------- */
  const CATEGORY_HINTS = [
    ['Parking', /\b(parking|car\s*park|carpark|wilson|secure\s*parking|care\s*park|first\s*parking|entry\s*time|exit\s*time|park\s*fee)\b/i],
    ['Fuel', /\b(unleaded|diesel|e10|ulp|premium\s*9[58]|vortex|v-?power|fuel|petrol|litres?|ampol|caltex|shell|bp\b|7-?eleven|united\s*petroleum|puma\s*energy|liberty\s*oil|metro\s*petroleum|\d+(\.\d+)?\s*l\s*@)/i],
    ['Travel – Air', /\b(qantas|virgin\s*australia|jetstar|rex\s*airlines|airline|flight|boarding\s*pass)\b/i],
    ['Travel – Ground', /\b(uber|taxi|13\s*cabs|cabcharge|didi|ola\b|rideshare|toll|linkt|e-?tag|opal|myki|go\s*card|train|bus\s*fare)\b/i],
    ['Lodging', /\b(hotel|motel|suites|accommodation|airbnb|resort|lodge|serviced\s*apartments?|check-?in|check-?out|room\s*\d+)\b/i],
    ['Office Supplies', /\b(officeworks|stationery|printer|toner|ink\s*cartridge|copy\s*paper|post\s*office|australia\s*post)\b/i],
    ['Software / Subscriptions', /\b(subscription|software|licen[cs]e|microsoft|adobe|google\s*(workspace|cloud)|apple\.com|zoom|dropbox|atlassian)\b/i],
    ['Meals & Entertainment', /\b(cafe|café|coffee|espresso|latte|flat\s*white|cappuccino|restaurant|bistro|bar|pub|tavern|brewery|grill|kitchen|eatery|dining|diner|burger|pizza|sushi|thai|noodle|bakery|lunch|dinner|breakfast|table\s*\d+|covers?|gratuity)\b/i],
    ['Staff Amenities', /\b(woolworths|coles|aldi|iga|foodworks|harris\s*farm|costco|milk|tea\s*bags?|biscuits|sugar|paper\s*towel|dishwash|detergent|cleaning)\b/i],
  ];
  function guessCategory(text) {
    for (const [cat, re] of CATEGORY_HINTS) if (re.test(text)) return cat;
    return '';
  }

  const api = { readText, readReceipt, parseReceipt, guessCategory, gstFromTotal, round2, GST_RATE };
  global.ReceiptOcr = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
