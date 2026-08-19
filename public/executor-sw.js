'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const notificationOptions = (payload = {}) => {
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    return {
        body: payload.message || payload.body || 'يوجد تحديث جديد في بوابة التنفيذ.',
        icon: '/images/logo.jpg',
        badge: '/images/logo.jpg',
        tag: payload.tag || data.collapseKey || `executor-${Date.now()}`,
        renotify: true,
        requireInteraction: data.priority === 'urgent' || data.category === 'executor_urgent_alert',
        vibrate: data.priority === 'urgent' ? [350, 180, 350, 180, 600] : [180, 80, 180],
        data: {
            url: data.url || data.route || '/executor-portal/dashboard',
            transactionId: data.transactionId || '',
            category: data.category || ''
        }
    };
};

self.addEventListener('push', (event) => {
    let payload = {};
    try { payload = event.data?.json() || {}; }
    catch (_) { payload = { message: event.data?.text() || '' }; }
    event.waitUntil(self.registration.showNotification(
        payload.title || 'Ahram Pay - بوابة التنفيذ',
        notificationOptions(payload)
    ));
});

self.addEventListener('message', (event) => {
    const payload = event.data || {};
    if (payload.type !== 'executor-notification-preview') return;
    event.waitUntil(self.registration.showNotification(
        payload.title || 'اختبار إشعارات التنفيذ',
        notificationOptions(payload)
    ));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification.data?.url || '/executor-portal/dashboard';
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
