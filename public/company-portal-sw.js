'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const notificationOptions = (payload = {}) => {
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    return {
        body: payload.message || payload.body || 'يوجد تحديث جديد في بوابة الشركات.',
        icon: '/images/logo.jpg',
        badge: '/images/logo.jpg',
        tag: payload.tag || data.collapseKey || `company-${Date.now()}`,
        renotify: true,
        data: {
            url: data.url || data.route || '/client/services',
            category: data.category || ''
        }
    };
};

self.addEventListener('push', (event) => {
    let payload = {};
    try { payload = event.data?.json() || {}; }
    catch (_) { payload = { message: event.data?.text() || '' }; }
    event.waitUntil(self.registration.showNotification(
        payload.title || 'الأهرام باي - بوابة الشركات',
        notificationOptions(payload)
    ));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification.data?.url || '/client/services';
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
        if (existing) {
            await existing.focus();
            if ('navigate' in existing) await existing.navigate(targetUrl);
            return;
        }
        await self.clients.openWindow(targetUrl);
    })());
});
