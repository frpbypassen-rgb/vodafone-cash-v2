self.addEventListener('install', (e) => {
    console.log('[Service Worker] تم التثبيت بنجاح');
});

self.addEventListener('fetch', (e) => {
    e.respondWith(fetch(e.request));
});