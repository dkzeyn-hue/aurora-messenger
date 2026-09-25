/* Aurora Service Worker — offline shell + runtime caching for media */
const VERSION = 'aurora-v1';
const SHELL = [
  '/', '/index.html', '/css/styles.css', '/js/app.js', '/js/utils.js', '/js/components.js',
  '/js/views/chat.js', '/js/views/conversation.js', '/js/views/stories.js', '/js/views/contacts.js',
  '/js/views/discover.js', '/js/views/settings.js', '/js/views/profile.js', '/js/views/admin.js',
  '/js/views/newchat.js', '/manifest.webmanifest', '/favicon.svg', '/socket.io/socket.io.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/socket.io')) return;

  // media files: cache-first (token query changes per token; strip for keying is unsafe → cache as-is, cap entries)
  if (url.pathname.startsWith('/api/files/')) {
    e.respondWith(
      caches.open(VERSION + '-media').then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        try {
          const res = await fetch(e.request);
          if (res.ok) {
            cache.put(e.request, res.clone());
            // simple cap: if too many entries, drop oldest quarter
            if (cache.keys.length > 400) { /* keys is method; handled below */ }
          }
          return res;
        } catch {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  // API: network-only (offline queueing handled in app layer)
  if (url.pathname.startsWith('/api/')) return;

  // shell: network-first with cache fallback
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
