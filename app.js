/* Mentis Expenses – receipt capture and monthly claims. Everything is stored on the device. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const MAX_WORK_SIDE = 2400;
  const APP_VERSION = '16';
  const UNITS = ['Mentis', 'Macrack'];

  /* ---------------- Storage ---------------- */
  // receipts: one row per receipt (photos included). claims: one row per month ('2026-09').
  const db = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const req = indexedDB.open('mentis-expenses', 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('receipts')) d.createObjectStore('receipts', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('claims')) d.createObjectStore('claims', { keyPath: 'month' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    }));
    const tx = async (store, mode, fn) => {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(store, mode);
        const r = fn(t.objectStore(store));
        t.oncomplete = () => res(r && r.result);
        t.onerror = () => rej(t.error);
      });
    };
    const api = store => ({
      all: () => tx(store, 'readonly', s => s.getAll()),
      get: id => tx(store, 'readonly', s => s.get(id)),
      put: rec => tx(store, 'readwrite', s => s.put(rec)),
      del: id => tx(store, 'readwrite', s => s.delete(id)),
    });
    return { ...api('receipts'), claims: api('claims') };
  })();

  const SETTINGS_KEY = 'mentis-expenses-settings';
  const defaults = { name: '', emails: [], lastEmail: '', lastUnit: '', logo: '', primary: '#0b2a4a', accent: '#00a6a6', enhance: true, reconIgnore: [], statement: null };
  let settings = load();
  function load() {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
    catch { return { ...defaults }; }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
    catch { toast('Could not save settings (storage full?)'); }
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* ---------------- UI helpers ---------------- */
  const views = ['listView', 'cropView', 'editView', 'settingsView', 'reconView', 'dashView'];
  const titles = { listView: 'Claims', cropView: 'Crop', editView: 'Receipt', settingsView: 'Settings', reconView: 'Reconcile', dashView: 'Spending' };
  function show(view) {
    views.forEach(v => { $(v).hidden = v !== view; });
    $('viewTitle').textContent = titles[view];
    $('settingsBtn').hidden = view !== 'listView';
    $('reconBtn').hidden = view !== 'listView';
    $('dashBtn').hidden = view !== 'listView';
    window.scrollTo(0, 0);
  }
  let toastTimer;
  function toast(msg, ms = 3000) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  const busy = on => { $('busy').hidden = !on; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const money = n => ExpensePdf.money(n);
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toBlob = (canvas, type = 'image/jpeg', q = 0.85) => new Promise(r => canvas.toBlob(r, type, q));
  const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const plural = (n, w) => `${n} ${n === 1 ? w : w === 'person' ? 'people' : w + 's'}`;
  const safeFile = s => String(s || '').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');
  const fmtDay = iso => iso ? ExpensePdf.fmtDate(iso) : '';

  /* ---------------- Months & claims ----------------
     Every receipt belongs to the month of its date. A month's claim is:
       open      – not submitted yet (editable)
       submitted – sent; its receipts are locked
       reopened  – unlocked after submitting; resubmitting includes an exception report */
  const monthOf = r => (r.date || todayISO()).slice(0, 7);
  /* A month has up to two claims: company card (key '2026-09') and personal reimbursement ('2026-09~personal'),
     each submitted, locked and reopened on its own. */
  const PERSONAL = '~personal';
  const isPersonalKey = k => String(k).endsWith(PERSONAL);
  const monthOfKey = k => String(k).replace(PERSONAL, '');
  const claimKeyOf = r => monthOf(r) + (r.payment === 'personal' ? PERSONAL : '');
  const monthLabel = k => { const [y, mo] = monthOfKey(k).split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }) + (isPersonalKey(k) ? ' – personal reimbursement' : ''); };
  async function getClaim(month) { return (await db.claims.get(month)) || { month, status: 'open', submissions: [] }; }
  async function isLocked(month) { return (await getClaim(month)).status === 'submitted'; }

  // What accounts sees as a change: these fields, compared with the last submission.
  const TRACKED = [
    ['date', 'Date'], ['vendor', 'Vendor'], ['purpose', 'Purpose'], ['unit', 'Business unit'], ['category', 'Expense type'],
    ['amount', 'Total (AUD)'], ['gst', 'GST'], ['currency', 'Currency'], ['fxAmount', 'Foreign amount'], ['audBasis', 'AUD amount basis'], ['hasReceipt', 'Receipt'], ['attachCount', 'Supporting documents'], ['imageVer', 'Receipt image'], ['attendeesText', 'Attendees'], ['abn', 'Supplier ABN'], ['travelStatus', 'Employee travelling'],
  ];
  const snapshotOf = (r, ref) => ({
    id: r.lineKey || r.id, ref, attendeesText: r.attendeesText || '', abn: r.abn || '', travelStatus: travelText(r), date: r.date || '', vendor: r.vendor || '', purpose: r.purpose || '', unit: r.unit || '', category: r.category || '',
    amount: r.amount || '', gst: r.gst || '', currency: r.currency || 'AUD', fxAmount: r.fxAmount || '', audBasis: r.audBasis || '', hasReceipt: !!r.image, attachCount: (r.attachments || []).length, imageVer: r.imageVer || 0,
  });
  const showVal = (k, v) => (k === 'amount' || k === 'gst') ? (v === '' ? '(blank)' : money(v)) : k === 'imageVer' ? 'version ' + (v + 1) : k === 'date' ? fmtDay(v) : (v === '' ? '(blank)' : String(v));

  /** Differences between the last submission of a month and its receipts now. */
  function exceptionsFor(claim, current) {
    const last = claim.submissions[claim.submissions.length - 1];
    if (!last) return [];
    const out = [];
    const now = new Map(current.map(c => [c.id, c]));
    for (const old of last.items) {
      const cur = now.get(old.id);
      if (!cur) { out.push({ ref: old.ref, type: 'Removed', vendor: old.vendor, detail: `Removed from the claim (was ${money(old.amount)} on ${fmtDay(old.date)}, ${old.unit})` }); continue; }
      const changes = TRACKED.filter(([k]) => k in old && String(old[k] ?? '') !== String(cur[k] ?? '')) // fields added in later versions aren't in older snapshots
        .filter(([k]) => !(k === 'imageVer' && !old.hasReceipt)) // first receipt photo is reported as "added", not "replaced"
        .map(([k, label]) => k === 'imageVer' ? 'Receipt image replaced'
          : k === 'hasReceipt' ? (cur.hasReceipt ? 'Receipt photo added' : 'Receipt photo removed')
          : `${label}: ${showVal(k, old[k])} → ${showVal(k, cur[k])}`);
      if (changes.length) out.push({ ref: cur.ref, type: 'Changed', vendor: cur.vendor, detail: changes.join('; ') });
    }
    const oldIds = new Set(last.items.map(i => i.id));
    for (const cur of current) if (!oldIds.has(cur.id)) {
      out.push({ ref: cur.ref, type: 'Added', vendor: cur.vendor, detail: `New receipt: ${money(cur.amount)} on ${fmtDay(cur.date)}, ${cur.unit}` });
    }
    return out;
  }

  /* ----- Foreign currency -----
     A receipt keeps its own currency's total/GST in amount/gst. For a non-AUD receipt the AUD the card
     was actually charged is in audAmount (from the bank statement or typed in). Everything that adds up
     money – claim totals, PDF, spreadsheet, reconciliation – works from the AUD view below. */
  const isForeign = r => !!r.currency && r.currency !== 'AUD';
  // audAmount is the real figure (bank statement / typed). Until it exists, audEstimate – from the
  // day's exchange rate – stands in, shown greyed and marked as an estimate.
  const hasActualAud = r => r.audAmount !== '' && r.audAmount != null;
  function audView(r, { actualOnly = false } = {}) {
    if (!isForeign(r)) return r;
    const estimated = !hasActualAud(r) && !actualOnly && r.audEstimate !== '' && r.audEstimate != null;
    const aud = hasActualAud(r) ? String(r.audAmount) : estimated ? String(r.audEstimate) : '';
    const fx = parseFloat(r.amount);
    const rate = aud !== '' && fx ? parseFloat(aud) / fx : null;
    const gst = aud === '' ? '' : ((parseFloat(r.gst) || 0) && rate ? (Math.round(parseFloat(r.gst) * rate * 100) / 100).toFixed(2) : '0.00');
    return { ...r, fxAmount: r.amount, fxGst: r.gst, amount: aud, gst, rate, audEstimated: estimated, audBasis: hasActualAud(r) ? (r.audSource === 'bank' ? 'bank' : 'entered') : estimated ? 'estimate' : '' };
  }

  /** Daily exchange rate to AUD for a currency on a date (cached). Returns { rate, date } or null. */
  const FX_CACHE_KEY = 'mentis-fx-cache';
  async function fxRate(cur, date) {
    if (!cur || cur === 'AUD' || !date) return null;
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(FX_CACHE_KEY) || '{}'); } catch { /* ignore */ }
    const key = `${cur}|${date}`;
    if (cache[key]) return cache[key];
    const c = cur.toLowerCase();
    const [y, m, d] = date.split('-').map(Number);
    const future = date > todayISO();
    const tag = future ? 'latest' : `${y}.${m}.${d}`;
    const sources = [
      async () => { // daily rates published on jsDelivr (covers every currency in the app)
        const j = await (await fetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${tag}/v1/currencies/${c}.min.json`)).json();
        return { rate: j[c].aud, date: j.date };
      },
      async () => { // same data, mirror
        const j = await (await fetch(`https://${future ? 'latest' : date}.currency-api.pages.dev/v1/currencies/${c}.min.json`)).json();
        return { rate: j[c].aud, date: j.date };
      },
      async () => { // European Central Bank reference rates
        const j = await (await fetch(`https://api.frankfurter.app/${future ? 'latest' : date}?from=${cur}&to=AUD`)).json();
        return { rate: j.rates.AUD, date: j.date };
      },
    ];
    for (const src of sources) {
      try {
        const r = await src();
        if (r && r.date) { const [a, b, c2] = String(r.date).split(/[-.]/).map(Number); r.date = a && b && c2 ? `${a}-${String(b).padStart(2, '0')}-${String(c2).padStart(2, '0')}` : date; }
        if (r && r.rate > 0) {
          if (!future) { cache[key] = r; const keys = Object.keys(cache); if (keys.length > 300) delete cache[keys[0]]; try { localStorage.setItem(FX_CACHE_KEY, JSON.stringify(cache)); } catch { /* full */ } }
          return r;
        }
      } catch { /* try the next source */ }
    }
    return null;
  }
  const audTotal = r => parseFloat(audView(r).amount) || 0;
  const fxLabel = r => isForeign(r) ? `${r.currency} ${(parseFloat(r.fxAmount ?? r.amount) || 0).toFixed(2)}` : '';

  /* ----- Tax invoices -----
     The business can only claim the GST on a purchase over $82.50 (GST-inclusive) with a tax invoice
     showing the supplier's ABN. */
  const TAX_INVOICE_LIMIT = 82.5;
  function validAbn(abn) {
    const d = String(abn || '').replace(/\D/g, '');
    if (d.length !== 11) return false;
    const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
    const sum = d.split('').reduce((s, c, i) => s + (Number(c) - (i === 0 ? 1 : 0)) * w[i], 0);
    return sum % 89 === 0;
  }
  const fmtAbn = abn => String(abn || '').replace(/\D/g, '').replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4');
  function taxInvoiceIssue(r) {
    if (isForeign(r)) return '';
    if ((parseFloat(r.amount) || 0) <= TAX_INVOICE_LIMIT) return '';
    if (!(parseFloat(r.gst) > 0)) return '';
    if (r.taxInvoiceOk || validAbn(r.abn)) return '';
    return 'No tax invoice (supplier ABN) – GST may not be claimable';
  }

  /* ----- Attendees / employees travelling ----- */
  const ENT_CATS = ['Meals & Entertainment'];
  const EMP_MEAL_CATS = ['Employee Meals – Travelling', 'Employee Meals – Not Travelling'];
  const MEAL_CATS = [...ENT_CATS, ...EMP_MEAL_CATS];
  const TRAVEL_CATS = ['Travel – Air', 'Travel – Ground', 'Lodging'];
  const PERSON_TYPES = ['Employee', 'Client', 'Supplier', 'Other'];
  const travelWord = t => t === 'travelling' ? 'travelling' : t === 'not' ? 'not travelling' : '';
  const peopleText = list => (list || []).filter(p => p.name).map(p => `${p.name}${p.org || p.type ? ` (${[p.org, p.type && p.type.toLowerCase(), p.type === 'Employee' ? travelWord(p.travel) : ''].filter(Boolean).join(', ')})` : ''}`).join('; ');
  const catsOf = r => (r.splits && r.splits.length ? r.splits.map(s => s.category) : [r.category]);
  const needsPeople = r => catsOf(r).some(c => MEAL_CATS.includes(c) || TRAVEL_CATS.includes(c));
  const isEntertainment = r => catsOf(r).some(c => ENT_CATS.includes(c));
  // Entertainment: travelling or not is set per employee on the attendee lines; with no employees listed,
  // the receipt-level question is used. Returns 'travelling' | 'not' | 'mixed' | '' (not stated).
  function entTravel(r) {
    if (!isEntertainment(r)) return '';
    const emps = (r.attendees || []).filter(p => p.name && p.type === 'Employee');
    if (!emps.length) return r.travelStatus || '';
    if (emps.some(p => !p.travel)) return '';
    return emps.every(p => p.travel === 'travelling') ? 'travelling' : emps.every(p => p.travel === 'not') ? 'not' : 'mixed';
  }
  const travelText = r => ({ travelling: 'Employee travelling', not: 'Employee not travelling', mixed: 'Employees: some travelling' })[entTravel(r)] || '';
  const travelMissing = r => isEntertainment(r) && !entTravel(r);
  const travelCell = r => !isEntertainment(r) ? '' : ({ travelling: 'Travelling', not: 'Not travelling', mixed: 'Some travelling' })[entTravel(r)] || 'Not stated';

  /* ----- Split bills -----
     A receipt can be split into lines (e.g. hotel: room / meals / parking), each with its own expense type,
     business unit, amount and GST. Reports show one line per split (R3a, R3b…), sharing the receipt image. */
  const hasSplits = r => Array.isArray(r.splits) && r.splits.length > 1;
  function linesOf(r) {
    const v = audView(r);
    const base = { ...v, lineKey: r.id, receiptTotal: v.amount, receiptGst: v.gst, attendeesText: peopleText(r.attendees), taxInvIssue: taxInvoiceIssue(r), travelText: travelText(r) };
    if (!hasSplits(r)) return [base];
    const total = parseFloat(r.amount) || 0;
    const k = v.amount === '' ? null : total ? (parseFloat(v.amount) || 0) / total : 1; // receipt currency → AUD
    return r.splits.map((s, i) => ({
      ...base, lineKey: `${r.id}:${s.id}`, splitIndex: i, splitCount: r.splits.length,
      category: s.category, unit: s.unit, purpose: [r.purpose, s.note].filter(Boolean).join(' – '),
      amount: k == null ? '' : ((parseFloat(s.amount) || 0) * k).toFixed(2),
      gst: k == null ? '' : ((parseFloat(s.gst) || 0) * k).toFixed(2),
      fxAmount: isForeign(r) ? s.amount : v.fxAmount,
      attachments: i === 0 ? r.attachments : [],
    }));
  }
  const unitTotals = recs => {
    const t = {};
    for (const r of recs) for (const l of linesOf(r)) if (l.unit) t[l.unit] = (t[l.unit] || 0) + (parseFloat(l.amount) || 0);
    return t;
  };

  /* ----- Duplicates ----- */
  const dupKey = r => isForeign(r) ? `${r.currency}${(parseFloat(r.amount) || 0).toFixed(2)}` : `AUD${(parseFloat(r.amount) || 0).toFixed(2)}`;
  function looksDuplicate(a, b) {
    if (a.id === b.id || !(parseFloat(a.amount) > 0)) return false;
    if ((a.notDuplicateOf || []).includes(b.id) || (b.notDuplicateOf || []).includes(a.id)) return false;
    if (dupKey(a) !== dupKey(b) || !a.date || !b.date) return false;
    if (Math.abs(Date.parse(a.date) - Date.parse(b.date)) > 86400000) return false;
    const va = (a.vendor || '').toLowerCase().trim(), vb = (b.vendor || '').toLowerCase().trim();
    return va === vb || Recon.similarity(a.vendor, b.vendor) >= 0.5 || (!!a.sourceName && a.sourceName === b.sourceName);
  }

  /* ----- Remembering vendors ----- */
  const vendorKey = v => String(v || '').toLowerCase().replace(/pty|ltd|limited|the\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

  /** Report order: by business unit, then date. Gives each receipt a reference R1, R2… (amounts in AUD) */
  function orderForReport(recs) {
    const unitRank = u => { const i = UNITS.indexOf(u); return i < 0 ? 99 : i; };
    const firstUnit = r => hasSplits(r) ? r.splits[0].unit : r.unit;
    const sorted = recs.slice().sort((a, b) => unitRank(firstUnit(a)) - unitRank(firstUnit(b)) || (a.date || '').localeCompare(b.date || '') || a.created - b.created);
    const lines = [];
    sorted.forEach((r, i) => {
      const ref = 'R' + (i + 1);
      const ls = linesOf(r);
      const summary = ls.length > 1 ? ls.map((l, k) => ({ ref: ref + String.fromCharCode(97 + k), category: l.category, unit: l.unit, amount: l.amount })) : null;
      ls.forEach((l, k) => lines.push({ ...l, ref: ls.length > 1 ? ref + String.fromCharCode(97 + k) : ref, splitOfRef: ls.length > 1 ? ref : '', splitSummary: k === 0 ? summary : null }));
    });
    return lines.map((l, i) => ({ ...l, _o: i })).sort((a, b) => unitRank(a.unit) - unitRank(b.unit) || a._o - b._o);
  }

  /* ---------------- Branding ---------------- */
  function applyBrand() {
    const root = document.documentElement.style;
    root.setProperty('--primary', settings.primary);
    root.setProperty('--accent', settings.accent);
    document.querySelector('meta[name=theme-color]').content = settings.primary;
    $('brandLogo').hidden = !settings.logo;
    $('brandWord').hidden = !!settings.logo;
    if (settings.logo) $('brandLogo').src = settings.logo;
  }

  /* ---------------- Claims list (grouped by month) ---------------- */
  let filter = 'open';
  let thumbUrls = [];
  const search = { text: '', unit: '', cat: '', flag: '' }; // flag: 'tofollow' | 'taxinv' | 'dup' | 'people'
  const LOCK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const FLAG_LABELS = { tofollow: 'receipts still to follow', taxinv: 'over $82.50 without a tax invoice', dup: 'possible duplicates', people: 'meals / travel missing attendees or travel status' };
  const searching = () => !!(search.text || search.unit || search.cat || search.flag);

  function matchesSearch(r, flags) {
    if (search.flag === 'tofollow' && r.image) return false;
    if (search.flag === 'taxinv' && !taxInvoiceIssue(r)) return false;
    if (search.flag === 'dup' && !flags.dup.has(r.id)) return false;
    if (search.flag === 'people' && !((needsPeople(r) && !(r.attendees || []).some(p => p.name)) || travelMissing(r))) return false;
    const ls = linesOf(r);
    if (search.unit && !ls.some(l => l.unit === search.unit)) return false;
    if (search.cat && !ls.some(l => l.category === search.cat)) return false;
    if (search.text) {
      const hay = [r.vendor, r.purpose, r.category, r.abn, r.payment === 'personal' ? 'personal reimbursement' : 'company card', r.currency, peopleText(r.attendees), r.date, fmtDay(r.date),
        ...ls.map(l => [l.category, l.unit, l.amount, l.purpose].join(' ')), r.amount, audView(r).amount].join(' ').toLowerCase();
      const words = search.text.toLowerCase().replace(/\$/g, '').split(/\s+/).filter(Boolean);
      if (!words.every(w => hay.includes(w))) return false;
    }
    return true;
  }

  async function renderList() {
    const [all, claims] = await Promise.all([db.all(), db.claims.all()]);
    const claimMap = new Map(claims.map(c => [c.month, c]));
    const statusOf = m => (claimMap.get(m) || { status: 'open' }).status;

    // Possible duplicates across everything on the phone.
    const flags = { dup: new Set() };
    const byKey = new Map();
    for (const r of all) { const k = dupKey(r); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(r); }
    for (const list of byKey.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (looksDuplicate(list[i], list[j])) { flags.dup.add(list[i].id); flags.dup.add(list[j].id); }
    }

    renderReminders(all, statusOf, flags);

    const months = new Map();
    for (const r of all) {
      if (searching() && !matchesSearch(r, flags)) continue;
      const m = claimKeyOf(r); if (!months.has(m)) months.set(m, []); months.get(m).push(r);
    }
    if (!searching()) for (const c of claims) if (!months.has(c.month) && c.status === 'reopened') months.set(c.month, []);

    $('tabsBar').hidden = searching();
    $('searchNote').hidden = !searching();
    if (searching()) {
      const n = [...months.values()].reduce((s, l) => s + l.length, 0);
      $('searchNote').innerHTML = `${plural(n, 'receipt')}${search.flag ? ` – ${FLAG_LABELS[search.flag]}` : ''}, all months <button class="btn small ghost" id="clearSearch">Clear</button>`;
      $('clearSearch').onclick = clearSearch;
    }

    thumbUrls.forEach(URL.revokeObjectURL);
    thumbUrls = [];
    const wrap = $('monthList');
    wrap.innerHTML = '';
    const keys = [...months.keys()].sort((a, b) => monthOfKey(b).localeCompare(monthOfKey(a)) || (isPersonalKey(a) ? 1 : 0) - (isPersonalKey(b) ? 1 : 0));
    let shown = 0;
    for (const m of keys) {
      const claim = claimMap.get(m) || { month: m, status: 'open', submissions: [] };
      const isSubmitted = claim.status === 'submitted';
      if (!searching() && (filter === 'submitted') !== isSubmitted) continue;
      shown++;
      const recs = months.get(m).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.created - a.created);
      const total = recs.reduce((s, r) => s + audTotal(r), 0);
      const ut = unitTotals(recs);
      const byUnit = UNITS.map(u => [u, ut[u] || 0]).filter(([, v]) => v);
      const needAud = recs.filter(r => isForeign(r) && audView(r).amount === '').length;
      const estAud = recs.filter(r => isForeign(r) && audView(r).audEstimated).length;
      const unassigned = recs.filter(r => linesOf(r).some(l => !l.unit)).length;
      const noReceipt = recs.filter(r => !r.image).length;
      const last = claim.submissions[claim.submissions.length - 1];
      let changes = 0;
      if (claim.status === 'reopened') changes = exceptionsFor(claim, orderForReport(recs).map(r => snapshotOf(r, r.ref))).length;

      const status = isSubmitted ? `<span class="status s-sub">${LOCK_ICON} Submitted</span>`
        : claim.status === 'reopened' ? `<span class="status s-re">Reopened</span>` : `<span class="status s-open">Not submitted</span>`;
      const sec = document.createElement('section');
      sec.className = 'month';
      sec.dataset.month = m;
      sec.innerHTML = `
        <div class="month-head">
          <div>
            <h2>${monthLabel(monthOfKey(m))}${isPersonalKey(m) ? ' <span class="pay-chip">Personal reimbursement</span>' : months.has(m + PERSONAL) ? ' <span class="pay-chip company">Company card</span>' : ''}</h2>
            <div class="month-meta">${plural(recs.length, 'receipt')}${byUnit.map(([u, v]) => ` · ${u} ${money(v)}`).join('')}${unassigned ? ` · <span class="warn">${unassigned} without business unit</span>` : ''}${noReceipt ? ` · <span class="warn">${plural(noReceipt, 'receipt')} to follow</span>` : ''}${needAud ? ` · <span class="warn">${needAud} need${needAud === 1 ? 's' : ''} AUD amount</span>` : ''}${estAud ? ` · <span class="est">${estAud} AUD estimated</span>` : ''}</div>
          </div>
          <div class="month-total">${money(total) || '$0.00'}${status}</div>
        </div>
        ${last && !searching() ? `<div class="month-sub">${claim.status === 'reopened' ? `Reopened · ${plural(changes, 'change')} since ` : ''}submitted ${fmtDay(last.at.slice(0, 10))} to ${escapeHtml(last.to)}${claim.submissions.length > 1 ? ` (resubmission ${claim.submissions.length - 1})` : ''}</div>` : ''}
        <ul class="receipt-list"></ul>
        ${searching() ? '' : `<div class="month-actions">
          ${isSubmitted
            ? `<button class="btn ghost" data-act="reopen">Reopen claim</button><button class="btn ghost" data-act="resend">Send copy</button>`
            : `<button class="btn primary" data-act="submit"${recs.length ? '' : ' disabled'}>${claim.status === 'reopened' ? 'Resubmit claim' : 'Submit claim'}</button>`}
        </div>`}`;
      const ul = sec.querySelector('ul');
      for (const r of recs) {
        const url = r.thumb ? URL.createObjectURL(r.thumb) : '';
        if (url) thumbUrls.push(url);
        const li = document.createElement('li');
        li.className = 'receipt' + (isSubmitted ? ' locked' : '');
        li.dataset.id = r.id;
        const n = (r.attachments || []).length;
        const ls = linesOf(r);
        const units = [...new Set(ls.map(l => l.unit).filter(Boolean))];
        const people = (r.attendees || []).filter(p => p.name).length;
        const tags = [
          flags.dup.has(r.id) ? '<span class="tag bad">Possible duplicate</span>' : '',
          taxInvoiceIssue(r) ? '<span class="tag warn-tag">No tax invoice</span>' : '',
          needsPeople(r) && !people ? '<span class="tag warn-tag">No attendees</span>' : '',
          r.recurringFrom || r.recurring ? '<span class="tag">Monthly</span>' : '',
          travelMissing(r) ? '<span class="tag warn-tag">Travelling?</span>' : '',
        ].join('');
        li.innerHTML = `
          ${url ? `<img class="thumb" src="${url}" alt="">` : `<div class="thumb thumb-missing"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M8 7h8M8 11h8M8 15h5"/></svg><span>To follow</span></div>`}
          <div class="info">
            <div class="desc">${escapeHtml(r.vendor || r.description || '(no vendor)')}</div>
            <div class="purpose">${escapeHtml(r.purpose || '')}</div>
            <div class="meta">${escapeHtml(fmtDay(r.date))}${units.length ? units.map(u => ` · <span class="unit-chip">${escapeHtml(u)}</span>`).join('') : ' · <span class="warn">No unit</span>'} · ${escapeHtml(hasSplits(r) ? 'Split: ' + ls.map(l => l.category).join(', ') : (r.category || ''))}${n ? ` · 📎${n}` : ''}${people ? ` · 👥${people}` : ''}</div>
            ${tags ? `<div class="tags">${tags}</div>` : ''}
          </div>
          <div class="amt">${isForeign(r)
            ? `${audView(r).amount === '' ? '<span class="warn">AUD?</span>' : audView(r).audEstimated ? `<span class="est" title="Estimate from the day's exchange rate">~${money(audView(r).amount)}</span>` : money(audView(r).amount)}<div class="gst-line">${escapeHtml(fxLabel(r))}${audView(r).audEstimated ? ' · est.' : ''}</div>`
            : `${money(r.amount)}${r.gst !== undefined && r.gst !== '' ? `<div class="gst-line">GST ${money(r.gst)}</div>` : ''}`}${isSubmitted ? `<div class="lock">${LOCK_ICON}</div>` : ''}</div>`;
        ul.appendChild(li);
      }
      wrap.appendChild(sec);
    }
    $('emptyState').hidden = shown > 0;
    $('emptyState').querySelector('p').textContent = searching() ? 'No receipts match.' : filter === 'submitted' ? 'No submitted claims yet.' : 'Nothing waiting to be submitted.';
  }

  /* ----- Reminders at the top of the list ----- */
  let remindersHidden = false;
  function renderReminders(all, statusOf, flags) {
    const box = $('reminders');
    if (remindersHidden || searching()) { box.innerHTML = ''; return; }
    const cur = todayISO().slice(0, 7);
    const open = all.filter(r => statusOf(claimKeyOf(r)) !== 'submitted');
    const items = [];
    const overdue = [...new Set(open.map(claimKeyOf))].filter(m => monthOfKey(m) < cur).sort();
    for (const m of overdue) items.push(`<button class="rem" data-rem="submit" data-month="${m}"><b>⏰ ${monthLabel(m)}</b> hasn’t been submitted yet – submit it</button>`);
    const toFollow = open.filter(r => !r.image).length;
    if (toFollow) items.push(`<button class="rem" data-rem="tofollow">📎 ${plural(toFollow, 'receipt')} still to follow</button>`);
    const taxinv = open.filter(r => taxInvoiceIssue(r)).length;
    if (taxinv) items.push(`<button class="rem" data-rem="taxinv">⚠ ${taxinv} over $82.50 without a tax invoice</button>`);
    const people = open.filter(r => (needsPeople(r) && !(r.attendees || []).some(p => p.name)) || travelMissing(r)).length;
    if (people) items.push(`<button class="rem" data-rem="people">👥 ${people} meal / travel claim${people === 1 ? '' : 's'} missing attendees or travel status</button>`);
    const dups = open.filter(r => flags.dup.has(r.id)).length;
    if (dups) items.push(`<button class="rem" data-rem="dup">⚠ ${dups} possible duplicate${dups === 1 ? '' : 's'}</button>`);
    box.innerHTML = items.length ? `<div class="rem-box">${items.join('')}<button class="rem-hide" id="remHide" aria-label="Hide reminders">Hide</button></div>` : '';
  }
  $('reminders').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'remHide') { remindersHidden = true; $('reminders').innerHTML = ''; return; }
    if (b.dataset.rem === 'submit') return openSubmit(b.dataset.month, { copy: false });
    search.flag = b.dataset.rem;
    renderList();
  });

  /* ----- Search & filters ----- */
  let searchTimer;
  $('searchInput').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { search.text = e.target.value.trim(); renderList(); }, 200); });
  $('filterUnit').addEventListener('change', e => { search.unit = e.target.value; renderList(); });
  $('filterCat').addEventListener('change', e => { search.cat = e.target.value; renderList(); });
  function clearSearch() {
    Object.assign(search, { text: '', unit: '', cat: '', flag: '' });
    $('searchInput').value = ''; $('filterUnit').value = ''; $('filterCat').value = '';
    renderList();
  }

  $('monthList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    const sec = e.target.closest('.month');
    if (btn && sec) {
      const m = sec.dataset.month;
      if (btn.dataset.act === 'submit') openSubmit(m, { copy: false });
      if (btn.dataset.act === 'resend') openSubmit(m, { copy: true });
      if (btn.dataset.act === 'reopen') reopenClaim(m);
      return;
    }
    const li = e.target.closest('.receipt');
    if (li) openEdit(li.dataset.id);
  });

  document.querySelectorAll('#tabsBar .tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('#tabsBar .tab').forEach(t => t.classList.toggle('active', t === tab));
    filter = tab.dataset.filter;
    renderList();
  }));

  async function reopenClaim(month, { ask = true } = {}) {
    if (ask && !confirm(`Reopen the ${monthLabel(month)} claim?\n\nIts receipts become editable again. When you resubmit, an exception report listing every change is included for accounts.`)) return false;
    const claim = await getClaim(month);
    claim.status = 'reopened';
    claim.reopenedAt = new Date().toISOString();
    await db.claims.put(claim);
    toast(`${monthLabel(month)} reopened`);
    renderList();
    return true;
  }

  /* ---------------- Capture + crop ---------------- */
  let work = null;      // working canvas (full photo, possibly rotated)
  let quad = null;      // 4 corners in work-canvas pixels
  let editing = null;   // receipt record being created/edited
  let prefill = null;   // bank details to fill in when adding a missing claim from reconciliation
  let cropFromEdit = false; // cropping started from the receipt screen (re-crop / receipt added later)

  const newRecord = () => {
    const r = { id: uid(), created: Date.now(), date: todayISO(), category: '', unit: settings.lastUnit || '', attachments: [], imageVer: 0, image: null, thumb: null, isNew: true };
    if (prefill) { Object.assign(r, prefill); prefill = null; }
    return r;
  };

  /** Start a claim with just the details – the receipt photo can be added later. */
  async function startWithoutReceipt() {
    editing = newRecord();
    await fillEdit();
    show('editView');
    $('editForm').vendor.focus();
  }
  $('noReceiptBtn').onclick = () => { closeAdd(); startWithoutReceipt(); };

  /* ---------------- PDFs and emails ---------------- */
  const isPdf = f => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
  const openAdd = () => { $('addSheet').hidden = false; };
  const closeAdd = () => { $('addSheet').hidden = true; };
  $('addMenuBtn').onclick = openAdd;
  $('addCancel').onclick = closeAdd;
  $('addSheet').addEventListener('click', e => { if (e.target === $('addSheet')) closeAdd(); });

  /** Receipt image + thumbnail blobs from a canvas. */
  async function imagesFrom(canvas) {
    const s = Math.min(1, 1800 / Math.max(canvas.width, canvas.height));
    const out = document.createElement('canvas');
    out.width = Math.round(canvas.width * s); out.height = Math.round(canvas.height * s);
    out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
    const t = document.createElement('canvas');
    const ts = 240 / Math.max(out.width, out.height);
    t.width = Math.round(out.width * ts); t.height = Math.round(out.height * ts);
    t.getContext('2d').drawImage(out, 0, 0, t.width, t.height);
    const [image, thumb] = await Promise.all([toBlob(out, 'image/jpeg', 0.85), toBlob(t, 'image/jpeg', 0.8)]);
    return { image, thumb, w: out.width, h: out.height };
  }

  /** New claim (or the receipt for an existing one) from a PDF – reads its text; scanned PDFs are OCR'd. */
  async function importPdf(file, { into = null } = {}) {
    closeAdd();
    busy(true);
    try {
      const { text, pages, pageCount } = await DocImport.readPdf(file);
      if (!pages.length) throw new Error('empty PDF');
      const imgs = await imagesFrom(pages[0]);
      const extra = [];
      for (const p of pages.slice(1)) { const x = await imagesFrom(p); extra.push({ id: uid(), blob: x.image, w: x.w, h: x.h }); }
      const wasImage = into && into.image;
      editing = into || newRecord();
      if (!editing.isNew && wasImage) editing.imageVer = (editing.imageVer || 0) + 1;
      Object.assign(editing, imgs, { original: null, quad: null, source: 'PDF', sourceName: file.name });
      editing.attachments = [...extra, ...(editing.attachments || [])];
      const readable = (text.match(/[a-z]{3,}/gi) || []).length > 5 && /\d/.test(text);
      editing.sourceText = readable ? text : '';
      await fillEdit();
      show('editView');
      if (readable) applyParsed(ReceiptOcr.parseReceipt(text), { overwrite: false, from: 'PDF' });
      else readReceipt(pages[0], { overwrite: false }); // scanned PDF – read the page image
      if (pageCount > pages.length) toast(`PDF has ${pageCount} pages – the first ${pages.length} are kept.`, 4000);
      else if (extra.length) toast(`${plural(extra.length, 'more page')} added as supporting documents.`, 3500);
    } catch (err) {
      console.error(err);
      toast(/offline|load the PDF/i.test(err.message) ? err.message : 'Couldn’t read that PDF.', 4500);
    } finally { busy(false); }
  }
  $('pdfInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importPdf(f); });

  /** New claim from email text: reads the details and keeps a receipt-style image of the text. */
  async function importText(raw, { title = 'Email receipt', name = '' } = {}) {
    const text = DocImport.cleanEmailText(raw);
    if (!/\d/.test(text) || text.length < 15) return toast('That doesn’t look like a receipt – nothing with an amount in it.', 4000);
    busy(true);
    try {
      const imgs = await imagesFrom(DocImport.textToImage(text, { title: name ? `${title} – ${name}` : title }));
      editing = newRecord();
      Object.assign(editing, imgs, { original: null, quad: null, source: 'email', sourceText: text });
      await fillEdit();
      show('editView');
      applyParsed(ReceiptOcr.parseReceipt(text), { overwrite: false, from: 'email' });
    } finally { busy(false); }
  }
  $('pasteOpt').onclick = () => { closeAdd(); $('pasteText').value = ''; $('pasteSheet').hidden = false; setTimeout(() => $('pasteText').focus(), 50); };
  $('pasteCancel').onclick = () => { $('pasteSheet').hidden = true; };
  $('pasteFromClipboard').onclick = async () => {
    try { $('pasteText').value = await navigator.clipboard.readText(); }
    catch { toast('Couldn’t read the clipboard – press and hold in the box and choose Paste.', 4000); }
  };
  $('pasteGo').onclick = () => {
    const t = $('pasteText').value;
    if (!t.trim()) return toast('Paste the email text first.');
    $('pasteSheet').hidden = true;
    importText(t);
  };
  $('emailFileInput').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    closeAdd();
    importText(await f.text(), { title: 'Email receipt', name: f.name });
  });

  /** Things shared to the app from other apps (Android share menu) arrive via the service worker. */
  async function handleShared() {
    if (!/[?&]shared=1/.test(location.search)) return;
    history.replaceState(null, '', location.pathname);
    try {
      const cache = await caches.open('share-inbox');
      const metaRes = await cache.match('share-meta');
      if (!metaRes) return;
      const meta = await metaRes.json();
      const files = [];
      for (let i = 0; i < meta.files.length; i++) {
        const r = await cache.match(`share-file-${i}`);
        if (r) files.push(new File([await r.blob()], meta.files[i].name, { type: meta.files[i].type }));
      }
      await Promise.all([cache.delete('share-meta'), ...meta.files.map((_, i) => cache.delete(`share-file-${i}`))]);
      const pdf = files.find(isPdf), img = files.find(f => /^image\//.test(f.type)), txt = files.find(f => /^text\/|message\/rfc822|\.eml$/i.test(f.type + ' ' + f.name));
      if (pdf) return importPdf(pdf);
      if (img) return onPhoto(img);
      if (txt) return importText(await txt.text(), { name: txt.name });
      const text = [meta.title, meta.text, meta.url].filter(Boolean).join('\n');
      if (text.trim()) return importText(text);
      toast('Nothing usable was shared.');
    } catch (err) { console.error(err); toast('Couldn’t open what was shared.'); }
  }

  /** Add the receipt photo to a claim that was started without one. */
  async function attachReceipt(file) {
    if (!file || !editing) return;
    captureForm(); // keep what's been typed
    if (isPdf(file)) return importPdf(file, { into: editing });
    cropFromEdit = true;
    busy(true);
    try { startCrop(await fileToCanvas(file), null); }
    catch (err) { console.error(err); toast('Could not open that photo.'); }
    finally { busy(false); }
  }
  $('receiptCam').addEventListener('change', e => { attachReceipt(e.target.files[0]); e.target.value = ''; });
  $('receiptLib').addEventListener('change', e => { attachReceipt(e.target.files[0]); e.target.value = ''; });

  async function onPhoto(file) {
    if (!file) return;
    busy(true);
    try {
      const canvas = await fileToCanvas(file);
      editing = newRecord();
      cropFromEdit = false;
      startCrop(canvas, null);
    } catch (err) {
      console.error(err);
      toast('Could not open that photo.');
    } finally {
      busy(false);
    }
  }
  $('cameraInput').addEventListener('change', e => { onPhoto(e.target.files[0]); e.target.value = ''; });
  $('libraryInput').addEventListener('change', e => { onPhoto(e.target.files[0]); e.target.value = ''; });

  async function fileToCanvas(blob) {
    let src;
    try { src = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch {
      src = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = URL.createObjectURL(blob);
      });
    }
    const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
    const s = Math.min(1, MAX_WORK_SIDE / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    return c;
  }

  function startCrop(canvas, existingQuad) {
    work = canvas;
    quad = existingQuad || ReceiptCrop.detectReceipt(work);
    $('enhanceBtn').setAttribute('aria-pressed', String(!!settings.enhance));
    show('cropView');
    drawCrop();
  }

  function layoutCrop() {
    const stage = $('cropStage');
    const maxW = Math.min(window.innerWidth - 32, 900);
    const maxH = window.innerHeight - 260;
    const s = Math.min(maxW / work.width, maxH / work.height);
    stage.style.width = Math.round(work.width * s) + 'px';
    stage.style.height = Math.round(work.height * s) + 'px';
    return s;
  }

  function drawCrop() {
    const c = $('cropCanvas');
    c.width = work.width; c.height = work.height;
    c.getContext('2d').drawImage(work, 0, 0);
    drawOverlay();
  }

  function drawOverlay() {
    const s = layoutCrop();
    const svg = $('cropOverlay');
    const W = work.width, H = work.height;
    const r = 11 / s, hit = 28 / s;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const pts = quad.map(p => `${p.x},${p.y}`).join(' ');
    svg.innerHTML = `
      <path class="shade" d="M0 0H${W}V${H}H0Z M${quad.map(p => `${p.x} ${p.y}`).join(' L')} Z"/>
      <polygon class="edge" points="${pts}" style="stroke-width:${2 / s}"/>
      ${quad.map((p, i) => `
        <circle class="hit" data-i="${i}" cx="${p.x}" cy="${p.y}" r="${hit}"/>
        <circle class="handle" data-i="${i}" cx="${p.x}" cy="${p.y}" r="${r}" style="stroke-width:${3 / s}"/>`).join('')}`;
  }

  (function setupDrag() {
    const svg = $('cropOverlay');
    let dragging = -1, offset = null;
    const toImg = e => {
      const rect = svg.getBoundingClientRect();
      return { x: (e.clientX - rect.left) / rect.width * work.width, y: (e.clientY - rect.top) / rect.height * work.height };
    };
    svg.addEventListener('pointerdown', e => {
      let i = e.target.dataset ? Number(e.target.dataset.i) : NaN;
      const p = toImg(e);
      if (isNaN(i)) {
        // Grab nearest corner if touch is reasonably close.
        let best = -1, bd = Infinity;
        quad.forEach((q, k) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = k; } });
        const rect = svg.getBoundingClientRect();
        if (bd * rect.width / work.width > 60) return;
        i = best;
      }
      dragging = i;
      offset = { x: quad[i].x - p.x, y: quad[i].y - p.y };
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    svg.addEventListener('pointermove', e => {
      if (dragging < 0) return;
      const p = toImg(e);
      quad[dragging] = {
        x: Math.max(0, Math.min(work.width, p.x + offset.x)),
        y: Math.max(0, Math.min(work.height, p.y + offset.y)),
      };
      drawOverlay();
    });
    const end = () => { dragging = -1; };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  })();

  window.addEventListener('resize', () => { if (!$('cropView').hidden) drawOverlay(); });

  $('autoBtn').onclick = () => { quad = ReceiptCrop.detectReceipt(work); drawOverlay(); };
  $('fullBtn').onclick = () => { quad = ReceiptCrop.insetQuad(work.width, work.height, 0); drawOverlay(); };
  $('rotateBtn').onclick = () => {
    const c = document.createElement('canvas');
    c.width = work.height; c.height = work.width;
    const ctx = c.getContext('2d');
    ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2);
    ctx.drawImage(work, 0, 0);
    const H = work.height;
    // Rotate points 90° clockwise, then re-order so index 0 stays top-left.
    const rq = quad.map(p => ({ x: H - p.y, y: p.x }));
    quad = [rq[3], rq[0], rq[1], rq[2]];
    work = c;
    drawCrop();
  };
  $('enhanceBtn').onclick = () => {
    settings.enhance = !settings.enhance;
    saveSettings();
    $('enhanceBtn').setAttribute('aria-pressed', String(settings.enhance));
  };
  $('cropCancel').onclick = () => {
    if (editing && cropFromEdit) show('editView'); // re-crop / add-later cancelled
    else { editing = null; show('listView'); }
  };

  $('cropDone').onclick = async () => {
    busy(true);
    await new Promise(r => setTimeout(r, 30)); // let spinner paint
    try {
      const out = ReceiptCrop.warp(work, quad, { maxSide: 1800, enhance: settings.enhance });
      const t = document.createElement('canvas');
      const ts = 240 / Math.max(out.width, out.height);
      t.width = Math.round(out.width * ts); t.height = Math.round(out.height * ts);
      t.getContext('2d').drawImage(out, 0, 0, t.width, t.height);
      const [image, thumb, original] = await Promise.all([toBlob(out, 'image/jpeg', 0.85), toBlob(t, 'image/jpeg', 0.8), toBlob(work, 'image/jpeg', 0.85)]);
      if (!editing.isNew && editing.image) editing.imageVer = (editing.imageVer || 0) + 1;
      Object.assign(editing, { image, thumb, original, quad: quad.map(p => ({ ...p })), w: out.width, h: out.height, source: 'photo', sourceText: '' });
      await fillEdit();
      show('editView');
      // Read from an un-enhanced copy: black-and-white enhancing wipes out faded thermal print.
      readReceipt(ReceiptCrop.warp(work, quad, { maxSide: 2400, enhance: false }), { overwrite: false });
    } catch (err) {
      console.error(err);
      toast('Crop failed – try again.');
    } finally {
      busy(false);
    }
  };

  /* ---------------- Edit ---------------- */
  let previewUrl;
  let editLocked = false;

  async function fillEdit() {
    const f = $('editForm');
    f.vendor.value = editing.vendor || '';
    f.purpose.value = editing.purpose || '';
    f.amount.value = editing.amount || '';
    f.gst.value = editing.gst || '';
    gstMode = editing.gstMode || 'auto';
    f.currency.value = editing.currency || 'AUD';
    f.audAmount.value = editing.audAmount || '';
    audSource = editing.audSource || '';
    estimate = editing.audEstimate ? { cur: editing.currency, date: editing.date, rate: parseFloat(editing.audEstimateRate), rateDate: editing.audEstimateDate } : null;
    $('fxCands').innerHTML = '';
    updateMoney();
    f.querySelectorAll('.filled').forEach(el => el.classList.remove('filled'));
    $('ocrStatus').hidden = true;
    $('ocrAgainBtn').hidden = false;
    f.date.value = editing.date || todayISO();
    setCategory(editing.category || '');
    categoryTouched = !!editing.category;
    setUnit(editing.unit || '');
    document.querySelectorAll('#payPicker input').forEach(i => { i.checked = i.value === (editing.payment || 'company'); });
    $('payNote').hidden = editing.payment !== 'personal';
    document.querySelectorAll('#travelPicker input').forEach(i => { i.checked = i.value === editing.travelStatus; });
    f.abn.value = editing.abn ? fmtAbn(editing.abn) || editing.abn : '';
    f.taxInvoiceOk.checked = !!editing.taxInvoiceOk;
    splits = hasSplits(editing) ? editing.splits.map(x => ({ ...x })) : [];
    people = (editing.attendees || []).map(x => ({ ...x }));
    f.recurring.checked = !!editing.recurring;
    $('recurringWrap').hidden = !!editing.recurringFrom;
    $('recurringNote').hidden = !editing.recurringFrom;
    $('recurringNote').textContent = editing.recurringFrom ? 'Added automatically from a monthly repeat – stop it in Settings → Monthly repeats.' : '';
    renderSplits();
    renderPeople();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = editing.image ? URL.createObjectURL(editing.image) : '';
    $('editPreview').hidden = !editing.image;
    if (previewUrl) $('editPreview').src = previewUrl;
    $('noReceipt').hidden = !!editing.image;
    $('deleteBtn').hidden = !!editing.isNew;
    $('recropBtn').hidden = !editing.original;
    renderAttachments();
    updateMoney(); // again now the date is set, so the exchange-rate estimate uses the right day
    await applyLock();
  }

  /** Receipts in a submitted claim are read-only until the claim is reopened. */
  async function applyLock() {
    const month = claimKeyOf(editing);
    editLocked = !editing.isNew && await isLocked(month);
    const f = $('editForm');
    f.querySelectorAll('input, textarea, select').forEach(el => { el.disabled = editLocked; });
    $('addReceiptBtns').hidden = editLocked;
    ['splitAdd', 'splitRemove', 'peopleAdd', 'peopleAddMe'].forEach(id => { $(id).hidden = editLocked; });
    $('splitBtn').hidden = editLocked || splits.length > 0;
    document.querySelectorAll('#splitRows [data-del], #peopleRows [data-pdel]').forEach(b => { b.hidden = editLocked; });
    ['recropBtn', 'deleteBtn', 'saveBtn', 'gstAutoBtn', 'gstNoneBtn', 'attachAdd'].forEach(id => { $(id).hidden = editLocked || (id === 'deleteBtn' && editing.isNew) || (id === 'recropBtn' && !editing.original); });
    $('ocrAgainBtn').hidden = editLocked || !editing.image;
    $('lockBanner').hidden = !editLocked;
    $('lockMsg').textContent = `Locked – part of the submitted ${monthLabel(month)} claim.`;
    $('editCancel').textContent = editLocked ? 'Back' : 'Cancel';
  }
  $('lockReopenBtn').onclick = async () => {
    if (await reopenClaim(claimKeyOf(editing))) await applyLock();
  };

  async function openEdit(id) {
    const rec = await db.get(id);
    if (!rec) return;
    editing = { ...rec, isNew: false, attachments: (rec.attachments || []).slice() };
    await fillEdit();
    show('editView');
  }

  function setUnit(u) {
    document.querySelectorAll('#unitPicker input').forEach(i => { i.checked = i.value === u; });
  }
  const readUnit = () => { const c = document.querySelector('#unitPicker input:checked'); return c ? c.value : ''; };

  /* ----- Total / GST / Ex GST -----
     GST defaults to 1/11 of the total (Australian 10% GST). Typing a GST amount overrides it and
     Ex GST = Total − GST, e.g. Total 11.00 → GST 1.00, Ex 10.00; change GST to 0.50 → Ex 10.50. */
  let gstMode = 'auto'; // 'auto' (1/11 of total) | 'receipt' (read off receipt) | 'manual' (typed)
  const num = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; };
  const fix2 = n => (n == null ? '' : ReceiptOcr.round2(n).toFixed(2));

  let audSource = ''; // 'bank' | 'manual' – where a foreign receipt's AUD amount came from
  function updateMoney() {
    const f = $('editForm');
    const cur = f.currency.value || 'AUD';
    const foreign = cur !== 'AUD';
    const total = num(f.amount.value);
    // Overseas purchases carry no Australian GST, so "auto" means none.
    if (gstMode === 'auto') f.gst.value = total == null ? '' : foreign ? '0.00' : fix2(ReceiptOcr.gstFromTotal(total));
    const gst = num(f.gst.value) || 0;
    f.exgst.value = total == null ? '' : fix2(total - gst);
    $('totalLabel').textContent = foreign ? `Total (${cur})` : 'Total (inc GST)';
    $('gstName').textContent = foreign ? 'Tax' : 'GST';
    $('exLabel').textContent = foreign ? 'Ex tax' : 'Ex GST';
    $('gstAutoBtn').textContent = foreign ? 'No AU GST' : 'GST = 1/11 of total';
    $('gstNoneBtn').hidden = foreign;
    const label = $('gstMode');
    label.textContent = { auto: foreign ? '· none (overseas)' : '· auto 1/11', receipt: '· from receipt', manual: '· edited' }[gstMode];
    label.classList.toggle('manual', gstMode === 'manual');
    $('gstWarn').hidden = !(total != null && gst > total);
    // Second box: the AUD amount for a foreign receipt.
    $('fxCard').hidden = !foreign;
    if (foreign) {
      const aud = num(f.audAmount.value);
      const est = aud == null ? currentEstimate() : null;
      // The estimate sits in the box greyed and in italics until a real amount replaces it.
      f.audAmount.placeholder = est ? fix2(est.value) : '0.00';
      f.audAmount.classList.toggle('has-estimate', !!est);
      $('fxSource').textContent = aud != null ? (audSource === 'bank' ? '· from bank statement' : '· entered') : est ? '· estimate' : '';
      $('fxSource').classList.toggle('est', !!est);
      $('fxRate').innerHTML = aud != null && total
        ? `Rate: 1 ${cur} = ${(aud / total).toFixed(4)} AUD`
        : est
          ? `<i>Estimate at ${est.rate.toFixed(4)} – the daily rate for ${escapeHtml(fmtDay(est.rateDate))}. Replace it with the bank statement amount when it arrives.</i>`
          : `Use the AUD amount on your bank or card statement${settings.statement ? '' : ' (load one in Reconcile to look it up)'}.`;
      scheduleEstimate();
    }
    updateTaxInv();
    if (splits.length) { balanceSplits(); renderSplits(); } else updatePeopleHint();
  }

  /* ----- AUD estimate from the day's exchange rate ----- */
  let estimate = null;   // { cur, date, rate, rateDate } for the receipt being edited
  let estTimer = null, estWanted = '';
  function currentEstimate() {
    const f = $('editForm');
    const total = num(f.amount.value);
    if (!estimate || total == null || estimate.cur !== f.currency.value || estimate.date !== f.date.value) return null;
    return { ...estimate, value: total * estimate.rate };
  }
  function scheduleEstimate() {
    const f = $('editForm');
    const cur = f.currency.value, date = f.date.value;
    if (!cur || cur === 'AUD' || !date) return;
    if (estimate && estimate.cur === cur && estimate.date === date) return;
    const want = `${cur}|${date}`;
    if (estWanted === want) return;
    estWanted = want;
    clearTimeout(estTimer);
    estTimer = setTimeout(async () => {
      const r = await fxRate(cur, date);
      estWanted = '';
      const g = $('editForm');
      if (!r || g.currency.value !== cur || g.date.value !== date) return;
      estimate = { cur, date, rate: r.rate, rateDate: r.date || date };
      updateMoney();
    }, 300);
  }
  $('editForm').date.addEventListener('change', updateMoney);
  $('editForm').currency.addEventListener('change', () => { $('fxCands').innerHTML = ''; updateMoney(); });
  document.querySelectorAll('#payPicker input').forEach(i => i.addEventListener('change', () => { $('payNote').hidden = i.value !== 'personal' || !i.checked; }));
  $('editForm').audAmount.addEventListener('input', () => { audSource = 'manual'; updateMoney(); });
  $('editForm').audAmount.addEventListener('blur', e => { const n = num(e.target.value); if (n != null) e.target.value = fix2(n); });

  /** Suggest statement lines for a foreign receipt: same few days, vendor name or foreign amount in the description. */
  $('fxFindBtn').onclick = () => {
    const box = $('fxCands');
    const st = settings.statement;
    if (!st || !st.transactions.length) {
      box.innerHTML = '<p class="small muted">No bank statement loaded yet. Tap the bank icon on the main screen to load one, then come back – or type the AUD amount in.</p>';
      return;
    }
    const f = $('editForm');
    const date = f.date.value, fxAmt = num(f.amount.value), vendor = f.vendor.value;
    const day = d => Date.parse(d) / 86400000;
    const cands = st.transactions
      .map(t => {
        const dd = date ? Math.abs(day(t.date) - day(date)) : 0;
        const hasAmt = fxAmt != null && t.desc.replace(/,/g, '').includes(fxAmt.toFixed(2));
        const sim = Recon.similarity(vendor, t.desc);
        return { t, dd, score: dd + (hasAmt ? -20 : 0) - sim * 6 + (/(intl|international|foreign|o\/s|overseas|fx)/i.test(t.desc) ? -1 : 0) };
      })
      .filter(c => c.dd <= 7)
      .sort((a, b) => a.score - b.score)
      .slice(0, 6);
    box.innerHTML = cands.length
      ? '<p class="small muted">Tap the matching charge:</p>' + cands.map(c => `<button type="button" class="fx-cand" data-amt="${c.t.amount.toFixed(2)}"><span>${escapeHtml(fmtDay(c.t.date))}</span><span class="rc-desc">${escapeHtml(c.t.desc)}</span><strong>${money(c.t.amount)}</strong></button>`).join('')
      : '<p class="small muted">Nothing on the loaded statement within a week of this date – type the AUD amount in.</p>';
  };
  $('fxCands').addEventListener('click', e => {
    const b = e.target.closest('.fx-cand');
    if (!b) return;
    $('editForm').audAmount.value = b.dataset.amt;
    audSource = 'bank';
    $('fxCands').innerHTML = '';
    updateMoney();
  });
  $('editForm').amount.addEventListener('input', updateMoney);
  $('editForm').gst.addEventListener('input', () => { gstMode = 'manual'; updateMoney(); });
  $('editForm').amount.addEventListener('blur', e => { const n = num(e.target.value); if (n != null) e.target.value = fix2(n); });
  $('editForm').gst.addEventListener('blur', e => { const n = num(e.target.value); if (n != null) e.target.value = fix2(n); updateMoney(); });
  $('gstAutoBtn').onclick = () => { gstMode = 'auto'; updateMoney(); };
  $('gstNoneBtn').onclick = () => { gstMode = 'manual'; $('editForm').gst.value = '0.00'; updateMoney(); };

  /* ----- Reading the receipt ----- */
  let ocrRun = 0;
  async function readReceipt(image, { overwrite }) {
    const run = ++ocrRun, id = editing.id;
    const status = $('ocrStatus');
    status.hidden = false; status.className = 'ocr-status';
    $('ocrMsg').textContent = 'Reading receipt…';
    $('ocrAgainBtn').hidden = true;
    try {
      const r = await ReceiptOcr.readReceipt(image);
      if (run !== ocrRun || !editing || editing.id !== id || $('editView').hidden) return;
      editing.ocrText = r.text;
      applyParsed(r, { overwrite });
    } catch (err) {
      console.error(err);
      if (run !== ocrRun) return;
      status.classList.add('error');
      $('ocrMsg').textContent = 'Couldn’t read the receipt (no internet on first use?)';
    } finally {
      if (run === ocrRun) $('ocrAgainBtn').hidden = false;
    }
  }

  /** Put what was read off a receipt / PDF / email into the form. */
  function applyParsed(r, { overwrite, from = 'receipt' }) {
    const status = $('ocrStatus');
    status.hidden = false; status.className = 'ocr-status';
    {
      const f = $('editForm');
      if (r.abn && (overwrite || !f.abn.value.trim())) { f.abn.value = r.abn; f.abn.classList.add('filled'); }
      const filled = [];
      const put = (field, value) => {
        if (value == null || value === '') return;
        if (!overwrite && f[field].value.trim()) return;
        f[field].value = value;
        f[field].classList.add('filled');
        filled.push(field);
      };
      if (r.currency && (overwrite || editing.isNew) && f.currency.value !== r.currency) {
        f.currency.value = r.currency;
        f.currency.classList.add('filled');
        if (r.currency !== 'AUD') { gstMode = 'auto'; f.gst.value = ''; }
      }
      put('vendor', r.vendor);
      const totalWasEmpty = !f.amount.value.trim();
      put('amount', r.total != null ? fix2(r.total) : '');
      if (overwrite || (totalWasEmpty && gstMode !== 'manual')) {
        // Overseas tax (US sales tax, VAT…) isn't claimable GST – foreign receipts default to no GST.
        const foreign = f.currency.value && f.currency.value !== 'AUD';
        gstMode = r.gstFound && !foreign ? 'receipt' : 'auto';
        if (r.gstFound && !foreign) { f.gst.value = fix2(r.gst); f.gst.classList.add('filled'); }
      }
      if (r.date && (overwrite || editing.isNew)) { f.date.value = r.date; f.date.classList.add('filled'); }
      if (r.category && (overwrite || !categoryTouched)) { setCategory(r.category); f.category.classList.add('filled'); }
      applyVendorMemory();
      renderPeople();
      updateMoney();
      status.classList.add('done');
      $('ocrMsg').textContent = filled.length || r.date
        ? `Filled in from the ${from} – please check.`
        : `Couldn’t read the details from the ${from} – please type them in.`;
      $('ocrAgainBtn').hidden = false;
    }
  }
  $('ocrAgainBtn').onclick = async () => {
    if (editing && editing.sourceText) return applyParsed(ReceiptOcr.parseReceipt(editing.sourceText), { overwrite: true, from: editing.source || 'document' });
    if (!editing || !editing.image) return;
    try {
      const canvas = editing.original && editing.quad
        ? ReceiptCrop.warp(await fileToCanvas(editing.original), editing.quad, { maxSide: 2400, enhance: false })
        : await fileToCanvas(editing.image);
      readReceipt(canvas, { overwrite: true });
    } catch (err) { console.error(err); toast('Couldn’t open the photo to read it.'); }
  };

  /* ----- Expense type: preset list, plus free text when nothing fits ----- */
  const CATEGORIES = [
    'Meals & Entertainment', 'Employee Meals – Travelling', 'Employee Meals – Not Travelling', 'Staff Amenities', 'Parking', 'Fuel', 'Fuel / Mileage',
    'Travel – Air', 'Travel – Ground', 'Lodging', 'Office Supplies', 'Software / Subscriptions', 'Other',
  ];
  const CUSTOM = '__custom';
  let categoryTouched = false;

  function setCategory(value) {
    const sel = $('categorySelect');
    if (sel.options.length !== CATEGORIES.length + 2) {
      sel.innerHTML = '';
      sel.add(new Option('Choose expense type…', ''));
      CATEGORIES.forEach(c => sel.add(new Option(c, c)));
      sel.add(new Option('✎ Not listed – type it in…', CUSTOM));
    }
    const isPreset = !value || CATEGORIES.includes(value);
    sel.value = isPreset ? (value || '') : CUSTOM;
    $('customCategoryWrap').hidden = isPreset;
    $('customCategory').value = isPreset ? '' : value;
  }

  function readCategory() {
    const sel = $('categorySelect');
    if (sel.value !== CUSTOM) return sel.value;
    const typed = $('customCategory').value.trim().replace(/\s+/g, ' ');
    return CATEGORIES.find(c => c.toLowerCase() === typed.toLowerCase()) || typed;
  }

  $('categorySelect').addEventListener('change', e => {
    categoryTouched = true;
    e.target.classList.remove('filled');
    const custom = e.target.value === CUSTOM;
    $('customCategoryWrap').hidden = !custom;
    if (custom) $('customCategory').focus();
    renderPeople();
  });

  /* ----- Tax invoice box ----- */
  function updateTaxInv() {
    const f = $('editForm');
    const foreign = f.currency.value && f.currency.value !== 'AUD';
    const total = num(f.amount.value) || 0, gst = num(f.gst.value) || 0;
    const abnOk = validAbn(f.abn.value);
    const over = total > TAX_INVOICE_LIMIT;
    $('taxInvBox').hidden = foreign;
    const issue = !foreign && over && gst > 0 && !abnOk && !f.taxInvoiceOk.checked;
    $('taxInvWarn').hidden = !issue;
    $('taxInvOk').hidden = !(abnOk || f.taxInvoiceOk.checked) || foreign;
    $('taxInvOk').textContent = abnOk ? `✓ Supplier ABN ${fmtAbn(f.abn.value)}` : '✓ Marked as a valid tax invoice';
    f.abn.classList.toggle('bad', !!f.abn.value.trim() && !abnOk);
    $('taxInvBox').classList.toggle('needs', issue);
  }
  $('editForm').abn.addEventListener('input', updateTaxInv);
  $('editForm').abn.addEventListener('blur', e => { if (validAbn(e.target.value)) e.target.value = fmtAbn(e.target.value); else if (e.target.value.trim()) toast('That ABN doesn’t check out – 11 digits, as printed on the receipt.'); });
  $('editForm').taxInvoiceOk.addEventListener('change', updateTaxInv);

  /* ----- Split editor ----- */
  let splits = []; // [{ id, category, unit, amount, gst, gstAuto, note, auto }]
  const splitGst = amt => { const f = $('editForm'); const foreign = f.currency.value !== 'AUD'; return foreign || !(num(f.gst.value) > 0) ? 0 : (num(amt) || 0) / 11; };
  function balanceSplits() {
    const total = num($('editForm').amount.value) || 0;
    if (splits.length && splits[0].auto) {
      const others = splits.slice(1).reduce((t, x) => t + (num(x.amount) || 0), 0);
      splits[0].amount = fix2(Math.max(0, total - others));
    }
    for (const x of splits) if (x.gstAuto) x.gst = fix2(splitGst(x.amount));
  }
  function renderSplits() {
    const on = splits.length > 0;
    $('splitEditor').hidden = !on;
    $('splitBtn').hidden = on || editLocked;
    $('unitField').hidden = on;
    $('categoryField').hidden = on;
    if (on) $('customCategoryWrap').hidden = true;
    const cats = [...new Set([...CATEGORIES, ...splits.map(x => x.category).filter(Boolean)])];
    $('splitRows').innerHTML = splits.map((x, i) => `
      <div class="split-row" data-i="${i}">
        <select data-k="category" aria-label="Expense type"><option value="">Expense type…</option>${cats.map(c => `<option${c === x.category ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>
        <select data-k="unit" aria-label="Business unit"><option value="">Unit…</option>${UNITS.map(u => `<option${u === x.unit ? ' selected' : ''}>${u}</option>`).join('')}</select>
        <label class="mini"><span>Amount</span><input data-k="amount" inputmode="decimal" value="${escapeHtml(x.amount || '')}" placeholder="0.00"></label>
        <label class="mini"><span>${$('editForm').currency.value !== 'AUD' ? 'Tax' : 'GST'}</span><input data-k="gst" inputmode="decimal" value="${escapeHtml(x.gst || '')}" placeholder="0.00"></label>
        <input data-k="note" class="note" value="${escapeHtml(x.note || '')}" placeholder="Note, e.g. 2 nights">
        <button type="button" class="split-del" data-del="${i}" aria-label="Remove line"${editLocked ? ' hidden' : ''}>×</button>
      </div>`).join('');
    if (editLocked) $('splitRows').querySelectorAll('input, select').forEach(el => { el.disabled = true; });
    updateSplitRemain();
    renderPeople();
  }
  function updateSplitRemain() {
    if (!splits.length) return;
    const f = $('editForm');
    const total = num(f.amount.value) || 0, gst = num(f.gst.value) || 0;
    const sum = splits.reduce((t, x) => t + (num(x.amount) || 0), 0);
    const gsum = splits.reduce((t, x) => t + (num(x.gst) || 0), 0);
    const left = Math.round((total - sum) * 100) / 100;
    const gleft = Math.round((gst - gsum) * 100) / 100;
    $('splitRemain').innerHTML = `Allocated ${money(sum)} of ${money(total)}${left ? ` · <b class="warn">${money(Math.abs(left))} ${left > 0 ? 'left to allocate' : 'too much'}</b>` : ' ✓'}${Math.abs(gleft) >= 0.02 ? ` · <span class="warn">GST lines add to ${money(gsum)}, receipt shows ${money(gst)}</span>` : ''}`;
  }
  $('splitBtn').onclick = () => {
    const f = $('editForm');
    if (num(f.amount.value) == null) return toast('Enter the bill total first.');
    const cat = readCategory(), unit = readUnit() || settings.lastUnit || '';
    splits = [
      // first line soaks up whatever the other lines don't take; GST follows 1/11 of each line on a GST receipt
      { id: uid(), category: cat, unit, amount: fix2(num(f.amount.value)), gst: f.gst.value || '0.00', gstAuto: num(f.gst.value) > 0, note: '', auto: true },
      { id: uid(), category: '', unit, amount: '', gst: '', gstAuto: true, note: '' },
    ];
    renderSplits();
  };
  $('splitAdd').onclick = () => { splits.push({ id: uid(), category: '', unit: splits[0] ? splits[0].unit : '', amount: '', gst: '', gstAuto: true, note: '' }); renderSplits(); };
  $('splitRemove').onclick = () => {
    if (!splits.length) return;
    setCategory(splits[0].category || ''); setUnit(splits[0].unit || '');
    splits = [];
    renderSplits();
  };
  $('splitRows').addEventListener('click', e => {
    const d = e.target.closest('[data-del]');
    if (!d) return;
    splits.splice(Number(d.dataset.del), 1);
    if (splits.length === 1) { $('splitRemove').click(); return; }
    if (splits[0]) splits[0].auto = splits[0].auto ?? false;
    balanceSplits(); renderSplits();
  });
  $('splitRows').addEventListener('input', e => {
    const row = e.target.closest('.split-row'); if (!row) return;
    const i = Number(row.dataset.i), k = e.target.dataset.k, x = splits[i];
    x[k] = e.target.value;
    if (k === 'amount') { if (i === 0) x.auto = false; if (x.gstAuto) x.gst = fix2(splitGst(x.amount)); }
    if (k === 'gst') x.gstAuto = false;
    if (k === 'amount' || k === 'gst') {
      balanceSplits();
      // refresh the other rows' numbers without re-rendering the one being typed in
      $('splitRows').querySelectorAll('.split-row').forEach((r, j) => {
        if (j !== i || k !== 'amount') r.querySelector('[data-k=amount]').value = splits[j].amount || '';
        if (j !== i || k !== 'gst') r.querySelector('[data-k=gst]').value = splits[j].gst || '';
      });
      updateSplitRemain();
    }
  });
  $('splitRows').addEventListener('change', e => {
    const row = e.target.closest('.split-row'); if (!row) return;
    splits[Number(row.dataset.i)][e.target.dataset.k] = e.target.value;
    if (e.target.dataset.k === 'category') renderPeople();
  });

  /* ----- Attendees / employees travelling ----- */
  let people = []; // [{ name, org, type }]
  function peopleMode() {
    const cats = splits.length ? splits.map(x => x.category) : [readCategory()];
    const ent = cats.some(c => ENT_CATS.includes(c)), emp = cats.some(c => EMP_MEAL_CATS.includes(c)), travel = cats.some(c => TRAVEL_CATS.includes(c));
    return ent && (travel || emp) ? 'both' : ent ? 'meal' : emp && travel ? 'travel' : emp ? 'staff' : travel ? 'travel' : '';
  }
  function renderPeople() {
    const mode = peopleMode();
    $('peopleBox').hidden = !mode && !people.length;
    $('peopleLabel').textContent = mode === 'travel' ? 'Employees travelling' : mode === 'staff' ? 'Employees' : mode === 'both' ? 'Attendees / employees travelling' : 'Attendees';
    // Entertainment: was the employee travelling? (decides how accounts treat it)
    const ent = (splits.length ? splits.map(x => x.category) : [readCategory()]).some(c => ENT_CATS.includes(c));
    // With employees on the attendee lines, each one says whether they were travelling instead.
    $('travelField').hidden = !ent || people.some(p => p.type === 'Employee');
    $('peopleNames').innerHTML = (settings.people || []).map(n => `<option value="${escapeHtml(n)}">`).join('');
    $('peopleRows').innerHTML = people.map((p, i) => `
      <div class="person-row" data-i="${i}">
        <input data-k="name" list="peopleNames" value="${escapeHtml(p.name || '')}" placeholder="Name">
        <input data-k="org" value="${escapeHtml(p.org || '')}" placeholder="Company">
        <select data-k="type">${PERSON_TYPES.map(t => `<option${t === p.type ? ' selected' : ''}>${t}</option>`).join('')}</select>
        <button type="button" class="split-del" data-pdel="${i}" aria-label="Remove person"${editLocked ? ' hidden' : ''}>×</button>
        ${ent && p.type === 'Employee' ? `<div class="person-travel" role="radiogroup" aria-label="${escapeHtml(p.name || 'Employee')} travelling?">
          <button type="button" data-travel="not" class="${p.travel === 'not' ? 'on' : ''}">Not travelling</button>
          <button type="button" data-travel="travelling" class="${p.travel === 'travelling' ? 'on' : ''}">Travelling</button>
        </div>` : ''}
      </div>`).join('');
    if (editLocked) $('peopleRows').querySelectorAll('input, select').forEach(el => { el.disabled = true; });
    updatePeopleHint();
  }
  function updatePeopleHint() {
    const named = people.filter(p => p.name.trim());
    const total = num($('editForm').amount.value);
    const mode = peopleMode();
    const clients = named.filter(p => p.type === 'Client').length;
    $('peopleHint').textContent = !named.length
      ? (mode === 'travel' ? 'Add who travelled.' : mode ? 'Add everyone who attended – accounts need this for FBT.' : '')
      : mode === 'travel' ? `${plural(named.length, 'person')} travelling`
      : mode === 'staff' ? `${plural(named.length, 'employee')}${total ? ` · ${money(total / named.length)} per head` : ''}`
      : `${plural(named.length, 'person')}${total ? ` · ${money(total / named.length)} per head` : ''}${clients ? ` · ${plural(clients, 'client')} present` : ' · no clients'}`;
  }
  $('peopleAdd').onclick = () => { people.push({ name: '', org: '', type: peopleMode() === 'meal' ? 'Client' : 'Employee' }); renderPeople(); const rows = $('peopleRows').querySelectorAll('[data-k=name]'); rows[rows.length - 1].focus(); };
  $('peopleAddMe').onclick = () => {
    const me = settings.name || 'Me';
    if (people.some(p => p.name === me)) return;
    people.unshift({ name: me, org: (splits[0] && splits[0].unit) || readUnit() || 'Mentis', type: 'Employee' });
    renderPeople();
  };
  $('peopleRows').addEventListener('input', e => {
    const row = e.target.closest('.person-row'); if (!row) return;
    people[Number(row.dataset.i)][e.target.dataset.k] = e.target.value;
    updatePeopleHint();
  });
  $('peopleRows').addEventListener('change', e => {
    const row = e.target.closest('.person-row'); if (!row) return;
    people[Number(row.dataset.i)][e.target.dataset.k] = e.target.value;
    if (e.target.dataset.k === 'type') renderPeople(); else updatePeopleHint();
  });
  $('peopleRows').addEventListener('click', e => {
    const t = e.target.closest('[data-travel]');
    if (t && !editLocked) {
      const p = people[Number(t.closest('.person-row').dataset.i)];
      p.travel = p.travel === t.dataset.travel ? '' : t.dataset.travel;
      renderPeople();
      return;
    }
    const d = e.target.closest('[data-pdel]'); if (!d) return;
    people.splice(Number(d.dataset.pdel), 1);
    renderPeople();
  });

  /** Fill expense type / unit from what was used last time for this vendor (new receipts only). */
  function applyVendorMemory() {
    if (!editing || !editing.isNew || splits.length) return;
    const mem = (settings.vendorMemory || {})[vendorKey($('editForm').vendor.value)];
    if (!mem) return;
    if (mem.category && !categoryTouched) { setCategory(mem.category); $('editForm').category.classList.add('filled'); }
    if (mem.unit) setUnit(mem.unit);
    renderPeople();
  }
  $('editForm').vendor.addEventListener('change', applyVendorMemory);

  function captureForm() {
    const f = $('editForm');
    Object.assign(editing, {
      vendor: f.vendor.value.trim(),
      purpose: f.purpose.value.trim(),
      amount: num(f.amount.value) != null ? fix2(num(f.amount.value)) : '',
      gst: num(f.gst.value) != null ? fix2(num(f.gst.value)) : '',
      gstMode,
      date: f.date.value || editing.date,
      category: readCategory(),
      unit: readUnit(),
      currency: f.currency.value || 'AUD',
      audAmount: f.currency.value !== 'AUD' && num(f.audAmount.value) != null ? fix2(num(f.audAmount.value)) : '',
      audSource: f.currency.value !== 'AUD' ? audSource : '',
      abn: validAbn(f.abn.value) ? fmtAbn(f.abn.value) : f.abn.value.trim(),
      taxInvoiceOk: f.taxInvoiceOk.checked,
      payment: (document.querySelector('#payPicker input:checked') || {}).value || 'company',
      travelStatus: (document.querySelector('#travelPicker input:checked') || {}).value || '',
      attendees: people.filter(p => p.name.trim()).map(p => ({ name: p.name.trim(), org: (p.org || '').trim(), type: p.type || 'Employee', ...(p.type === 'Employee' && p.travel ? { travel: p.travel } : {}) })),
      recurring: f.recurring.checked && !editing.recurringFrom,
      splits: splits.length > 1 ? splits.map(x => ({ id: x.id, category: x.category, unit: x.unit, amount: num(x.amount) != null ? fix2(num(x.amount)) : '', gst: num(x.gst) != null ? fix2(num(x.gst)) : '0.00', note: (x.note || '').trim() })) : [],
    });
    if (editing.splits.length) { editing.category = editing.splits[0].category; editing.unit = editing.splits[0].unit; }
    const est = currentEstimate();
    Object.assign(editing, est
      ? { audEstimate: fix2(est.value), audEstimateRate: est.rate.toFixed(6), audEstimateDate: est.rateDate }
      : { audEstimate: '', audEstimateRate: '', audEstimateDate: '' });
  }

  $('recropBtn').onclick = async () => {
    captureForm();
    cropFromEdit = true;
    busy(true);
    try { startCrop(await fileToCanvas(editing.original), editing.quad); }
    finally { busy(false); }
  };

  $('editForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (editLocked) return;
    captureForm();
    editing.exgst = editing.amount !== '' ? fix2(num(editing.amount) - (num(editing.gst) || 0)) : '';
    if (!editing.vendor) return toast('Add the vendor.');
    if (!editing.image && editing.amount === '') return toast('Add the total – there’s no receipt to read it from yet.');
    if (editing.splits.length) {
      const bad = editing.splits.findIndex(x => !x.category || !x.unit || x.amount === '');
      if (bad >= 0) return toast(`Split line ${bad + 1} needs an expense type, business unit and amount.`);
      const sum = editing.splits.reduce((t, x) => t + (parseFloat(x.amount) || 0), 0);
      if (Math.abs(sum - (parseFloat(editing.amount) || 0)) > 0.01) return toast(`The split lines add up to ${money(sum)} but the bill is ${money(editing.amount)}.`, 4500);
    }
    if (!editing.unit) return toast('Choose the business unit – Mentis or Macrack.');
    if (validAbn(editing.abn) === false && editing.abn && !confirm(`The ABN ${editing.abn} doesn't pass the ABN check – it may be mistyped. Save anyway?`)) return;
    // Duplicate check against everything else on the phone.
    const dups = (await db.all()).filter(o => looksDuplicate(editing, o));
    if (dups.length) {
      const d = dups[0];
      if (!confirm(`This looks like a duplicate of:\n\n${d.vendor} – ${money(audTotal(d))} on ${fmtDay(d.date)}${claimKeyOf(d) !== claimKeyOf(editing) ? ` (${monthLabel(claimKeyOf(d))} claim)` : ''}\n\nSave it anyway? (Choose Cancel to go back and check.)`)) return;
      editing.notDuplicateOf = [...new Set([...(editing.notDuplicateOf || []), ...dups.map(x => x.id)])];
    }
    // Saving into a claim that has already been submitted reopens that claim.
    const month = claimKeyOf(editing);
    if (await isLocked(month)) {
      if (!confirm(`The ${monthLabel(month)} claim has already been submitted.\n\nSave this receipt and reopen that claim? It will need resubmitting, with an exception report.`)) return;
      await reopenClaim(month, { ask: false });
    }
    ocrRun++; // ignore any reading still in progress
    const rec = { ...editing, updated: Date.now() };
    delete rec.isNew;
    try {
      await db.put(rec);
    } catch (err) {
      console.error(err);
      return toast('Could not save – phone storage may be full.');
    }
    settings.lastUnit = editing.unit;
    // Remember this vendor's expense type and business unit for next time.
    if (editing.vendor && !editing.splits.length && editing.category) {
      settings.vendorMemory = { ...(settings.vendorMemory || {}), [vendorKey(editing.vendor)]: { category: editing.category, unit: editing.unit } };
    }
    if (editing.attendees.length) settings.people = [...new Set([...editing.attendees.map(p => p.name), ...(settings.people || [])])].slice(0, 60);
    // Monthly repeats: the receipt itself is the template.
    const prevTemplate = (settings.recurring || []).find(t => t.id === editing.id);
    settings.recurring = (settings.recurring || []).filter(t => t.id !== editing.id);
    if (editing.recurring) {
      settings.recurring.push({
        id: editing.id, vendor: editing.vendor, purpose: editing.purpose, amount: editing.amount, gst: editing.gst, gstMode: editing.gstMode,
        currency: editing.currency, category: editing.category, unit: editing.unit, attendees: editing.attendees, splits: editing.splits,
        payment: editing.payment, travelStatus: editing.travelStatus,
        day: Number((editing.date || todayISO()).slice(8, 10)),
        lastMonth: prevTemplate && prevTemplate.lastMonth > monthOf(editing) ? prevTemplate.lastMonth : monthOf(editing),
      });
    }
    saveSettings();
    toast(editing.isNew ? 'Receipt saved' : 'Changes saved');
    editing = null;
    show('listView');
    renderList();
  });
  $('editCancel').onclick = () => { ocrRun++; editing = null; show('listView'); renderList(); };
  $('deleteBtn').onclick = async () => {
    if (editLocked || !confirm('Delete this receipt?')) return;
    await db.del(editing.id);
    editing = null;
    show('listView');
    renderList();
    toast('Receipt deleted');
  };

  /* ---------------- Supporting photos ---------------- */
  let attachUrls = [];
  function renderAttachments() {
    attachUrls.forEach(URL.revokeObjectURL);
    attachUrls = [];
    const grid = $('attachGrid');
    grid.innerHTML = '';
    (editing.attachments || []).forEach((a, i) => {
      const url = URL.createObjectURL(a.blob);
      attachUrls.push(url);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'attach-thumb';
      b.dataset.i = i;
      b.innerHTML = `<img src="${url}" alt="Supporting photo ${i + 1}">`;
      grid.appendChild(b);
    });
    const n = (editing.attachments || []).length;
    $('attachCount').textContent = n ? `(${n})` : '';
  }
  $('attachInput').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length || !editing) return;
    busy(true);
    try {
      for (const file of files) {
        const c = await fileToCanvas(file);
        const s = Math.min(1, 1600 / Math.max(c.width, c.height));
        const o = document.createElement('canvas');
        o.width = Math.round(c.width * s); o.height = Math.round(c.height * s);
        o.getContext('2d').drawImage(c, 0, 0, o.width, o.height);
        const blob = await toBlob(o, 'image/jpeg', 0.8);
        editing.attachments = [...(editing.attachments || []), { id: uid(), blob, w: o.width, h: o.height }];
      }
      renderAttachments();
      toast(files.length > 1 ? `${files.length} photos added` : 'Photo added');
    } catch (err) {
      console.error(err);
      toast('Could not add that photo.');
    } finally { busy(false); }
  });
  let viewing = -1;
  $('attachGrid').addEventListener('click', e => {
    const b = e.target.closest('.attach-thumb');
    if (!b) return;
    viewing = Number(b.dataset.i);
    $('viewerImg').src = attachUrls[viewing];
    $('viewerRemove').hidden = editLocked;
    $('viewer').hidden = false;
  });
  $('viewerClose').onclick = () => { $('viewer').hidden = true; };
  $('viewerRemove').onclick = () => {
    if (viewing < 0 || !confirm('Remove this supporting photo?')) return;
    editing.attachments = editing.attachments.filter((_, i) => i !== viewing);
    $('viewer').hidden = true;
    renderAttachments();
  };

  /* ---------------- Settings ---------------- */
  function renderSettings() {
    const f = $('settingsForm');
    f.name.value = settings.name;
    f.primary.value = settings.primary;
    f.accent.value = settings.accent;
    const ul = $('emailList');
    ul.innerHTML = settings.emails.length ? '' : '<li class="muted">No saved addresses yet.</li>';
    settings.emails.forEach((em, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(em)}</span><button type="button" data-i="${i}">Remove</button>`;
      ul.appendChild(li);
    });
  }
  function renderRecurringList() {
    const ul = $('recurringList');
    const list = settings.recurring || [];
    ul.innerHTML = list.length ? '' : '<li class="muted">None. Tick “Repeats every month” on a receipt to add a draft automatically each month.</li>';
    list.forEach(t => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(t.vendor)} · ${t.currency && t.currency !== 'AUD' ? escapeHtml(t.currency) + ' ' + (parseFloat(t.amount) || 0).toFixed(2) : money(t.amount)} · day ${t.day}</span><button type="button" data-stop="${t.id}">Stop</button>`;
      ul.appendChild(li);
    });
  }
  $('recurringList').addEventListener('click', async e => {
    const id = e.target.dataset.stop;
    if (!id) return;
    settings.recurring = (settings.recurring || []).filter(t => t.id !== id);
    saveSettings();
    const rec = await db.get(id);
    if (rec) await db.put({ ...rec, recurring: false });
    renderRecurringList();
    toast('Monthly repeat stopped');
  });

  /** Add this month's drafts for monthly repeats (receipt to follow), catching up any missed months. */
  async function runRecurring() {
    const list = settings.recurring || [];
    if (!list.length) return;
    const today = todayISO(), cur = today.slice(0, 7), dayNow = Number(today.slice(8, 10));
    const nextMonth = m => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
    let made = 0;
    for (const t of list) {
      let m = nextMonth(t.lastMonth);
      while (m <= cur && (m < cur || dayNow >= t.day)) {
        const [y, mo] = m.split('-').map(Number);
        const day = Math.min(t.day, new Date(y, mo, 0).getDate());
        await db.put({
          id: uid(), created: Date.now(), date: `${m}-${String(day).padStart(2, '0')}`, vendor: t.vendor, purpose: t.purpose,
          amount: t.amount, gst: t.gst, gstMode: t.gstMode, currency: t.currency || 'AUD', category: t.category, unit: t.unit,
          attendees: (t.attendees || []).map(p => ({ ...p })), splits: (t.splits || []).map(x => ({ ...x, id: uid() })),
          attachments: [], image: null, thumb: null, imageVer: 0, recurringFrom: t.id, payment: t.payment || 'company', travelStatus: t.travelStatus || '',
        });
        t.lastMonth = m; made++;
        m = nextMonth(m);
      }
    }
    if (made) { saveSettings(); toast(`${plural(made, 'monthly repeat')} added as draft${made === 1 ? '' : 's'} – add the receipt${made === 1 ? '' : 's'} when ${made === 1 ? 'it arrives' : 'they arrive'}.`, 4500); }
  }

  $('settingsBtn').onclick = () => { renderSettings(); renderRecurringList(); show('settingsView'); };
  $('settingsDone').onclick = () => {
    settings.name = $('settingsForm').name.value.trim();
    saveSettings();
    show('listView');
    renderList();
  };
  $('emailList').addEventListener('click', e => {
    const i = e.target.dataset.i;
    if (i == null) return;
    settings.emails.splice(Number(i), 1);
    saveSettings(); renderSettings();
  });
  function addEmail(em) {
    em = em.trim().toLowerCase();
    if (!isEmail(em)) { toast('That email address doesn’t look right.'); return false; }
    if (!settings.emails.includes(em)) settings.emails.push(em);
    saveSettings();
    return true;
  }
  $('addEmailBtn').onclick = () => {
    if (addEmail($('newEmail').value)) { $('newEmail').value = ''; renderSettings(); }
  };
  $('settingsForm').name.addEventListener('input', e => { settings.name = e.target.value.trim(); saveSettings(); });
  $('settingsForm').primary.addEventListener('input', e => { settings.primary = e.target.value; applyBrand(); saveSettings(); });
  $('settingsForm').accent.addEventListener('input', e => { settings.accent = e.target.value; applyBrand(); saveSettings(); });
  $('logoInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const c = await fileToCanvas(file);
      const s = Math.min(1, 400 / c.width, 120 / c.height);
      const o = document.createElement('canvas');
      o.width = Math.round(c.width * s); o.height = Math.round(c.height * s);
      o.getContext('2d').drawImage(c, 0, 0, o.width, o.height);
      settings.logo = o.toDataURL('image/png');
      saveSettings(); applyBrand();
      toast('Logo updated');
    } catch { toast('Could not read that image.'); }
  });
  $('clearLogoBtn').onclick = () => { settings.logo = ''; saveSettings(); applyBrand(); };
  $('clearSentBtn').onclick = async () => {
    const claims = (await db.claims.all()).filter(c => c.status === 'submitted');
    const months = new Set(claims.map(c => c.month));
    const recs = (await db.all()).filter(r => months.has(claimKeyOf(r)));
    if (!recs.length) return toast('No submitted claims to delete.');
    if (!confirm(`Delete ${plural(recs.length, 'receipt')} from ${plural(months.size, 'submitted claim')} on this phone?\n\nMake sure accounts has them – this can’t be undone.`)) return;
    for (const r of recs) await db.del(r.id);
    toast('Submitted claims deleted from this phone');
  };

  /* ---------------- Submitting a monthly claim ---------------- */
  let prepared = null; // { files, subject, body, month, items, total, exceptions, copy }

  async function openSubmit(month, { copy }) {
    const recs = (await db.all()).filter(r => claimKeyOf(r) === month);
    const missing = recs.filter(r => !r.unit || r.amount === '' || r.amount == null || !r.vendor || (isForeign(r) && audView(r).amount === ''));
    if (!copy && missing.length) {
      toast(`${plural(missing.length, 'receipt')} still need${missing.length === 1 ? 's' : ''} a vendor, total, business unit or AUD amount.`, 4500);
      return openEdit(missing[0].id);
    }
    const estimated = recs.filter(r => isForeign(r) && audView(r).audEstimated);
    if (!copy && estimated.length && !confirm(`${plural(estimated.length, 'overseas receipt')} still ${estimated.length === 1 ? 'uses' : 'use'} an estimated AUD amount (from the day's exchange rate):\n\n${estimated.map(r => `• ${r.vendor} ${fxLabel(r)} ≈ ${money(audTotal(r))}`).join('\n')}\n\nSubmit with the estimates? They're marked as estimates for accounts. When the bank statement arrives, updating them reopens the claim and shows on the exception report.`)) return;
    const noTaxInv = recs.filter(r => taxInvoiceIssue(r));
    const noPeople = recs.filter(r => needsPeople(r) && !(r.attendees || []).some(p => p.name));
    const noTravel = recs.filter(travelMissing);
    if (!copy && (noTaxInv.length || noPeople.length || noTravel.length)) {
      const lines = [
        ...noTravel.map(r => `• ${r.vendor} ${money(audTotal(r))} – entertainment: employee travelling or not?`),
        ...noTaxInv.map(r => `• ${r.vendor} ${money(r.amount)} – no tax invoice / ABN (GST may not be claimable)`),
        ...noPeople.map(r => `• ${r.vendor} ${money(audTotal(r))} – no attendees / employees listed`),
      ];
      if (!confirm(`Before you submit – accounts may query these:\n\n${lines.join('\n')}\n\nSubmit anyway? (Cancel to go back and fix them.)`)) return;
    }
    const toFollow = recs.filter(r => !r.image);
    if (!copy && toFollow.length && !confirm(`${plural(toFollow.length, 'receipt')} in this claim ${toFollow.length === 1 ? 'is' : 'are'} still to follow:\n\n${toFollow.map(r => `• ${r.vendor} ${money(audTotal(r))}`).join('\n')}\n\nSubmit anyway? They'll be marked “Receipt to follow”. Adding the photo later reopens the claim and shows up on the exception report.`)) return;
    const sel = $('sendTo');
    sel.innerHTML = '';
    for (const em of settings.emails) sel.add(new Option(em, em));
    sel.add(new Option('+ New address…', '__new'));
    sel.value = settings.emails.includes(settings.lastEmail) ? settings.lastEmail : (settings.emails[0] || '__new');
    $('sendToNewWrap').hidden = sel.value !== '__new';
    $('sendToNew').value = '';
    $('sendSheet').hidden = false;
    await prepare(month, recs, copy);
  }
  $('sendTo').onchange = e => { $('sendToNewWrap').hidden = e.target.value !== '__new'; };
  // Copying is its own tap: phones allow only one protected action (clipboard, app menu) per tap.
  $('copyToBtn').onclick = async () => {
    const to = $('sendTo').value === '__new' ? $('sendToNew').value.trim() : $('sendTo').value;
    if (!isEmail(to)) return toast('Enter the email address first.');
    try { await navigator.clipboard.writeText(to); toast(`Copied ${to} – paste it into “To”.`); }
    catch { toast(`Couldn’t copy – the address is ${to}`, 5000); }
  };
  $('sendCancel').onclick = () => { $('sendSheet').hidden = true; };
  $('sendSheet').addEventListener('click', e => { if (e.target === $('sendSheet')) $('sendSheet').hidden = true; });

  // Files are built before the user taps Send, so the share sheet opens instantly
  // (iOS only allows sharing directly inside the tap).
  async function prepare(month, recs, copy) {
    const go = $('sendGo');
    go.disabled = true; go.textContent = 'Preparing…';
    prepared = null;
    const claim = await getClaim(month);
    const ordered = orderForReport(recs);
    const items = ordered.map(r => snapshotOf(r, r.ref));
    const total = ordered.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    const totalGst = ordered.reduce((s, r) => s + (parseFloat(r.gst) || 0), 0);
    const prevSubs = claim.submissions.length;
    // A copy of a submitted claim is labelled as that submission; otherwise this is a new one.
    const submissionNo = copy ? Math.max(1, prevSubs) : prevSubs + 1;
    const previousSub = copy ? claim.submissions[prevSubs - 2] : claim.submissions[prevSubs - 1];
    const exceptions = submissionNo > 1
      ? (copy ? (claim.submissions[prevSubs - 1].exceptions || []) : exceptionsFor(claim, items))
      : [];
    const previous = previousSub ? { date: fmtDay(previousSub.at.slice(0, 10)), to: previousSub.to, total: previousSub.total } : null;
    const who = settings.name || 'Expenses';
    const label = monthLabel(month);
    const resubTag = submissionNo > 1 ? ` (resubmission ${submissionNo - 1})` : '';

    $('sendTitle').textContent = copy ? `Send a copy – ${label}` : `${submissionNo > 1 ? 'Resubmit' : 'Submit'} ${label} claim`;
    const unitLines = UNITS.map(u => [u, ordered.filter(r => r.unit === u)]).filter(([, l]) => l.length);
    $('sendSummary').innerHTML = `${plural(recs.length, 'receipt')} · <strong>${money(total) || '$0.00'}</strong><br>` +
      unitLines.map(([u, l]) => `${u}: ${money(l.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0))}`).join(' · ');
    const exBox = $('sendExceptions');
    exBox.hidden = submissionNo <= 1;
    if (submissionNo > 1) {
      exBox.innerHTML = `<strong>Exception report included</strong> – ${plural(exceptions.length, 'change')} since ${previous ? previous.date : 'the last submission'}:` +
        `<ul>${exceptions.slice(0, 6).map(x => `<li><b>${x.type}</b> ${escapeHtml(x.ref || '')} ${escapeHtml(x.vendor || '')}: ${escapeHtml(x.detail)}</li>`).join('')}${exceptions.length > 6 ? `<li>…and ${exceptions.length - 6} more</li>` : ''}</ul>`;
    }

    try {
      const withBytes = await Promise.all(ordered.map(async r => ({
        ...r,
        jpeg: r.image && !(r.splitIndex > 0) ? new Uint8Array(await r.image.arrayBuffer()) : null, // split lines share one receipt image
        attachments: await Promise.all((r.attachments || []).map(async a => ({ ...a, jpeg: new Uint8Array(await a.blob.arrayBuffer()) }))),
      })));
      const pdf = ExpensePdf.buildClaimReport({
        name: settings.name, monthLabel: label, submissionNo, previous, receipts: withBytes, exceptions, personal: isPersonalKey(month),
        primary: settings.primary, accent: settings.accent,
      });
      const xlsx = buildClaimSheet({ month, label, ordered, exceptions, submissionNo, previous, total, totalGst });
      const base = `${isPersonalKey(month) ? 'Reimbursement_Claim' : 'Expense_Claim'}_${safeFile(who)}_${monthOfKey(month)}${submissionNo > 1 ? `_resub${submissionNo - 1}` : ''}`;
      const pdfFile = new File([pdf], `${base}.pdf`, { type: 'application/pdf' });
      const xlsxFile = new File([xlsx], `${base}.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const csvFile = new File([buildClaimCsv(ordered, label)], `${base}.csv`, { type: 'text/csv' });
      const files = [pdfFile, xlsxFile];
      // Android's share menu won't take Excel files, so fall back to the same spreadsheet as CSV
      // (opens in Excel) rather than skipping the app picker.
      const canShare = f => !!(navigator.canShare && navigator.canShare({ files: f }));
      // What to hand the phone's app menu, best first. Android's Chrome says it can share Excel files
      // but then refuses, so on Android the spreadsheet goes as CSV (opens in Excel). If the phone
      // still refuses, the next tap tries the next option, ending with the PDF on its own.
      const android = /Android/i.test(navigator.userAgent);
      const shareOptions = (android ? [[pdfFile, csvFile], [pdfFile]] : [files, [pdfFile, csvFile], [pdfFile]]).filter(canShare);
      const shareFiles = shareOptions[0] || null;

      const subject = `${isPersonalKey(month) ? 'Reimbursement claim' : 'Expense claim'} – ${who} – ${label}${resubTag}`;
      const lines = unitLines.map(([u, l]) => `${u}: ${plural(l.length, 'receipt')}, ${money(l.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0))}`);
      const exText = submissionNo > 1
        ? `\n\nThis replaces the claim sent ${previous ? previous.date : 'earlier'}${previous ? ` (${money(previous.total)})` : ''}. Changes:\n` +
          (exceptions.length ? exceptions.map(x => `- ${x.type} ${x.ref || ''} ${x.vendor || ''}: ${x.detail}`).join('\n') : '- No line changes')
        : '';
      const body = (isPersonalKey(month)
        ? `Hi,\n\nPlease find attached my reimbursement claim for ${monthLabel(monthOfKey(month))}${resubTag} – business expenses I paid with my personal card or cash. Please reimburse the total to me.\n\n`
        : `Hi,\n\nPlease find attached my expense claim for ${label}${resubTag}.\n\n`) + `${lines.join('\n')}\n` +
        `Total: ${money(total) || '$0.00'} (GST ${money(totalGst) || '$0.00'}; ex GST ${money(total - totalGst) || '$0.00'})${exText}\n\n` +
        `Attached: PDF claim with receipts and supporting documents, and an Excel spreadsheet.\n\nThanks,\n${settings.name || ''}`.trim();

      prepared = { files, shareFiles, shareOptions, shareTry: 0, subject, body, month, items, total, exceptions, copy };
      $('viaShareOpt').hidden = !shareFiles;
      const via = shareFiles ? (settings.sendVia || 'share') : (settings.sendVia === 'save' ? 'save' : 'email');
      document.querySelectorAll('#viaPicker input').forEach(i => { i.checked = i.value === via; });
      updateSendNote();
      go.disabled = false; go.textContent = copy ? 'Send copy' : submissionNo > 1 ? 'Resubmit' : 'Submit';
    } catch (err) {
      console.error(err);
      go.textContent = 'Couldn’t build the files';
      toast('Couldn’t build the claim files.');
    }
  }

  function buildClaimSheet({ month, label, ordered, exceptions, submissionNo, previous, total, totalGst }) {
    const lines = ordered.map(r => [
      r.ref, label, r.unit || '', { v: r.date, t: 'date' }, r.vendor || '', r.abn || '', r.category || '', { v: r.purpose || '', t: 'wrap' },
      { v: (parseFloat(r.amount) || 0) - (parseFloat(r.gst) || 0), t: 'money' }, { v: parseFloat(r.gst) || 0, t: 'money' }, { v: parseFloat(r.amount) || 0, t: 'money' },
      (r.attachments || []).length, r.image ? 'Yes' : 'To follow',
      isForeign(r) ? r.currency : 'AUD', isForeign(r) ? { v: parseFloat(r.fxAmount) || 0, t: 'money' } : '', isForeign(r) && r.rate ? { v: Math.round(r.rate * 10000) / 10000, t: 'number' } : '',
      isForeign(r) ? (r.audBasis === 'estimate' ? `Estimate – daily rate ${r.audEstimateDate || ''}`.trim() : r.audSource === 'bank' ? 'Bank statement' : 'Entered') : '',
      r.splitOfRef ? `Split of ${r.splitOfRef} (bill ${money(r.receiptTotal)})` : '',
      isForeign(r) ? 'n/a – overseas' : (parseFloat(r.receiptTotal) || 0) <= TAX_INVOICE_LIMIT ? 'Not required (≤ $82.50)' : r.taxInvIssue ? 'MISSING' : 'Yes',
      { v: r.attendeesText || '', t: 'wrap' }, (r.attendees || []).filter(p => p.name).length || '',
      MEAL_CATS.includes(r.category) && (r.attendees || []).length ? { v: (parseFloat(r.amount) || 0) / r.attendees.length, t: 'money' } : '',
      ENT_CATS.includes(r.category) ? travelCell(r) : '',
      r.payment === 'personal' ? 'Personal card / cash' : 'Company card',
    ]);
    lines.push(null, ['', '', '', '', { v: 'TOTAL', t: 'bold' }, '', '', '', { v: total - totalGst, t: 'boldMoney' }, { v: totalGst, t: 'boldMoney' }, { v: total, t: 'boldMoney' }, '', '', '', '', '', '', '', '', '', '', '', '', '']);
    const sheets = [{
      name: 'Claim lines',
      columns: [
        { header: 'Ref', width: 6 }, { header: 'Claim month', width: 15 }, { header: 'Business unit', width: 14 }, { header: 'Date', width: 12, type: 'date' },
        { header: 'Vendor', width: 28 }, { header: 'ABN', width: 16 }, { header: 'Expense type', width: 22 }, { header: 'Purpose', width: 40 },
        { header: 'Ex GST', width: 12, type: 'money' }, { header: 'GST', width: 10, type: 'money' }, { header: 'Total', width: 12, type: 'money' },
        { header: 'Supporting docs', width: 15, type: 'number' }, { header: 'Receipt', width: 11 },
        { header: 'Currency', width: 10 }, { header: 'Foreign total', width: 13, type: 'money' }, { header: 'Rate to AUD', width: 12, type: 'number' }, { header: 'AUD from', width: 15 },
        { header: 'Split', width: 24 }, { header: 'Tax invoice', width: 20 }, { header: 'Attendees / travellers', width: 50 }, { header: 'People', width: 8, type: 'number' }, { header: 'Cost per head', width: 13, type: 'money' },
        { header: 'Employee travelling', width: 18 }, { header: 'Paid with', width: 20 },
      ],
      rows: lines,
    }];
    const unitRows = UNITS.concat([...new Set(ordered.map(r => r.unit).filter(u => u && !UNITS.includes(u)))]).map(u => {
      const l = ordered.filter(r => r.unit === u);
      if (!l.length) return null;
      const t = l.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0), g = l.reduce((s, r) => s + (parseFloat(r.gst) || 0), 0);
      return [u, { v: l.length, t: 'number' }, { v: t - g, t: 'money' }, { v: g, t: 'money' }, { v: t, t: 'money' }];
    }).filter(Boolean);
    sheets.push({
      name: 'Summary',
      columns: [{ header: 'Business unit', width: 22 }, { header: 'Receipts', width: 10, type: 'number' }, { header: 'Ex GST', width: 14, type: 'money' }, { header: 'GST', width: 12, type: 'money' }, { header: 'Total', width: 14, type: 'money' }],
      rows: [
        ...unitRows,
        [{ v: 'TOTAL', t: 'bold' }, { v: ordered.length, t: 'number' }, { v: total - totalGst, t: 'boldMoney' }, { v: totalGst, t: 'boldMoney' }, { v: total, t: 'boldMoney' }],
        null,
        [{ v: 'Claimant', t: 'bold' }, settings.name || ''],
        [{ v: 'Claim month', t: 'bold' }, label],
        [{ v: 'Submission', t: 'bold' }, submissionNo > 1 ? `Resubmission ${submissionNo - 1}` : 'Original'],
        [{ v: 'Prepared', t: 'bold' }, { v: todayISO(), t: 'date' }],
        ...(previous ? [[{ v: 'Previous total', t: 'bold' }, { v: previous.total, t: 'money' }], [{ v: 'Previously sent', t: 'bold' }, `${previous.date} to ${previous.to}`]] : []),
      ],
    });
    if (submissionNo > 1) {
      sheets.push({
        name: 'Exceptions',
        columns: [{ header: 'Ref', width: 6 }, { header: 'Change', width: 10 }, { header: 'Vendor', width: 28 }, { header: 'Detail', width: 90 }],
        rows: exceptions.length ? exceptions.map(x => [x.ref || '', x.type, x.vendor || '', { v: x.detail, t: 'wrap' }]) : [['', 'None', '', 'Resent with no line changes']],
      });
    }
    return Xlsx.buildXlsx(sheets);
  }

  const sendVia = () => { const c = document.querySelector('#viaPicker input:checked'); return c ? c.value : 'share'; };
  function updateSendNote() {
    const p = prepared;
    if (!p) return;
    const via = sendVia();
    $('sendNote').textContent =
      via === 'share' ? `Your phone’s app menu opens – pick Gmail, Outlook, Mail or any other app. Tap Copy first if you want to paste the address into “To”.${p.shareFiles && p.shareFiles.length === 2 && /csv$/.test(p.shareFiles[1].name) ? ' (This phone only shares the spreadsheet as CSV – it opens in Excel.)' : p.shareFiles && p.shareFiles.length === 1 ? ' (This phone can only share the PDF this way – the spreadsheet is saved to your files.)' : ''}`
      : via === 'email' ? 'Your default email app opens with the address, subject and message filled in. The files are saved to your phone – attach them to the email.'
      : 'The PDF and spreadsheet are saved to your phone (Downloads / Files) to send however you like.';
  }
  document.querySelectorAll('#viaPicker input').forEach(i => i.addEventListener('change', () => {
    settings.sendVia = i.value; saveSettings(); updateSendNote();
  }));

  function saveFiles(files) {
    for (const f of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
  }

  function buildClaimCsv(ordered, label) {
    const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['Ref', 'Claim month', 'Business unit', 'Date', 'Vendor', 'ABN', 'Expense type', 'Purpose', 'Ex GST (AUD)', 'GST (AUD)', 'Total (AUD)', 'Supporting docs', 'Receipt', 'Currency', 'Foreign total', 'Rate to AUD', 'AUD from', 'Split', 'Tax invoice', 'Attendees / travellers', 'Employee travelling', 'Paid with'];
    const rows = ordered.map(r => [r.ref, label, r.unit || '', r.date ? r.date.split('-').reverse().join('/') : '', r.vendor || '', r.abn || '', r.category || '', r.purpose || '',
      ((parseFloat(r.amount) || 0) - (parseFloat(r.gst) || 0)).toFixed(2), (parseFloat(r.gst) || 0).toFixed(2), (parseFloat(r.amount) || 0).toFixed(2),
      (r.attachments || []).length, r.image ? 'Yes' : 'To follow',
      isForeign(r) ? r.currency : 'AUD', isForeign(r) ? (parseFloat(r.fxAmount) || 0).toFixed(2) : '', isForeign(r) && r.rate ? r.rate.toFixed(4) : '',
      isForeign(r) ? (r.audBasis === 'estimate' ? 'Estimate (daily rate)' : r.audSource === 'bank' ? 'Bank statement' : 'Entered') : '',
      r.splitOfRef ? `Split of ${r.splitOfRef}` : '', isForeign(r) ? 'n/a' : (parseFloat(r.receiptTotal) || 0) <= TAX_INVOICE_LIMIT ? 'Not required' : r.taxInvIssue ? 'MISSING' : 'Yes', r.attendeesText || '',
      ENT_CATS.includes(r.category) ? travelCell(r) : '', r.payment === 'personal' ? 'Personal card / cash' : 'Company card']);
    return '\uFEFF' + [head, ...rows].map(r => r.map(q).join(',')).join('\r\n');
  }

  $('sendGo').onclick = async () => {
    if (!prepared) return;
    let to = $('sendTo').value;
    if (to === '__new') {
      to = $('sendToNew').value.trim().toLowerCase();
      if (!addEmail(to)) return;
    }
    settings.lastEmail = to;
    saveSettings();
    const p = prepared;

    const via = sendVia();
    if (via === 'share' && p.shareFiles) {
      try {
        await navigator.share({ files: p.shareFiles, title: p.subject, text: p.body });
        if (!p.shareFiles.some(f => /xlsx|csv$/.test(f.name))) saveFiles([p.files[1]]); // spreadsheet the phone wouldn't share
        await markSubmitted(p, to);
      } catch (err) {
        if (err && err.name === 'AbortError') return; // closed the app menu without sending
        console.error(err);
        const why = `${err && err.name || 'Error'}${err && err.message ? ': ' + err.message : ''}`;
        if (p.shareTry + 1 < p.shareOptions.length) {
          // The phone refused these files – the next tap tries a simpler set (finally just the PDF).
          p.shareTry++;
          p.shareFiles = p.shareOptions[p.shareTry];
          updateSendNote();
          $('sendGo').textContent = 'Tap again to open apps';
          toast(`The phone didn’t take those files (${why}). Tap the button again to try ${p.shareFiles.length === 1 ? 'the PDF on its own' : 'a simpler format'}.`, 6000);
        } else {
          toast(`The phone won’t open the app menu (${why}). Choose “Just save the files” instead.`, 7000);
        }
      }
    } else if (via === 'save') {
      saveFiles(p.files);
      setTimeout(async () => {
        if (!p.copy && confirm('Files saved. Once you’ve emailed them, mark the claim as submitted (this locks its receipts)?')) await markSubmitted(p, to);
        else if (p.copy) $('sendSheet').hidden = true;
      }, 800);
    } else {
      mailtoFallback(to, p);
    }
  };

  function mailtoFallback(to, p) {
    saveFiles(p.files);
    const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(p.subject)}&body=${encodeURIComponent(p.body + '\n\n(Attachments: ' + p.files.map(f => f.name).join(', ') + ')')}`;
    setTimeout(() => {
      window.location.href = href;
      setTimeout(async () => {
        if (p.copy) return;
        if (confirm('Did you send the email? Mark the claim as submitted (this locks its receipts)?')) await markSubmitted(p, to);
      }, 1500);
    }, 400);
  }

  async function markSubmitted(p, to) {
    $('sendSheet').hidden = true;
    if (p.copy) { toast(`Copy sent to ${to}`); return; }
    const claim = await getClaim(p.month);
    claim.submissions.push({ at: new Date().toISOString(), to, total: p.total, items: p.items, exceptions: p.exceptions });
    claim.status = 'submitted';
    await db.claims.put(claim);
    toast(`${monthLabel(p.month)} claim submitted – receipts locked`);
    renderList();
  }

  /* ---------------- Spending dashboard ---------------- */
  let dashPeriod = 'fy';
  function periodRange(p) {
    const t = todayISO(), [y, m] = t.split('-').map(Number);
    const ym = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}`;
    const add = (yy, mm, n) => { const d = new Date(yy, mm - 1 + n, 1); return [d.getFullYear(), d.getMonth() + 1]; };
    if (p === 'month') return { from: ym(y, m), to: ym(y, m), label: monthLabel(ym(y, m)) };
    if (p === 'last') { const [a, b] = add(y, m, -1); return { from: ym(a, b), to: ym(a, b), label: monthLabel(ym(a, b)) }; }
    if (p === 'fy') { const fyStart = m >= 7 ? y : y - 1; return { from: ym(fyStart, 7), to: ym(fyStart + 1, 6), label: `Financial year ${fyStart}–${String(fyStart + 1).slice(2)}` }; }
    const [a, b] = add(y, m, -11); return { from: ym(a, b), to: ym(y, m), label: 'Last 12 months' };
  }
  function monthsBetween(from, to) {
    const out = []; let [y, m] = from.split('-').map(Number);
    while (`${y}-${String(m).padStart(2, '0')}` <= to) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
    return out;
  }
  async function renderDash() {
    const { from, to, label } = periodRange(dashPeriod);
    const recs = (await db.all()).filter(r => { const mo = monthOf(r); return mo >= from && mo <= to; });
    const lines = recs.flatMap(linesOf).filter(l => l.amount !== '');
    const total = lines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
    const gst = lines.reduce((s, l) => s + (parseFloat(l.gst) || 0), 0);
    const group = (key, none = 'Not set') => {
      const m = new Map();
      for (const l of lines) { const k = key(l) || none; m.set(k, (m.get(k) || 0) + (parseFloat(l.amount) || 0)); }
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const bars = (rows, title) => {
      const max = Math.max(...rows.map(r => r[1]), 1);
      return `<section class="dash-card"><h3>${title}</h3>${rows.length ? rows.map(([k, v]) => `
        <div class="hbar" title="${escapeHtml(k)}: ${money(v)} (${Math.round(v / (total || 1) * 100)}%)">
          <span class="hbar-label">${escapeHtml(k)}</span>
          <span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(1.5, v / max * 100)}%"></span></span>
          <span class="hbar-val">${money(v)}</span>
        </div>`).join('') : '<p class="muted small">Nothing yet.</p>'}</section>`;
    };
    const byType = group(l => l.category, 'No expense type'), byUnit = group(l => l.unit, 'No business unit');
    const vendors = group(l => l.vendor).slice(0, 5);
    const months = monthsBetween(from, to);
    const perMonth = months.map(mo => [mo, lines.filter(l => monthOf(l) === mo).reduce((s, l) => s + (parseFloat(l.amount) || 0), 0)]);
    const maxM = Math.max(...perMonth.map(x => x[1]), 1);
    const peak = perMonth.reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0]);
    const est = recs.filter(r => isForeign(r) && audView(r).audEstimated).length;
    const cols = months.length > 1 ? `<section class="dash-card"><h3>By month</h3>
      <div class="cols" role="img" aria-label="Spend by month">${perMonth.map(([mo, v]) => `
        <button type="button" class="col" data-tip="${escapeHtml(monthLabel(mo))}: ${money(v)}" title="${escapeHtml(monthLabel(mo))}: ${money(v)}">
          <span class="col-val">${mo === peak[0] && v ? money(v).replace(/\.\d\d$/, '') : ''}</span>
          <span class="col-bar" style="height:${v ? Math.max(3, v / maxM * 100) : 0}%"></span>
          <span class="col-label">${new Date(mo + '-01T00:00').toLocaleDateString('en-AU', { month: 'short' }).slice(0, 3)}</span>
        </button>`).join('')}</div>
      <p class="muted small" id="colTip">Tap a month for its total.</p>
      <details class="dash-table"><summary>Show as table</summary><table>${perMonth.map(([mo, v]) => `<tr><td>${monthLabel(mo)}</td><td>${money(v)}</td></tr>`).join('')}</table></details></section>` : '';
    $('dashBody').innerHTML = `
      <p class="dash-period">${escapeHtml(label)}${est ? ` · <span class="est">includes ${est} estimated AUD amount${est === 1 ? '' : 's'}</span>` : ''}</p>
      <div class="tiles">
        <div class="tile"><span>Total spend</span><b>${money(total) || '$0.00'}</b></div>
        <div class="tile"><span>GST</span><b>${money(gst) || '$0.00'}</b></div>
        <div class="tile"><span>Receipts</span><b>${recs.length}</b></div>
      </div>
      ${cols}
      ${bars(byType, 'By expense type')}
      ${bars(byUnit, 'By business unit')}
      ${bars(vendors, 'Top vendors')}`;
  }
  $('dashBtn').onclick = () => { show('dashView'); renderDash(); };
  $('dashDone').onclick = () => { show('listView'); renderList(); };
  $('dashPeriods').addEventListener('click', e => {
    const b = e.target.closest('[data-period]'); if (!b) return;
    dashPeriod = b.dataset.period;
    document.querySelectorAll('#dashPeriods .tab').forEach(t => t.classList.toggle('active', t === b));
    renderDash();
  });
  $('dashBody').addEventListener('click', e => {
    const c = e.target.closest('.col'); if (!c) return;
    document.querySelectorAll('.col').forEach(x => x.classList.toggle('on', x === c));
    $('colTip').textContent = c.dataset.tip;
  });

  /* ---------------- Bank statement reconciliation ---------------- */
  let reconData = null; // { name, from, to, note, transactions, result }

  $('reconBtn').onclick = () => { show('reconView'); if (settings.statement) runRecon(settings.statement); else renderRecon(); };
  $('reconDone').onclick = () => { show('listView'); renderList(); };
  $('stmtInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return toast('PDF statements can’t be read – export a CSV from your online banking instead.', 5000);
    try {
      const text = await file.text();
      const s = Recon.parseStatement(text, file.name);
      if (!s.transactions.length) return toast(s.note || 'No spending found in that file.', 5000);
      settings.statement = { name: file.name, from: s.from, to: s.to, note: s.note, transactions: s.transactions };
      saveSettings();
      runRecon(settings.statement);
    } catch (err) {
      console.error(err);
      toast('Couldn’t read that file.');
    }
  });

  /** Put the AUD charge from the statement onto a foreign-currency claim. */
  async function useBankAud(id, amount) {
    const rec = await db.get(id);
    if (!rec) return;
    const month = claimKeyOf(rec);
    if (await isLocked(month)) {
      if (!confirm(`The ${monthLabel(month)} claim is submitted. Reopen it to add the AUD amount?`)) return;
      await reopenClaim(month, { ask: false });
    }
    await db.put({ ...rec, audAmount: amount, audSource: 'bank', updated: Date.now() });
    toast(`${rec.vendor}: AUD ${money(amount)} added from the statement`);
    if (settings.statement) runRecon(settings.statement);
  }

  async function runRecon(stmt) {
    const recs = await db.all();
    const result = Recon.reconcile(stmt.transactions, recs.map(r => audView(r, { actualOnly: true })), stmt);
    reconData = { ...stmt, result };
    renderRecon();
  }

  function renderRecon() {
    const out = $('reconResult');
    $('reconExport').disabled = !reconData;
    if (!reconData) { out.innerHTML = ''; return; }
    const { result: r } = reconData;
    const ignored = new Set(settings.reconIgnore);
    const unclaimed = r.unclaimed.filter(t => !ignored.has(t.key));
    const personal = r.unclaimed.filter(t => ignored.has(t.key));
    const tx = t => `<div class="rc-line"><span>${escapeHtml(fmtDay(t.date))}</span><span class="rc-desc">${escapeHtml(t.desc)}</span><strong>${money(t.amount)}</strong></div>`;
    const cl = c => `<div class="rc-line"><span>${escapeHtml(fmtDay(c.date))}</span><span class="rc-desc">${escapeHtml(c.vendor || '')}${c.unit ? ` · ${escapeHtml(c.unit)}` : ''}${isForeign(c) ? ` · ${escapeHtml(fxLabel(c))}` : ''}${c.payment === 'personal' ? ' · personal card' : ''}</span><strong>${c.amount !== '' ? money(c.amount) : c.audEstimate ? `<span class="est">~${money(c.audEstimate)}</span>` : 'AUD ?'}</strong></div>`;
    out.innerHTML = `
      <div class="rc-file">${escapeHtml(reconData.name)} · ${escapeHtml(fmtDay(reconData.from))} – ${escapeHtml(fmtDay(reconData.to))} · ${plural(reconData.transactions.length, 'purchase')}${reconData.note ? `<br><span class="muted small">${escapeHtml(reconData.note)}</span>` : ''}</div>
      <div class="rc-tiles">
        <div class="rc-tile ok"><b>${r.matched.length}</b>Matched</div>
        <div class="rc-tile bad"><b>${r.mismatched.length}</b>Incorrect</div>
        <div class="rc-tile warn"><b>${unclaimed.length}</b>Not claimed</div>
        <div class="rc-tile info"><b>${r.notOnStatement.length}</b>Not on statement</div>
      </div>
      ${r.fxFound.length ? `<h3 class="rc-h info">Foreign currency – AUD charge found</h3><p class="muted small">These overseas receipts have no AUD amount yet. The likely card charge is shown – tap to use it.</p>
        ${r.fxFound.map(m => `<div class="rc-card info">${tx(m.tx)}${cl(m.claim)}<div class="rc-actions"><button class="btn small ghost" data-open="${m.claim.id}">Open claim</button><button class="btn small" data-fx="${m.claim.id}|${m.tx.amount.toFixed(2)}">Use ${money(m.tx.amount)} AUD</button></div></div>`).join('')}` : ''}
      ${r.mismatched.length ? `<h3 class="rc-h bad">Incorrect claims</h3><p class="muted small">The bank and the claim don’t agree. Check the receipt and fix the claim.</p>
        ${r.mismatched.map(m => `<div class="rc-card bad"><div class="rc-issue">${escapeHtml(m.issue)}</div>${tx(m.tx)}${cl(m.claim)}<div class="rc-actions"><button class="btn small" data-open="${m.claim.id}">Open claim</button></div></div>`).join('')}` : ''}
      ${unclaimed.length ? `<h3 class="rc-h warn">On the statement but not claimed</h3><p class="muted small">Missing claims – or personal spending you can mark as not claimable.</p>
        ${unclaimed.map(t => `<div class="rc-card warn">${tx(t)}<div class="rc-actions"><button class="btn small ghost" data-ignore="${escapeHtml(t.key)}">Personal / not claimable</button><button class="btn small" data-add="${escapeHtml(t.key)}">Add claim</button></div></div>`).join('')}` : ''}
      ${r.notOnStatement.length ? `<h3 class="rc-h info">Claimed but not on this statement</h3><p class="muted small">Paid another way (cash, another card), or the date/amount is wrong.</p>
        ${r.notOnStatement.map(c => `<div class="rc-card info">${cl(c)}<div class="rc-actions"><button class="btn small ghost" data-open="${c.id}">Open claim</button></div></div>`).join('')}` : ''}
      ${r.matched.length ? `<details class="rc-more"><summary>${plural(r.matched.length, 'matched purchase')}</summary>${r.matched.map(m => `<div class="rc-card ok">${tx(m.tx)}</div>`).join('')}</details>` : ''}
      ${personal.length ? `<details class="rc-more"><summary>${personal.length} marked personal / not claimable</summary>${personal.map(t => `<div class="rc-card">${tx(t)}<div class="rc-actions"><button class="btn small ghost" data-unignore="${escapeHtml(t.key)}">Undo</button></div></div>`).join('')}</details>` : ''}`;
  }

  $('reconResult').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.open) openEdit(b.dataset.open);
    if (b.dataset.fx) useBankAud(...b.dataset.fx.split('|'));
    if (b.dataset.ignore) { settings.reconIgnore = [...new Set([...settings.reconIgnore, b.dataset.ignore])]; saveSettings(); renderRecon(); }
    if (b.dataset.unignore) { settings.reconIgnore = settings.reconIgnore.filter(k => k !== b.dataset.unignore); saveSettings(); renderRecon(); }
    if (b.dataset.add) {
      const t = reconData.transactions.find(x => x.key === b.dataset.add);
      if (!t) return;
      // Bank text like "BRISBANE AIRPORT PARKING BRISBANE AIRP QLD AUS Card xx8504" → "Brisbane Airport Parking"
      let vendor = t.desc.replace(/\s+(card\s|value date|(qld|nsw|vic|wa|sa|tas|act|nt|aus|au)\b).*$/i, '').replace(/\s{2,}/g, ' ').trim();
      const words = vendor.split(' ');
      for (let n = 1; n < words.length; n++) { // drop a trailing repeat of the location ("… BRISBANE AIRP")
        const tail = words.slice(n).join(' ').toLowerCase();
        if (tail.length >= 4 && words.slice(0, n).join(' ').toLowerCase().includes(tail.split(' ')[0])) { vendor = words.slice(0, n).join(' '); break; }
      }
      vendor = vendor.slice(0, 40);
      prefill = { date: t.date, amount: t.amount.toFixed(2), vendor: vendor.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()) };
      startWithoutReceipt();
      toast('Bank details filled in – add the receipt photo now or later.', 4000);
    }
  });

  $('reconExport').onclick = async () => {
    if (!reconData) return;
    const r = reconData.result;
    const ignored = new Set(settings.reconIgnore);
    const rows = [];
    const add = (status, t, c, note) => rows.push([
      status, t ? { v: t.date, t: 'date' } : '', t ? t.desc : '', t ? { v: t.amount, t: 'money' } : '',
      c ? { v: c.date, t: 'date' } : '', c ? c.vendor || '' : '', c ? c.unit || '' : '', c ? { v: parseFloat(c.amount) || 0, t: 'money' } : '', note || '',
    ]);
    r.mismatched.forEach(m => add('Incorrect', m.tx, m.claim, m.issue));
    r.unclaimed.forEach(t => add(ignored.has(t.key) ? 'Personal' : 'Not claimed', t, null, ignored.has(t.key) ? 'Marked personal / not claimable' : 'On statement, no claim'));
    r.fxFound.forEach(m => add('Foreign – AUD found', m.tx, m.claim, `${fxLabel(m.claim)} receipt – AUD charge on statement`));
    r.notOnStatement.forEach(c => add('Not on statement', null, c, 'Claimed, not found on this statement'));
    r.matched.forEach(m => add('Matched', m.tx, m.claim, ''));
    const blob = Xlsx.buildXlsx([{
      name: 'Reconciliation',
      columns: [
        { header: 'Status', width: 16 }, { header: 'Bank date', width: 12, type: 'date' }, { header: 'Bank description', width: 40 }, { header: 'Bank amount', width: 13, type: 'money' },
        { header: 'Claim date', width: 12, type: 'date' }, { header: 'Claim vendor', width: 28 }, { header: 'Business unit', width: 14 }, { header: 'Claim amount', width: 13, type: 'money' }, { header: 'Note', width: 50 },
      ],
      rows,
    }]);
    const file = new File([blob], `Reconciliation_${reconData.from}_to_${reconData.to}.xlsx`, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Expense reconciliation' }); } catch (err) { if (err.name !== 'AbortError') console.error(err); }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
    }
  };

  /* ---------------- Boot ---------------- */
  // Earlier versions marked receipts "sent" one by one; turn those into submitted monthly claims.
  async function migrate() {
    const [recs, claims] = await Promise.all([db.all(), db.claims.all()]);
    if (claims.length || !recs.some(r => r.sent)) return;
    const months = new Map();
    for (const r of recs) { const m = monthOf(r); if (!months.has(m)) months.set(m, []); months.get(m).push(r); }
    for (const [m, list] of months) {
      const sent = list.filter(r => r.sent);
      if (!sent.length) continue;
      const ordered = orderForReport(sent);
      const at = sent.map(r => r.sentAt || '').sort().pop() || new Date().toISOString();
      await db.claims.put({
        month: m,
        status: sent.length === list.length ? 'submitted' : 'reopened',
        submissions: [{ at, to: sent[0].sentTo || '', total: sent.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0), items: ordered.map(r => snapshotOf(r, r.ref)), exceptions: [] }],
      });
    }
  }

  applyBrand();
  migrate().catch(console.error).then(() => runRecurring().catch(console.error)).then(renderList).then(handleShared);
  $('appVersion').textContent = `App version ${APP_VERSION}`;
  // Pick up new versions straight away: never use a cached sw.js, check on every open,
  // and reload once when a new version takes over (only while on the claims list).
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => {
        const check = () => reg.update().catch(() => {});
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      })
      .catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      if (!$('listView').hidden) location.reload();
      else toast('App updated – it will refresh next time you open it.', 4000);
    });
  }
})();
