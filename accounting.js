/* Accounting: Mentis GL accounts, expense type → GL mapping, Sage upload file, and claim/approval data
   carried inside the claim PDFs (so an approver can open a claim in the app without a server). */
(function (global) {
  'use strict';

  /* ----- GL accounts (from GL_Allocations.xlsx). tax: OC001 GST claimable, OC002 no GST, OC003 GST not claimable ----- */
  const GL_ACCOUNTS = [
    ['200003', 'Fusion Welded Stock Direct Cos', 'OC001'],
    ['200007', 'H/Rail Mild Steel Stock COS', 'OC001'],
    ['200008', 'H/Rail Mild Steel Direct COS', 'OC001'],
    ['300013', 'Consumables', 'OC001'],
    ['300013', 'Pallets', 'OC001'],
    ['300022', 'Tools for Trade', 'OC001'],
    ['300150', 'Freight', 'OC001'],
    ['300153', 'Cartage Miscellaneous', 'OC001'],
    ['304651', 'Fuel', 'OC001'],
    ['304652', 'Dep Of Transport', 'OC002'],
    ['310202', 'Advertising General', 'OC001'],
    ['310300', 'Bank Charges', 'OC002'],
    ['310300', 'Card Fee', 'OC001'],
    ['312002', 'Telstra', 'OC001'],
    ['314050', 'Entertainment', 'OC003'],
    ['314250', 'IT Consumables', 'OC001'],
    ['314252', 'IT Licence', 'OC001'],
    ['314701', 'Postage', 'OC001'],
    ['314703', 'Business Cards', 'OC001'],
    ['314703', 'Stationery', 'OC001'],
    ['315804', 'Prof. Fees- Other S&A', 'OC002'],
    ['515250', 'Personal Expenses', 'OC002'],
    ['317302', 'Job Advertising', 'OC001'],
    ['317306', 'Amenities', 'OC001'],
    ['317306', 'Amenities BBQ', 'OC003'],
    ['317306', 'Amenities Milk/Coffee', 'OC003'],
    ['317400', 'ASIC Search', 'OC002'],
    ['317400', 'Subscriptions S&A', 'OC001'],
    ['317500', 'Car hire', 'OC001'],
    ['317500', 'Car hire fuel', 'OC001'],
    ['317500', 'Flights', 'OC001'],
    ['317500', 'Toll Fee', 'OC001'],
    ['317501', 'Parking', 'OC001'],
    ['317501', 'Taxi', 'OC001'],
    ['317502', 'Accomm Hotel', 'OC001'],
    ['317503', 'Meals', 'OC001'],
    ['500103', 'Computer Hardware - at Cost', 'OC001'],
    ['515051', 'Macrack Expenses', 'OC003'],
  ].map(([code, name, tax]) => ({ key: `${code}|${name}`, code, name, tax }));
  const byKey = new Map(GL_ACCOUNTS.map(g => [g.key, g]));
  const gl = key => byKey.get(key) || null;
  const glLabel = key => { const g = gl(key); return g ? `${g.code} · ${g.name}` : ''; };

  // Default GL account for each preset expense type. Anything else (Other, typed-in types) needs choosing.
  const CATEGORY_GL = {
    'Meals & Entertainment': '314050|Entertainment',
    'Employee Meals – Travelling': '317503|Meals',
    'Employee Meals – Not Travelling': '314050|Entertainment',
    'Staff Amenities': '317306|Amenities',
    'Parking': '317501|Parking',
    'Fuel': '304651|Fuel',
    'Fuel / Mileage': '304651|Fuel',
    'Travel – Air': '317500|Flights',
    'Travel – Ground': '317501|Taxi',
    'Lodging': '317502|Accomm Hotel',
    'Office Supplies': '314703|Stationery',
    'Software / Subscriptions': '314252|IT Licence',
  };
  // Macrack costs paid by Mentis go to the Macrack recharge account whatever the expense type.
  const UNIT_GL = { Macrack: '515051|Macrack Expenses' };
  const defaultGl = (category, unit) => UNIT_GL[unit] || CATEGORY_GL[category] || '';

  /** Sage tax code for a line: the account's code, but GST-claimable accounts with no GST on the receipt
      (overseas purchases, GST-free items) go as OC002. */
  function taxCodeFor(key, { gst, foreign } = {}) {
    const g = gl(key);
    if (!g) return '';
    if (g.tax === 'OC001' && (foreign || !(parseFloat(gst) > 0))) return 'OC002';
    return g.tax;
  }
  /** Net and GST as Sage wants them. OC003 (GST not claimable): the whole amount is the cost, GST 0. */
  function sageAmounts(total, gst, taxCode) {
    const t = Math.round((parseFloat(total) || 0) * 100) / 100;
    const g = taxCode === 'OC001' ? Math.round((parseFloat(gst) || 0) * 100) / 100 : 0;
    return { net: Math.round((t - g) * 100) / 100, gst: g };
  }

  /* ----- Branches / regions (from the Sage sample) ----- */
  const BRANCHES = [
    { code: 'BRI01', label: 'Brisbane', region: 'QUEENL01' },
    { code: 'MEL01', label: 'Melbourne', region: 'VICTOR01' },
    { code: 'PER01', label: 'Perth', region: 'WESTAU01' },
  ];
  const regionFor = branch => (BRANCHES.find(b => b.code === branch) || {}).region || '';

  /* ----- Sage upload file -----
     T header per claim, then for each line an L (GL line) and an A (analysis: department + region).
       T,INV,,<supplier>,<MMMYY> CC <I> <SURNAME>,MOE01,<branch>,<yyyymmdd>,AUD,1,<yyyymmdd>,<supplier>,<yyyymmdd>,PO8,DOM,<MMMYY> CC
       L,1,<branch>,MAU,,<GL>,,,<net>,<tax code>,<GST>,<MMMYY> CC <initials> <VENDOR>,,,,
       A,1,DEP,REG,CUS,SLS,<department>,<region>,,,<net>,,,,,                                          */
  const SAGE = { type: 'INV', entity: 'MOE01', ledger: 'MAU', terms: 'PO8', origin: 'DOM', companyPrefix: 'CC', personalPrefix: 'PR', descMax: 60, cardSupplier: 'BP1001673' };
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const monYY = month => { const [y, m] = String(month).split('-').map(Number); return MONTHS[m - 1] + String(y).slice(2); };
  const ymd = iso => String(iso || '').replace(/-/g, '');
  const csvCell = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const num = n => String(Math.round((Number(n) || 0) * 100) / 100);
  const clean = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[–—]/g, '-').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
  function nameParts(name) {
    const words = clean(name).split(' ').filter(Boolean);
    const first = words[0] || '', last = words.length > 1 ? words[words.length - 1] : '';
    return { first, last, initials: words.map(w => w[0]).join('').toUpperCase() || 'XX' };
  }
  const lastDayOf = month => { const [y, m] = String(month).split('-').map(Number); const d = new Date(Date.UTC(y, m, 0)); return d.toISOString().slice(0, 10); };

  /**
   * claims: [{ month:'2026-08', personal, postDate:'2026-08-31', sage:{ supplier, branch, region, department },
   *            claimant, lines:[{ vendor, gl, taxCode, net, gst }] }]  → CSV text (CRLF, like the sample)
   */
  function buildSageCsv(claims) {
    const rows = [];
    for (const c of claims) {
      const { first, last, initials } = nameParts(c.claimant);
      const prefix = `${monYY(c.month)} ${c.personal ? SAGE.personalPrefix : SAGE.companyPrefix}`;
      const ref = `${prefix} ${first ? first[0].toUpperCase() : ''} ${(last || first).toUpperCase()}`.replace(/\s+/g, ' ').trim();
      const d = ymd(c.postDate || lastDayOf(c.month));
      const s = c.sage;
      rows.push(['T', SAGE.type, '', s.supplier, ref, SAGE.entity, s.branch, d, 'AUD', '1', d, s.supplier, d, SAGE.terms, SAGE.origin, prefix]);
      for (const l of c.lines) {
        const desc = `${prefix} ${initials} ${clean(l.vendor).toUpperCase()}`.slice(0, SAGE.descMax).trim();
        rows.push(['L', '1', s.branch, SAGE.ledger, '', String(l.gl).split('|')[0], '', '', num(l.net), l.taxCode, num(l.gst), desc, '', '', '', '']);
        rows.push(['A', '1', 'DEP', 'REG', 'CUS', 'SLS', s.department, s.region, '', '', num(l.net), '', '', '', '', '']);
      }
    }
    return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  /* ----- Data carried inside our PDFs -----
     Claim and approval PDFs include their data as base64 JSON between markers, so opening the PDF in the
     app (on the approver's or claimant's phone) brings the claim or the decision with it. */
  const BEGIN = '%MENTIS-DATA-BEGIN', END = '%MENTIS-DATA-END';
  function b64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/.{1,76}/g, '$&\n');
  }
  const embedBlock = data => `${BEGIN}\n${b64(JSON.stringify(data))}${END}\n`;
  async function readEmbedded(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const marker = new TextEncoder().encode(BEGIN);
    let at = -1;
    outer: for (let i = buf.length - marker.length; i >= 0; i--) { // the block sits near the end of the file
      for (let k = 0; k < marker.length; k++) if (buf[i + k] !== marker[k]) continue outer;
      at = i; break;
    }
    if (at < 0) return null;
    let text = '';
    for (let i = at + marker.length; i < buf.length && text.length < 8e6; i++) {
      if (buf[i] === 37 /* % */) break;
      text += String.fromCharCode(buf[i]);
    }
    try {
      const bin = atob(text.replace(/\s+/g, ''));
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      const data = JSON.parse(new TextDecoder().decode(bytes));
      return data && /^mentis-/.test(data.kind) ? data : null;
    } catch { return null; }
  }
  /** Short fingerprint of a claim's lines, so an approval can be matched to exactly what was submitted. */
  async function digest(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (global.crypto && crypto.subtle) {
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return [...h.slice(0, 6)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    let h = 2166136261; for (const b of bytes) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16).toUpperCase().padStart(8, '0');
  }

  global.Accounting = {
    GL_ACCOUNTS, gl, glLabel, CATEGORY_GL, UNIT_GL, defaultGl, taxCodeFor, sageAmounts,
    BRANCHES, regionFor, SAGE, monYY, lastDayOf, nameParts, buildSageCsv,
    embedBlock, readEmbedded, digest,
  };
})(typeof window !== 'undefined' ? window : globalThis);
