// Offline cache for the app shell. Bump VERSION when files change.
const VERSION = 'mentis-expenses-v11';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'crop.js', 'docimport.js', 'ocr.js', 'pdf.js', 'xlsx.js', 'recon.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Things shared to the app from other apps (Android share menu): keep the files and text in a
// cache the page can read, then open the app to process them.
async function receiveShare(request) {
  const form = await request.formData();
  const cache = await caches.open('share-inbox');
  const files = form.getAll('files').filter(f => f && typeof f !== 'string');
  await Promise.all(files.map((f, i) => cache.put(`share-file-${i}`, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }))));
  const meta = { title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', files: files.map(f => ({ name: f.name, type: f.type })) };
  await cache.put('share-meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  return Response.redirect('./index.html?shared=1', 303);
}

// Network first (so updates arrive), falling back to cache when offline.
self.addEventListener('fetch', e => {
  if (e.request.method === 'POST' && new URL(e.request.url).pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;
  e.respondWith(
    // Same-origin: skip the browser's HTTP cache so a new version shows up immediately.
    (sameOrigin ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(e.request))
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
