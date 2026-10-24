'use strict';
self.importScripts('/admin-alerts/dedupe.js');
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
const adminWindow = client => {
    const url = new URL(client.url);
    return url.origin === self.location.origin && !/^\/(client|executor-portal|login|security)(\/|$)/.test(url.pathname);
};
const foregroundSound = (client, data) => new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = handled => { clearTimeout(timeout); channel.port1.close(); resolve(handled); };
    const timeout = setTimeout(() => finish(false), 500);
    channel.port1.onmessage = event => finish(event.data?.handled === true);
    try { client.postMessage({ type: 'admin-operation-sound', ...data }, [channel.port2]); }
    catch (_) { finish(false); }
});
self.addEventListener('push', event => {
    event.waitUntil((async () => {
        let data;
        try { data = event.data.json(); } catch (_) { return; }
        if (!data.id || !data.adminId) return;
        const first = await self.adminAlertClaim(`push:${data.adminId}:${data.id}`);
        const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(adminWindow);
        const visible = first && data.kind !== 'test'
            ? (await Promise.all(windows.filter(client => client.visibilityState === 'visible')
                .map(client => foregroundSound(client, data)))).some(Boolean) : false;
        await self.registration.showNotification(data.title || 'تنبيهات الإدارة', {
            body: data.body || 'يوجد تحديث في لوحة الإدارة.', icon: '/images/logo.jpg',
            tag: `admin:${data.adminId}:${data.id}`, renotify: false,
            silent: !first || visible, requireInteraction: data.kind === 'api_pending',
            data: { url: data.url, id: data.id, adminId: data.adminId }
        });
        if (first) windows.forEach(client => client.postMessage({ type: 'admin-operation-push', adminId: data.adminId }));
    })());
});
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil((async () => {
        const target = new URL(event.notification.data?.url || '/transactions/operations', self.location.origin);
        if (target.origin !== self.location.origin || target.pathname !== '/transactions/operations') return;
        const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(adminWindow);
        const existing = windows[0];
        if (existing) { await existing.navigate(target.href); await existing.focus(); }
        else await self.clients.openWindow(target.href);
    })());
});
