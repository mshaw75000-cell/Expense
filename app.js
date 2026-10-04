/* Mentis Expenses – receipt capture and monthly claims. Everything is stored on the device. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const MAX_WORK_SIDE = 2400;
  const APP_VERSION = '12';
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
  const views = ['listView', 'cropView', 'editView', 'settingsView', 'reconView'];
  const titles = { listView: 'Claims', cropView: 'Crop', editView: 'Receipt', settingsView: 'Settings', reconView: 'Reconcile' };
  function show(view) {
    views.forEach(v => { $(v).hidden = v !== view; });
    $('viewTitle').textContent = titles[view];
    $('settingsBtn').hidden = view !== 'listView';
    $('reconBtn').hidden = view !== 'listView';
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
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const safeFile = s => String(s || '').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');
  const fmtDay = iso => iso ? ExpensePdf.fmtDate(iso) : '';

  /* ---------------- Months & claims ----------------
     Every receipt belongs to the month of its date. A month's claim is:
       open      – not submitted yet (editable)
       submitted – sent; its receipts are locked
       reopened  – unlocked after submitting; resubmitting includes an exception report */
  const monthOf = r => (r.date || todayISO()).slice(0, 7);
  const monthLabel = m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }); };
  async function getClaim(month) { return (await db.claims.get(month)) || { month, status: 'open', submissions: [] }; }
  async function isLocked(month) { return (await getClaim(month)).status === 'submitted'; }

  // What accounts sees as a change: these fields, compared with the last submission.
  const TRACKED = [
    ['date', 'Date'], ['vendor', 'Vendor'], ['purpose', 'Purpose'], ['unit', 'Business unit'], ['category', 'Expense type'],
    ['amount', 'Total (AUD)'], ['gst', 'GST'], ['currency', 'Currency'], ['fxAmount', 'Foreign amount'], ['hasReceipt', 'Receipt'], ['attachCount', 'Supporting documents'], ['imageVer', 'Receipt image'],
  ];
  const snapshotOf = (r, ref) => ({
    id: r.id, ref, date: r.date || '', vendor: r.vendor || '', purpose: r.purpose || '', unit: r.unit || '', category: r.category || '',
    amount: r.amount || '', gst: r.gst || '', currency: r.currency || 'AUD', fxAmount: r.fxAmount || '', hasReceipt: !!r.image, attachCount: (r.attachments || []).length, imageVer: r.imageVer || 0,
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
      const changes = TRACKED.filter(([k]) => String(old[k]) !== String(cur[k]))
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
  function audView(r) {
    if (!isForeign(r)) return r;
    const aud = r.audAmount === '' || r.audAmount == null ? '' : String(r.audAmount);
    const fx = parseFloat(r.amount);
    const rate = aud !== '' && fx ? parseFloat(aud) / fx : null;
    const gst = aud === '' ? '' : ((parseFloat(r.gst) || 0) && rate ? (Math.round(parseFloat(r.gst) * rate * 100) / 100).toFixed(2) : '0.00');
    return { ...r, fxAmount: r.amount, fxGst: r.gst, amount: aud, gst, rate };
  }
  const audTotal = r => parseFloat(audView(r).amount) || 0;
  const fxLabel = r => isForeign(r) ? `${r.currency} ${(parseFloat(r.fxAmount ?? r.amount) || 0).toFixed(2)}` : '';

  /** Report order: by business unit, then date. Gives each receipt a reference R1, R2… (amounts in AUD) */
  function orderForReport(recs) {
    const unitRank = u => { const i = UNITS.indexOf(u); return i < 0 ? 99 : i; };
    return recs.slice().sort((a, b) => unitRank(a.unit) - unitRank(b.unit) || (a.date || '').localeCompare(b.date || '') || a.created - b.created)
      .map((r, i) => ({ ...audView(r), ref: 'R' + (i + 1) }));
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
  const LOCK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  async function renderList() {
    const [all, claims] = await Promise.all([db.all(), db.claims.all()]);
    const claimMap = new Map(claims.map(c => [c.month, c]));
    const months = new Map();
    for (const r of all) { const m = monthOf(r); if (!months.has(m)) months.set(m, []); months.get(m).push(r); }
    for (const c of claims) if (!months.has(c.month) && c.status === 'reopened') months.set(c.month, []);

    thumbUrls.forEach(URL.revokeObjectURL);
    thumbUrls = [];
    const wrap = $('monthList');
    wrap.innerHTML = '';
    const keys = [...months.keys()].sort().reverse();
    let shown = 0;
    for (const m of keys) {
      const claim = claimMap.get(m) || { month: m, status: 'open', submissions: [] };
      const isSubmitted = claim.status === 'submitted';
      if ((filter === 'submitted') !== isSubmitted) continue;
      shown++;
      const recs = months.get(m).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.created - a.created);
      const total = recs.reduce((s, r) => s + audTotal(r), 0);
      const byUnit = UNITS.map(u => [u, recs.filter(r => r.unit === u).reduce((s, r) => s + audTotal(r), 0)]).filter(([, v]) => v);
      const needAud = recs.filter(r => isForeign(r) && audView(r).amount === '').length;
      const unassigned = recs.filter(r => !r.unit).length;
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
            <h2>${monthLabel(m)}</h2>
            <div class="month-meta">${plural(recs.length, 'receipt')}${byUnit.map(([u, v]) => ` · ${u} ${money(v)}`).join('')}${unassigned ? ` · <span class="warn">${unassigned} without business unit</span>` : ''}${noReceipt ? ` · <span class="warn">${plural(noReceipt, 'receipt')} to follow</span>` : ''}${needAud ? ` · <span class="warn">${needAud} need${needAud === 1 ? 's' : ''} AUD amount</span>` : ''}</div>
          </div>
          <div class="month-total">${money(total) || '$0.00'}${status}</div>
        </div>
        ${last ? `<div class="month-sub">${claim.status === 'reopened' ? `Reopened · ${plural(changes, 'change')} since ` : ''}submitted ${fmtDay(last.at.slice(0, 10))} to ${escapeHtml(last.to)}${claim.submissions.length > 1 ? ` (resubmission ${claim.submissions.length - 1})` : ''}</div>` : ''}
        <ul class="receipt-list"></ul>
        <div class="month-actions">
          ${isSubmitted
            ? `<button class="btn ghost" data-act="reopen">Reopen claim</button><button class="btn ghost" data-act="resend">Send copy</button>`
            : `<button class="btn primary" data-act="submit"${recs.length ? '' : ' disabled'}>${claim.status === 'reopened' ? 'Resubmit claim' : 'Submit claim'}</button>`}
        </div>`;
      const ul = sec.querySelector('ul');
      for (const r of recs) {
        const url = r.thumb ? URL.createObjectURL(r.thumb) : '';
        if (url) thumbUrls.push(url);
        const li = document.createElement('li');
        li.className = 'receipt' + (isSubmitted ? ' locked' : '');
        li.dataset.id = r.id;
        const n = (r.attachments || []).length;
        li.innerHTML = `
          ${url ? `<img class="thumb" src="${url}" alt="">` : `<div class="thumb thumb-missing"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M8 7h8M8 11h8M8 15h5"/></svg><span>To follow</span></div>`}
          <div class="info">
            <div class="desc">${escapeHtml(r.vendor || r.description || '(no vendor)')}</div>
            <div class="purpose">${escapeHtml(r.purpose || '')}</div>
            <div class="meta">${escapeHtml(fmtDay(r.date))}${r.unit ? ` · <span class="unit-chip">${escapeHtml(r.unit)}</span>` : ' · <span class="warn">No unit</span>'} · ${escapeHtml(r.category || '')}${n ? ` · 📎${n}` : ''}</div>
          </div>
          <div class="amt">${isForeign(r)
            ? `${audView(r).amount !== '' ? money(audView(r).amount) : '<span class="warn">AUD?</span>'}<div class="gst-line">${escapeHtml(fxLabel(r))}</div>`
            : `${money(r.amount)}${r.gst !== undefined && r.gst !== '' ? `<div class="gst-line">GST ${money(r.gst)}</div>` : ''}`}${isSubmitted ? `<div class="lock">${LOCK_ICON}</div>` : ''}</div>`;
        ul.appendChild(li);
      }
      wrap.appendChild(sec);
    }
    $('emptyState').hidden = shown > 0;
    $('emptyState').querySelector('p').textContent = filter === 'submitted' ? 'No submitted claims yet.' : 'Nothing waiting to be submitted.';
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

  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
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
    $('fxCands').innerHTML = '';
    updateMoney();
    f.querySelectorAll('.filled').forEach(el => el.classList.remove('filled'));
    $('ocrStatus').hidden = true;
    $('ocrAgainBtn').hidden = false;
    f.date.value = editing.date || todayISO();
    setCategory(editing.category || '');
    categoryTouched = !!editing.category;
    setUnit(editing.unit || '');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = editing.image ? URL.createObjectURL(editing.image) : '';
    $('editPreview').hidden = !editing.image;
    if (previewUrl) $('editPreview').src = previewUrl;
    $('noReceipt').hidden = !!editing.image;
    $('deleteBtn').hidden = !!editing.isNew;
    $('recropBtn').hidden = !editing.original;
    renderAttachments();
    await applyLock();
  }

  /** Receipts in a submitted claim are read-only until the claim is reopened. */
  async function applyLock() {
    const month = monthOf(editing);
    editLocked = !editing.isNew && await isLocked(month);
    const f = $('editForm');
    f.querySelectorAll('input, textarea, select').forEach(el => { el.disabled = editLocked; });
    $('addReceiptBtns').hidden = editLocked;
    ['recropBtn', 'deleteBtn', 'saveBtn', 'gstAutoBtn', 'gstNoneBtn', 'attachAdd'].forEach(id => { $(id).hidden = editLocked || (id === 'deleteBtn' && editing.isNew) || (id === 'recropBtn' && !editing.original); });
    $('ocrAgainBtn').hidden = editLocked || !editing.image;
    $('lockBanner').hidden = !editLocked;
    $('lockMsg').textContent = `Locked – part of the submitted ${monthLabel(month)} claim.`;
    $('editCancel').textContent = editLocked ? 'Back' : 'Cancel';
  }
  $('lockReopenBtn').onclick = async () => {
    if (await reopenClaim(monthOf(editing))) await applyLock();
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
      $('fxSource').textContent = aud == null ? '' : audSource === 'bank' ? '· from bank statement' : '· entered';
      $('fxRate').textContent = aud != null && total ? `Rate: 1 ${cur} = ${(aud / total).toFixed(4)} AUD` : `Use the AUD amount on your bank or card statement${settings.statement ? '' : ' (load one in Reconcile to look it up)'}.`;
    }
  }
  $('editForm').currency.addEventListener('change', () => { $('fxCands').innerHTML = ''; updateMoney(); });
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
      if (r.abn) editing.abn = r.abn;
      const f = $('editForm');
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
    'Meals & Entertainment', 'Staff Amenities', 'Parking', 'Fuel', 'Fuel / Mileage',
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
  });

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
    });
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
    if (!editing.unit) return toast('Choose the business unit – Mentis or Macrack.');
    // Saving into a month that has already been submitted reopens that claim.
    const month = monthOf(editing);
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
  $('settingsBtn').onclick = () => { renderSettings(); show('settingsView'); };
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
    const recs = (await db.all()).filter(r => months.has(monthOf(r)));
    if (!recs.length) return toast('No submitted claims to delete.');
    if (!confirm(`Delete ${plural(recs.length, 'receipt')} from ${plural(months.size, 'submitted claim')} on this phone?\n\nMake sure accounts has them – this can’t be undone.`)) return;
    for (const r of recs) await db.del(r.id);
    toast('Submitted claims deleted from this phone');
  };

  /* ---------------- Submitting a monthly claim ---------------- */
  let prepared = null; // { files, subject, body, month, items, total, exceptions, copy }

  async function openSubmit(month, { copy }) {
    const recs = (await db.all()).filter(r => monthOf(r) === month);
    const missing = recs.filter(r => !r.unit || r.amount === '' || r.amount == null || !r.vendor || (isForeign(r) && audView(r).amount === ''));
    if (!copy && missing.length) {
      toast(`${plural(missing.length, 'receipt')} still need${missing.length === 1 ? 's' : ''} a vendor, total, business unit or AUD amount.`, 4500);
      return openEdit(missing[0].id);
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
    $('sendSummary').innerHTML = `${plural(ordered.length, 'receipt')} · <strong>${money(total) || '$0.00'}</strong><br>` +
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
        jpeg: r.image ? new Uint8Array(await r.image.arrayBuffer()) : null,
        attachments: await Promise.all((r.attachments || []).map(async a => ({ ...a, jpeg: new Uint8Array(await a.blob.arrayBuffer()) }))),
      })));
      const pdf = ExpensePdf.buildClaimReport({
        name: settings.name, monthLabel: label, submissionNo, previous, receipts: withBytes, exceptions,
        primary: settings.primary, accent: settings.accent,
      });
      const xlsx = buildClaimSheet({ month, label, ordered, exceptions, submissionNo, previous, total, totalGst });
      const base = `Expense_Claim_${safeFile(who)}_${month}${submissionNo > 1 ? `_resub${submissionNo - 1}` : ''}`;
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

      const subject = `Expense claim – ${who} – ${label}${resubTag}`;
      const lines = unitLines.map(([u, l]) => `${u}: ${plural(l.length, 'receipt')}, ${money(l.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0))}`);
      const exText = submissionNo > 1
        ? `\n\nThis replaces the claim sent ${previous ? previous.date : 'earlier'}${previous ? ` (${money(previous.total)})` : ''}. Changes:\n` +
          (exceptions.length ? exceptions.map(x => `- ${x.type} ${x.ref || ''} ${x.vendor || ''}: ${x.detail}`).join('\n') : '- No line changes')
        : '';
      const body = `Hi,\n\nPlease find attached my expense claim for ${label}${resubTag}.\n\n${lines.join('\n')}\n` +
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
      isForeign(r) ? (r.audSource === 'bank' ? 'Bank statement' : 'Entered') : '',
    ]);
    lines.push(null, ['', '', '', '', { v: 'TOTAL', t: 'bold' }, '', '', '', { v: total - totalGst, t: 'boldMoney' }, { v: totalGst, t: 'boldMoney' }, { v: total, t: 'boldMoney' }, '', '', '', '', '', '']);
    const sheets = [{
      name: 'Claim lines',
      columns: [
        { header: 'Ref', width: 6 }, { header: 'Claim month', width: 15 }, { header: 'Business unit', width: 14 }, { header: 'Date', width: 12, type: 'date' },
        { header: 'Vendor', width: 28 }, { header: 'ABN', width: 16 }, { header: 'Expense type', width: 22 }, { header: 'Purpose', width: 40 },
        { header: 'Ex GST', width: 12, type: 'money' }, { header: 'GST', width: 10, type: 'money' }, { header: 'Total', width: 12, type: 'money' },
        { header: 'Supporting docs', width: 15, type: 'number' }, { header: 'Receipt', width: 11 },
        { header: 'Currency', width: 10 }, { header: 'Foreign total', width: 13, type: 'money' }, { header: 'Rate to AUD', width: 12, type: 'number' }, { header: 'AUD from', width: 15 },
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
    const head = ['Ref', 'Claim month', 'Business unit', 'Date', 'Vendor', 'ABN', 'Expense type', 'Purpose', 'Ex GST (AUD)', 'GST (AUD)', 'Total (AUD)', 'Supporting docs', 'Receipt', 'Currency', 'Foreign total', 'Rate to AUD'];
    const rows = ordered.map(r => [r.ref, label, r.unit || '', r.date ? r.date.split('-').reverse().join('/') : '', r.vendor || '', r.abn || '', r.category || '', r.purpose || '',
      ((parseFloat(r.amount) || 0) - (parseFloat(r.gst) || 0)).toFixed(2), (parseFloat(r.gst) || 0).toFixed(2), (parseFloat(r.amount) || 0).toFixed(2),
      (r.attachments || []).length, r.image ? 'Yes' : 'To follow',
      isForeign(r) ? r.currency : 'AUD', isForeign(r) ? (parseFloat(r.fxAmount) || 0).toFixed(2) : '', isForeign(r) && r.rate ? r.rate.toFixed(4) : '']);
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
    const month = monthOf(rec);
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
    const result = Recon.reconcile(stmt.transactions, recs.map(audView), stmt);
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
    const cl = c => `<div class="rc-line"><span>${escapeHtml(fmtDay(c.date))}</span><span class="rc-desc">${escapeHtml(c.vendor || '')}${c.unit ? ` · ${escapeHtml(c.unit)}` : ''}${isForeign(c) ? ` · ${escapeHtml(fxLabel(c))}` : ''}</span><strong>${c.amount !== '' ? money(c.amount) : 'AUD ?'}</strong></div>`;
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
  migrate().catch(console.error).then(renderList).then(handleShared);
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
