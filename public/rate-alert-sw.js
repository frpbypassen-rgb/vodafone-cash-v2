'use strict';

// Registers a dedicated worker for future Web Push delivery. Browser Push
// subscriptions are intentionally isolated from transaction notifications.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
    const payload = event.data || {};
    if (payload.type !== 'rate-alert') return;
    event.waitUntil(self.registration.showNotification(payload.title || 'تحديث أسعار الصرف', {
        body: payload.message || 'سيتم تطبيق سعر جديد قريباً.',
        icon: '/images/logo.png',
        tag: payload.tag || 'rate-alert',
        renotify: true
    }));
});

self.addEventListener('push', (event) => {
    let payload = {};
    try { payload = event.data?.json() || {}; } catch (_) { payload = { message: event.data?.text() || '' }; }
    event.waitUntil(self.registration.showNotification(payload.title || 'تحديث أسعار الصرف', {
        body: payload.message || 'سيتم تطبيق سعر جديد قريباً.',
        icon: '/images/logo.png',
        tag: payload.tag || 'rate-alert',
        renotify: true,
        data: { url: '/client/dashboard?tab=rates' }
    }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(self.clients.openWindow(event.notification.data?.url || '/client/dashboard'));
});
