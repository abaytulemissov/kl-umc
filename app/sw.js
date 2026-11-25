// Offline support. Bump VERSION whenever app files change.
const VERSION = 'kl-v0.1.1';
const CORE = [
  './', 'index.html', 'css/style.css', 'js/app.js', 'js/render.js', 'js/parse.js',
  'vendor/pdfmake.min.js', 'manifest.webmanifest', 'icons/icon.svg',
  'fonts/Arimo-Regular.ttf', 'fonts/Arimo-Bold.ttf', 'fonts/Arimo-Italic.ttf', 'fonts/Arimo-BoldItalic.ttf',
  'templates/index.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Network first (to get updates), cache as fallback; everything fetched is cached for offline use.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    // 'no-cache' = always revalidate with the server (GitHub Pages sets max-age=600), so updates arrive immediately
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
