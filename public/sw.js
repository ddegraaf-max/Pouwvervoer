// Service worker voor de installeerbare app: vaste bestanden uit de cache, pagina's altijd vers van de server,
// en een nette melding als er geen verbinding is. Formulieren, de API en de backoffice worden nooit gecachet.
const VERSIE = 'pouw-v1';
const VASTE_BESTANDEN = ['/style.css', '/app.js', '/reis.js', '/kaart.js', '/logo.png', '/bus.jpg', '/offline.html', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSIE).then((c) => c.addAll(VASTE_BESTANDEN)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSIE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin') || url.pathname.startsWith('/deurwaarder') || url.pathname.startsWith('/rit/')) return;

  // Vaste bestanden: eerst de cache, dan het netwerk (en de cache bijwerken).
  if (/\.(css|js|mjs|png|jpg|svg|webmanifest|pdf)$/.test(url.pathname) || url.pathname.startsWith('/vendor/')) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const vers = fetch(req).then((res) => {
          if (res.ok) caches.open(VERSIE).then((c) => c.put(req, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || vers;
      }),
    );
    return;
  }

  // Pagina's: altijd het netwerk; zonder verbinding de offline-pagina.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
  }
});
