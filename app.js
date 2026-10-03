/* Mentis Expenses – receipt capture app. Everything is stored on the device (IndexedDB + localStorage). */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const MAX_WORK_SIDE = 2400;

  /* ---------------- Storage ---------------- */
  const db = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const req = indexedDB.open('mentis-expenses', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('receipts', { keyPath: 'id' });
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    }));
    const tx = async (mode, fn) => {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction('receipts', mode);
        const r = fn(t.objectStore('receipts'));
        t.oncomplete = () => res(r && r.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      all: () => tx('readonly', s => s.getAll()),
      get: id => tx('readonly', s => s.get(id)),
      put: rec => tx('readwrite', s => s.put(rec)),
      del: id => tx('readwrite', s => s.delete(id)),
    };
  })();

  const SETTINGS_KEY = 'mentis-expenses-settings';
  const defaults = { name: '', emails: [], lastEmail: '', logo: '', primary: '#0b2a4a', accent: '#00a6a6', enhance: true };
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
  const views = ['listView', 'cropView', 'editView', 'settingsView'];
  const titles = { listView: 'Receipts', cropView: 'Crop', editView: 'Details', settingsView: 'Settings' };
  function show(view) {
    views.forEach(v => { $(v).hidden = v !== view; });
    $('viewTitle').textContent = titles[view];
    $('settingsBtn').hidden = view !== 'listView';
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

  /* ---------------- List ---------------- */
  let filter = 'pending';
  let selected = new Set();
  let thumbUrls = [];

  async function renderList() {
    const all = (await db.all()).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.created - a.created);
    const items = all.filter(r => filter === 'all' || (filter === 'sent' ? r.sent : !r.sent));
    selected = new Set([...selected].filter(id => items.some(r => r.id === id)));

    thumbUrls.forEach(URL.revokeObjectURL);
    thumbUrls = [];
    const list = $('receiptList');
    list.innerHTML = '';
    for (const r of items) {
      const url = URL.createObjectURL(r.thumb);
      thumbUrls.push(url);
      const li = document.createElement('li');
      li.className = 'receipt' + (selected.has(r.id) ? ' selected' : '');
      li.dataset.id = r.id;
      li.innerHTML = `
        <button class="check" aria-label="Select">${selected.has(r.id) ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5L20 7"/></svg>' : ''}</button>
        <img class="thumb" src="${url}" alt="">
        <div class="info">
          <div class="desc">${escapeHtml(r.vendor || r.description || '(no description)')}</div>
          <div class="purpose">${escapeHtml([r.vendor ? r.description : '', r.purpose].filter(Boolean).join(' – '))}</div>
          <div class="meta">${escapeHtml(r.date || '')} · ${escapeHtml(r.category || '')}
            ${r.sent ? `<span class="badge" title="${escapeHtml(r.sentTo || '')}">Sent ${escapeHtml((r.sentAt || '').slice(0, 10))}</span>` : ''}</div>
        </div>
        <div class="amt">${money(r.amount)}${r.gst !== undefined && r.gst !== '' ? `<div class="gst-line">GST ${money(r.gst)}</div>` : ''}</div>`;
      list.appendChild(li);
    }
    $('emptyState').hidden = items.length > 0;

    const total = items.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    const label = filter === 'pending' ? 'to send' : filter === 'sent' ? 'sent' : 'total';
    $('summary').innerHTML = items.length
      ? `<span>${items.length} ${label} · <strong>${money(total) || '$0.00'}</strong></span>
         <button class="btn small ghost" id="selectAllInline">${selected.size === items.length ? 'Clear' : 'Select all'}</button>`
      : '';
    const inline = $('selectAllInline');
    if (inline) inline.onclick = () => toggleAll(items);
    $('selectAllBtn').onclick = () => toggleAll(items);
    $('selectAllBtn').textContent = selected.size === items.length ? 'Clear' : 'Select all';
    updateSelectBar();
  }

  function toggleAll(items) {
    if (selected.size === items.length) selected.clear();
    else items.forEach(r => selected.add(r.id));
    renderList();
  }

  function updateSelectBar() {
    const n = selected.size;
    $('selectBar').hidden = n === 0;
    document.body.classList.toggle('selecting', n > 0);
    $('sendBtn').textContent = `Send ${n} receipt${n === 1 ? '' : 's'}`;
  }

  $('receiptList').addEventListener('click', e => {
    const li = e.target.closest('.receipt');
    if (!li) return;
    const id = li.dataset.id;
    if (e.target.closest('.check') || selected.size > 0) {
      selected.has(id) ? selected.delete(id) : selected.add(id);
      renderList();
    } else {
      openEdit(id);
    }
  });

  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    filter = tab.dataset.filter;
    selected.clear();
    renderList();
  }));

  /* ---------------- Capture + crop ---------------- */
  let work = null;      // working canvas (full photo, possibly rotated)
  let quad = null;      // 4 corners in work-canvas pixels
  let editing = null;   // receipt record being created/edited

  async function onPhoto(file) {
    if (!file) return;
    busy(true);
    try {
      const canvas = await fileToCanvas(file);
      editing = { id: uid(), created: Date.now(), date: todayISO(), category: 'Meals & Entertainment', sent: false, isNew: true };
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
    if (editing && editing.image) show('editView'); // re-crop cancelled
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
      Object.assign(editing, { image, thumb, original, quad: quad.map(p => ({ ...p })), w: out.width, h: out.height });
      fillEdit();
      show('editView');
      readReceipt(out, { overwrite: false });
    } catch (err) {
      console.error(err);
      toast('Crop failed – try again.');
    } finally {
      busy(false);
    }
  };

  /* ---------------- Edit ---------------- */
  let previewUrl;
  function fillEdit() {
    const f = $('editForm');
    f.vendor.value = editing.vendor || '';
    f.description.value = editing.description || '';
    f.purpose.value = editing.purpose || '';
    f.amount.value = editing.amount || '';
    f.gst.value = editing.gst || '';
    gstMode = editing.gstMode || 'auto';
    updateMoney();
    f.querySelectorAll('.filled').forEach(el => el.classList.remove('filled'));
    $('ocrStatus').hidden = true;
    $('ocrAgainBtn').hidden = false;
    f.date.value = editing.date || todayISO();
    f.category.value = editing.category || 'Other';
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(editing.image);
    $('editPreview').src = previewUrl;
    $('deleteBtn').hidden = !!editing.isNew;
    $('recropBtn').hidden = !editing.original;
  }

  async function openEdit(id) {
    const rec = await db.get(id);
    if (!rec) return;
    editing = { ...rec, isNew: false };
    fillEdit();
    show('editView');
  }

  /* ----- Total / GST / Ex GST -----
     GST defaults to 1/11 of the total (Australian 10% GST). Typing a GST amount overrides it and
     Ex GST = Total − GST, e.g. Total 11.00 → GST 1.00, Ex 10.00; change GST to 0.50 → Ex 10.50. */
  let gstMode = 'auto'; // 'auto' (1/11 of total) | 'receipt' (read off receipt) | 'manual' (typed)
  const num = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; };
  const fix2 = n => (n == null ? '' : ReceiptOcr.round2(n).toFixed(2));

  function updateMoney() {
    const f = $('editForm');
    const total = num(f.amount.value);
    if (gstMode === 'auto') f.gst.value = total == null ? '' : fix2(ReceiptOcr.gstFromTotal(total));
    const gst = num(f.gst.value) || 0;
    f.exgst.value = total == null ? '' : fix2(total - gst);
    const label = $('gstMode');
    label.textContent = { auto: '· auto 1/11', receipt: '· from receipt', manual: '· edited' }[gstMode];
    label.classList.toggle('manual', gstMode === 'manual');
    $('gstWarn').hidden = !(total != null && gst > total);
  }
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
      const text = await ReceiptOcr.readText(image);
      if (run !== ocrRun || !editing || editing.id !== id || $('editView').hidden) return;
      const r = ReceiptOcr.parseReceipt(text);
      editing.ocrText = text;
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
      put('vendor', r.vendor);
      const totalWasEmpty = !f.amount.value.trim();
      put('amount', r.total != null ? fix2(r.total) : '');
      if (overwrite || (totalWasEmpty && gstMode !== 'manual')) {
        gstMode = r.gstFound ? 'receipt' : 'auto';
        if (r.gstFound) { f.gst.value = fix2(r.gst); f.gst.classList.add('filled'); }
      }
      if (r.date && (overwrite || editing.isNew)) { f.date.value = r.date; f.date.classList.add('filled'); }
      updateMoney();
      status.classList.add('done');
      $('ocrMsg').textContent = filled.length || r.date
        ? 'Filled in from the receipt – please check.'
        : 'Couldn’t read the details – please type them in.';
    } catch (err) {
      console.error(err);
      if (run !== ocrRun) return;
      status.classList.add('error');
      $('ocrMsg').textContent = 'Couldn’t read the receipt (no internet on first use?)';
    } finally {
      if (run === ocrRun) $('ocrAgainBtn').hidden = false;
    }
  }
  $('ocrAgainBtn').onclick = () => { if (editing && editing.image) readReceipt(editing.image, { overwrite: true }); };

  function captureForm() {
    const f = $('editForm');
    Object.assign(editing, {
      vendor: f.vendor.value.trim(),
      description: f.description.value.trim(),
      purpose: f.purpose.value.trim(),
      amount: num(f.amount.value) != null ? fix2(num(f.amount.value)) : '',
      gst: num(f.gst.value) != null ? fix2(num(f.gst.value)) : '',
      gstMode,
      date: f.date.value || editing.date,
      category: f.category.value || editing.category,
    });
  }

  $('recropBtn').onclick = async () => {
    captureForm();
    busy(true);
    try { startCrop(await fileToCanvas(editing.original), editing.quad); }
    finally { busy(false); }
  };

  $('editForm').addEventListener('submit', async e => {
    e.preventDefault();
    captureForm();
    editing.exgst = editing.amount !== '' ? fix2(num(editing.amount) - (num(editing.gst) || 0)) : '';
    if (!editing.vendor && !editing.description) return toast('Add a vendor or what it is.');
    ocrRun++; // ignore any reading still in progress
    const rec = { ...editing };
    delete rec.isNew;
    try {
      await db.put(rec);
    } catch (err) {
      console.error(err);
      return toast('Could not save – phone storage may be full.');
    }
    toast(editing.isNew ? 'Receipt saved' : 'Changes saved');
    editing = null;
    show('listView');
    renderList();
  });
  $('editCancel').onclick = () => { ocrRun++; editing = null; show('listView'); };
  $('deleteBtn').onclick = async () => {
    if (!confirm('Delete this receipt?')) return;
    await db.del(editing.id);
    selected.delete(editing.id);
    editing = null;
    show('listView');
    renderList();
    toast('Receipt deleted');
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
    const sent = (await db.all()).filter(r => r.sent);
    if (!sent.length) return toast('No sent receipts to delete.');
    if (!confirm(`Delete ${sent.length} sent receipt${sent.length === 1 ? '' : 's'} from this phone?`)) return;
    for (const r of sent) await db.del(r.id);
    toast('Sent receipts deleted');
  };

  /* ---------------- Send ---------------- */
  let prepared = null; // { files, subject, body, ids }

  $('sendBtn').onclick = openSend;
  async function openSend() {
    if (!selected.size) return;
    const sel = $('sendTo');
    sel.innerHTML = '';
    for (const em of settings.emails) sel.add(new Option(em, em));
    sel.add(new Option('+ New address…', '__new'));
    sel.value = settings.emails.includes(settings.lastEmail) ? settings.lastEmail : (settings.emails[0] || '__new');
    $('sendToNewWrap').hidden = sel.value !== '__new';
    $('sendToNew').value = '';
    $('sendSheet').hidden = false;
    await prepare();
  }
  $('sendTo').onchange = e => { $('sendToNewWrap').hidden = e.target.value !== '__new'; };
  document.querySelectorAll('input[name=fmt]').forEach(r => r.addEventListener('change', prepare));
  $('sendCancel').onclick = () => { $('sendSheet').hidden = true; };
  $('sendSheet').addEventListener('click', e => { if (e.target === $('sendSheet')) $('sendSheet').hidden = true; });

  // Files are built before the user taps Send, so the share sheet opens instantly
  // (iOS only allows sharing directly inside the tap).
  async function prepare() {
    const go = $('sendGo');
    go.disabled = true; go.textContent = 'Preparing…';
    prepared = null;
    const fmt = document.querySelector('input[name=fmt]:checked').value;
    const recs = (await db.all()).filter(r => selected.has(r.id))
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.created - b.created);
    const total = recs.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    const totalGst = recs.reduce((s, r) => s + (parseFloat(r.gst) || 0), 0);
    const who = settings.name || 'Expenses';
    const stamp = todayISO();
    const safe = s => s.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');

    $('sendSummary').textContent = `${recs.length} receipt${recs.length === 1 ? '' : 's'} · ${money(total) || '$0.00'}`;

    let files;
    if (fmt === 'pdf') {
      const withBytes = await Promise.all(recs.map(async r => ({ ...r, jpeg: new Uint8Array(await r.image.arrayBuffer()) })));
      const pdf = ExpensePdf.buildExpenseReport({ name: settings.name, receipts: withBytes, primary: settings.primary, accent: settings.accent });
      files = [new File([pdf], `${safe(who)}_Expenses_${stamp}.pdf`, { type: 'application/pdf' })];
    } else {
      files = recs.map((r, i) => new File([r.image], `${r.date || stamp}_${i + 1}_${safe(r.vendor || r.description || 'receipt').slice(0, 40)}.jpg`, { type: 'image/jpeg' }));
    }

    const subject = `Expense receipts – ${who} – ${stamp}`;
    const lines = recs.map((r, i) =>
      `${i + 1}. ${r.date || ''}  ${[r.vendor, r.description].filter(Boolean).join(' – ') || '(no description)'}` +
      `${r.amount ? '  –  ' + money(r.amount) + (r.gst !== '' && r.gst != null ? ` (GST ${money(r.gst)})` : '') : ''}\n` +
      `    ${r.category || ''}${r.purpose ? ' · For: ' + r.purpose : ''}`);
    const body = `Hi,\n\nPlease find attached ${recs.length} receipt${recs.length === 1 ? '' : 's'} for reimbursement.\n\n${lines.join('\n')}\n\nTotal: ${money(total) || '$0.00'} (incl. GST ${money(totalGst) || '$0.00'}; ex GST ${money(total - totalGst) || '$0.00'})\n\nThanks,\n${settings.name || ''}`.trim();

    prepared = { files, subject, body, ids: recs.map(r => r.id) };
    const canShareFiles = !!(navigator.canShare && navigator.canShare({ files }));
    $('sendNote').textContent = canShareFiles
      ? 'Your share sheet will open – pick Mail or Outlook. The recipient’s address is copied, so just paste it into “To” if it isn’t filled in.'
      : 'This browser can’t attach files to email directly: the files will download and your email app will open with the message ready – attach the downloaded files.';
    go.disabled = false; go.textContent = 'Send';
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
    const { files, subject, body, ids } = prepared;

    // Copy the address so it can be pasted into the To field (not awaited: keep the tap "live" for share()).
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(to).catch(() => {});

    if (navigator.canShare && navigator.canShare({ files })) {
      try {
        await navigator.share({ files, title: subject, text: body });
        await markSent(ids, to);
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user closed the share sheet
        console.error(err);
        mailtoFallback(to, subject, body, files, ids);
      }
    } else {
      mailtoFallback(to, subject, body, files, ids);
    }
  };

  function mailtoFallback(to, subject, body, files, ids) {
    for (const f of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body + '\n\n(Attachments: ' + files.map(f => f.name).join(', ') + ')')}`;
    setTimeout(() => {
      window.location.href = href;
      setTimeout(async () => {
        if (confirm('Did you send the email? Mark these receipts as sent?')) await markSent(ids, to);
      }, 1500);
    }, 400);
  }

  async function markSent(ids, to) {
    const at = new Date().toISOString();
    for (const id of ids) {
      const r = await db.get(id);
      if (r) await db.put({ ...r, sent: true, sentAt: at, sentTo: to });
    }
    $('sendSheet').hidden = true;
    selected.clear();
    toast(`Marked ${ids.length} as sent to ${to}`);
    renderList();
  }

  /* ---------------- Boot ---------------- */
  applyBrand();
  renderList();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
