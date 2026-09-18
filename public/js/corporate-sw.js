/* Corporate portal offline shell — last balance and recent ops stay in localStorage. */
const CACHE_NAME = 'corporate-portal-v1';
const SHELL = [
    '/css/corporate-mobile.css',
    '/js/corporate-mobile.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).catch(() => {}));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (!url.pathname.startsWith('/corporate') && !url.pathname.startsWith('/css/corporate') && !url.pathname.startsWith('/js/corporate')) {
        return;
    }
    if (event.request.method !== 'GET') return;
    event.respondWith(
        fetch(event.request).catch(async () => {
            const cached = await caches.match(event.request);
            return cached || new Response('offline', { status: 503, statusText: 'Offline' });
        })
    );
});
