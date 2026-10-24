'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { createECDH } = require('crypto');
const { normalizeAdminPushSubscription } = require('../utils/adminPushSubscription');
const source = fs.readFileSync(path.join(__dirname, '../public/admin-alerts/sw.js'), 'utf8');
function worker(windows = []) {
    const handlers = {}, receipts = new Set();
    const self = {
        location: { origin: 'https://test.example' }, importScripts: jest.fn(),
        addEventListener: (name, handler) => { handlers[name] = handler; },
        adminAlertClaim: async id => { if (receipts.has(id)) return false; receipts.add(id); return true; },
        registration: { showNotification: jest.fn().mockResolvedValue(undefined) },
        clients: { matchAll: jest.fn().mockResolvedValue(windows), openWindow: jest.fn() }
    };
    class MessageChannel {
        constructor() {
            this.port1 = { close: jest.fn() };
            this.port2 = { postMessage: data => this.port1.onmessage({ data }) };
        }
    }
    vm.runInNewContext(source, { self, URL, MessageChannel, setTimeout, clearTimeout });
    const push = data => new Promise((resolve, reject) => handlers.push({ data: { json: () => data }, waitUntil: promise => promise.then(resolve, reject) }));
    const click = url => new Promise((resolve, reject) => handlers.notificationclick({
        notification: { close: jest.fn(), data: { url } }, waitUntil: promise => promise.then(resolve, reject)
    }));
    return { self, push, click };
}
test('background push uses a stable tag; retries are silent and do not signal tabs again', async () => {
    const tab = { url: 'https://test.example/transactions', visibilityState: 'hidden', postMessage: jest.fn() };
    const w = worker([tab]); const payload = { id: 'api_pending:abc', kind: 'api_pending', adminId: 'admin1', title: 'Pending' };
    await w.push(payload); await w.push(payload);
    expect(w.self.registration.showNotification.mock.calls[0][1]).toMatchObject({ tag: 'admin:admin1:api_pending:abc', silent: false, requireInteraction: true });
    expect(w.self.registration.showNotification.mock.calls[1][1]).toMatchObject({ tag: 'admin:admin1:api_pending:abc', silent: true });
    expect(tab.postMessage).toHaveBeenCalledTimes(1);
});
test('foreground admin page handles the custom tone without a second operating-system sound', async () => {
    const tab = { url: 'https://test.example/executors', visibilityState: 'visible',
        postMessage: jest.fn((data, ports) => ports?.[0]?.postMessage({ handled: true })) };
    const client = { url: 'https://test.example/client/services', visibilityState: 'visible', postMessage: jest.fn() };
    const w = worker([tab, client]);
    await w.push({ id: 'new_operation:abc', adminId: 'admin1', kind: 'new_operation' });
    expect(w.self.registration.showNotification.mock.calls[0][1].silent).toBe(true);
    expect(tab.postMessage).toHaveBeenCalledTimes(2); expect(client.postMessage).not.toHaveBeenCalled();
});

test('a visible page with unavailable audio falls back to the operating-system sound', async () => {
    const tab = { url: 'https://test.example/executors', visibilityState: 'visible',
        postMessage: jest.fn((data, ports) => ports?.[0]?.postMessage({ handled: false })) };
    const w = worker([tab]);
    await w.push({ id: 'new_operation:fallback', adminId: 'admin1', kind: 'new_operation' });
    expect(w.self.registration.showNotification.mock.calls[0][1].silent).toBe(false);
});
test('notification clicks never navigate outside the operation-review route', async () => {
    const w = worker();
    await w.click('https://evil.example/transactions/operations'); await w.click('/transaction/1/cancel');
    expect(w.self.clients.openWindow).not.toHaveBeenCalled();
    await w.click('/transactions/operations?search=TEST');
    expect(w.self.clients.openWindow).toHaveBeenCalledWith('https://test.example/transactions/operations?search=TEST');
});
test.each(['fcm.googleapis.com', 'jmt17.google.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'wns2.notify.windows.com', 'client.wns.windows.com'])('validates browser subscriptions for %s', host => {
    const curve = createECDH('prime256v1'); curve.generateKeys();
    const subscription = { endpoint: `https://${host}/token`, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };
    expect(normalizeAdminPushSubscription(subscription).endpoint).toBe(subscription.endpoint);
    expect(() => normalizeAdminPushSubscription({ ...subscription, endpoint: `https://${host}.evil.example/token` })).toThrow();
    expect(() => normalizeAdminPushSubscription({ ...subscription, endpoint: 'https://127.0.0.1/token' })).toThrow();
});
