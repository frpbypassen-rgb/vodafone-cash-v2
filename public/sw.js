self.addEventListener('install', (event) => {
    // Skip waiting to immediately install
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // Claim clients to immediately control them
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Empty fetch listener to satisfy PWA install requirements.
    // By not calling event.respondWith, we let the browser handle the request natively.
    // This fixes issues where the Service Worker aggressively caches pages.
});
