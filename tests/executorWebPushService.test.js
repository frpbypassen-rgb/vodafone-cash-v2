'use strict';

jest.mock('../models/WebPushSubscription', () => ({
    findOneAndUpdate: jest.fn(),
    updateMany: jest.fn(),
    countDocuments: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    updateOne: jest.fn()
}));
jest.mock('web-push', () => ({
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn()
}));

const { createECDH } = require('node:crypto');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const WebPushSubscription = require('../models/WebPushSubscription');
const webpush = require('web-push');
const service = require('../services/executorWebPushService');

const curve = createECDH('prime256v1');
curve.setPrivateKey(Buffer.alloc(32, 1));
const keys = {
    p256dh: curve.getPublicKey().toString('base64url'),
    auth: Buffer.alloc(16, 2).toString('base64url')
};
const browserSubscription = (endpoint = 'https://fcm.googleapis.com/wp/browser-token') => ({
    endpoint, expirationTime: null, keys: { ...keys }
});
const subscriptionRow = (index, userId = 'employee-1') => {
    const subscription = browserSubscription('https://fcm.googleapis.com/wp/browser-' + index);
    return {
        _id: 'sub-' + userId + '-' + index, userId, accountType: 'executor', active: true,
        endpoint: subscription.endpoint, subscription
    };
};

const mockSubscriptions = (rows) => {
    const queries = [];
    WebPushSubscription.find.mockImplementation((filter) => {
        let limit = Infinity;
        const query = {
            sort: jest.fn().mockReturnThis(),
            limit: jest.fn((value) => { limit = value; return query; }),
            lean: jest.fn(async () => rows.filter((row) => row.userId === filter.userId
                && row.accountType === filter.accountType && row.active === filter.active).slice(0, limit))
        };
        queries.push(query);
        return query;
    });
    return queries;
};

describe('executor web push service', () => {
    const originalEnvironment = { ...process.env };

    beforeEach(() => {
        jest.resetAllMocks();
        process.env.WEB_PUSH_PUBLIC_KEY = 'public-key';
        process.env.WEB_PUSH_PRIVATE_KEY = 'private-key';
        process.env.WEB_PUSH_SUBJECT = 'mailto:test@ahrampay.com';
        WebPushSubscription.countDocuments.mockResolvedValue(0);
        WebPushSubscription.findOneAndUpdate.mockResolvedValue({ _id: 'subscription-1' });
        WebPushSubscription.updateOne.mockResolvedValue({ modifiedCount: 1 });
        webpush.sendNotification.mockResolvedValue({ statusCode: 201 });
        mockSubscriptions([]);
    });

    afterEach(() => jest.restoreAllMocks());

    afterAll(() => { process.env = originalEnvironment; });

    test('normalizes and stores an executor browser subscription', async () => {
        const subscription = browserSubscription();
        await service.upsertExecutorSubscription({ employeeId: 'employee-1', subscription });
        expect(WebPushSubscription.countDocuments).toHaveBeenCalledWith({
            userId: 'employee-1', accountType: 'executor', endpoint: { $ne: subscription.endpoint }
        });
        expect(WebPushSubscription.findOneAndUpdate).toHaveBeenCalledWith(
            { endpoint: subscription.endpoint },
            { $set: { endpoint: subscription.endpoint, userId: 'employee-1', accountType: 'executor',
                active: true, lastError: '', subscription } },
            expect.objectContaining({ upsert: true, returnDocument: 'after', setDefaultsOnInsert: true })
        );
    });

    test.each([
        'https://fcm.googleapis.com/fcm/send/token',
        'https://fcm.googleapis.com/wp/token',
        'https://updates.push.services.mozilla.com/wpush/v1/token',
        'https://updates.push.services.mozilla.com/wpush/v2/token',
        'https://web.push.apple.com/token',
        'https://region.web.push.apple.com/token',
        'https://Fcm.Googleapis.Com:443/wp/token?opaque=one%2Ftwo'
    ])('accepts a production browser push endpoint: %s', (endpoint) => {
        expect(service.normalizeSubscription(browserSubscription(endpoint))).toEqual({
            endpoint: new URL(endpoint).href,
            subscription: browserSubscription(new URL(endpoint).href)
        });
    });

    test.each([
        'https://push.example/subscription',
        'http://fcm.googleapis.com/wp/token',
        'ftp://fcm.googleapis.com/wp/token',
        '//fcm.googleapis.com/wp/token',
        'https://fcm.googleapis.com:80/wp/token',
        'https://fcm.googleapis.com:444/wp/token',
        'https://username:password@fcm.googleapis.com/wp/token',
        'https://@fcm.googleapis.com/wp/token',
        'https://fcm.googleapis.com/wp/token#fragment',
        'https://fcm.googleapis.com/wp/token#',
        'https://localhost/push',
        'https://127.0.0.1/push',
        'https://2130706433/push',
        'https://0x7f000001/push',
        'https://10.0.0.1/push',
        'https://172.16.0.1/push',
        'https://192.168.0.1/push',
        'https://169.254.169.254/latest/meta-data',
        'https://[::1]/push',
        'https://[::ffff:127.0.0.1]/push',
        'https://fcm.googleapis.com.attacker.example/push',
        'https://attacker-fcm.googleapis.com/push',
        'https://attacker.push.services.mozilla.com/push',
        'https://updates-autopush.dev.mozaws.net/push',
        'https://push.apple.com.attacker.example/push',
        'https://attacker-push.apple.com/push',
        'https://web..push.apple.com/push',
        'https://web_.push.apple.com/push',
        'https://web.push.apple.com./push',
        'https://fcm.googleapis.com./push',
        'https://fcm.googleapis.com@127.0.0.1/push',
        'https://fcm.googleapis.com\\@127.0.0.1/push',
        'https://fcm.googleapis.com%2e.attacker.example/push',
        'https://fcm.googleapis.com\n.attacker.example/push',
        'https://fcm.googleapis.com/wp/' + 'a'.repeat(4096),
        'not a URL',
        null,
        { toString: () => 'https://fcm.googleapis.com/wp/token' }
    ])('rejects unsafe endpoints before storage or delivery: %s', async (endpoint) => {
        await expect(service.upsertExecutorSubscription({ employeeId: 'employee-1',
            subscription: browserSubscription(endpoint) })).rejects.toMatchObject({
            message: 'INVALID_WEB_PUSH_SUBSCRIPTION', code: 'INVALID_WEB_PUSH_SUBSCRIPTION'
        });
        expect(WebPushSubscription.countDocuments).not.toHaveBeenCalled();
        expect(WebPushSubscription.findOneAndUpdate).not.toHaveBeenCalled();
        expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    test.each([null, {}, { endpoint: 'https://fcm.googleapis.com/wp/token' },
        { ...browserSubscription(), keys: { p256dh: keys.p256dh } }])
    ('rejects incomplete subscriptions', (subscription) => {
        expect(() => service.normalizeSubscription(subscription)).toThrow('INVALID_WEB_PUSH_SUBSCRIPTION');
    });

    test('accepts canonical padded base64url and stores unpadded keys', () => {
        const subscription = browserSubscription();
        subscription.keys = { p256dh: keys.p256dh + '=', auth: keys.auth + '==' };
        expect(service.normalizeSubscription(subscription).subscription.keys).toEqual(keys);
    });

    test.each([
        ['p256dh', ''], ['auth', ''], ['p256dh', 123], ['auth', {}],
        ['p256dh', Buffer.alloc(64).toString('base64url')],
        ['p256dh', Buffer.alloc(66).toString('base64url')],
        ['auth', Buffer.alloc(15).toString('base64url')],
        ['auth', Buffer.alloc(17).toString('base64url')],
        ['p256dh', 'a'.repeat(100000)], ['auth', 'a'.repeat(100000)],
        ['p256dh', keys.p256dh + '=='], ['auth', keys.auth + '='],
        ['p256dh', keys.p256dh.slice(0, -1) + '!'],
        ['auth', keys.auth.slice(0, -1) + '/'],
        ['auth', keys.auth.slice(0, -1) + '+'],
        ['auth', keys.auth.slice(0, -1) + 'J'],
        ['p256dh', ' ' + keys.p256dh], ['auth', keys.auth + '\n'],
        ['p256dh', Buffer.alloc(65, 4).toString('base64url')],
        ['p256dh', curve.getPublicKey(undefined, 'compressed').toString('base64url')]
    ])('rejects invalid %s keys', (name, value) => {
        const subscription = browserSubscription();
        subscription.keys[name] = value;
        expect(() => service.normalizeSubscription(subscription)).toThrow('INVALID_WEB_PUSH_SUBSCRIPTION');
    });

    test('rejects an uncompressed off-curve P-256 point', () => {
        const point = Buffer.alloc(65);
        point[0] = 4;
        const subscription = browserSubscription();
        subscription.keys.p256dh = point.toString('base64url');
        expect(() => service.normalizeSubscription(subscription)).toThrow('INVALID_WEB_PUSH_SUBSCRIPTION');
    });

    test('rejects a new subscription at the account cap without upserting', async () => {
        WebPushSubscription.countDocuments.mockResolvedValue(10);
        WebPushSubscription.findOneAndUpdate.mockResolvedValue(null);
        await expect(service.upsertExecutorSubscription({ employeeId: 'employee-1',
            subscription: browserSubscription() })).rejects.toMatchObject({ code: 'WEB_PUSH_SUBSCRIPTION_LIMIT' });
        expect(WebPushSubscription.findOneAndUpdate).toHaveBeenCalledWith(
            { userId: 'employee-1', accountType: 'executor', active: false },
            expect.any(Object), { sort: { updatedAt: 1, _id: 1 }, returnDocument: 'after' }
        );
        expect(WebPushSubscription.findOneAndUpdate.mock.calls.every((call) => !call[2].upsert)).toBe(true);
    });

    test('allows refreshing a known endpoint at the cap', async () => {
        WebPushSubscription.countDocuments.mockResolvedValue(9);
        await expect(service.upsertExecutorSubscription({ employeeId: 'employee-1',
            subscription: browserSubscription() })).resolves.toEqual({ _id: 'subscription-1' });
        expect(WebPushSubscription.findOneAndUpdate.mock.calls[0][2].upsert).toBe(true);
    });

    test('recycles an inactive account slot instead of accumulating expired rows', async () => {
        WebPushSubscription.countDocuments.mockResolvedValue(10);
        WebPushSubscription.findOneAndUpdate.mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ _id: 'expired-slot', active: true });
        const result = await service.upsertExecutorSubscription({ employeeId: 'employee-1',
            subscription: browserSubscription() });
        expect(result._id).toBe('expired-slot');
        expect(WebPushSubscription.findOneAndUpdate).toHaveBeenCalledTimes(2);
        expect(WebPushSubscription.findOneAndUpdate.mock.calls[1][1].$set.endpoint)
            .toBe(browserSubscription().endpoint);
        expect(WebPushSubscription.findOneAndUpdate.mock.calls[1][1].$set.lastSuccessAt).toBeNull();
    });

    test('renews a legacy subscription above the cap without adding rows or recycling a different slot', async () => {
        WebPushSubscription.countDocuments.mockResolvedValue(15);
        await service.upsertExecutorSubscription({ employeeId: 'employee-1', subscription: browserSubscription() });
        expect(WebPushSubscription.findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(WebPushSubscription.findOneAndUpdate.mock.calls[0][0]).toEqual({
            userId: 'employee-1', accountType: 'executor', endpoint: browserSubscription().endpoint
        });
        expect(WebPushSubscription.findOneAndUpdate.mock.calls[0][2].upsert).toBeUndefined();
    });

    test('serializes concurrent account registrations at the cap', async () => {
        let count = 9;
        WebPushSubscription.countDocuments.mockImplementation(async () => count);
        WebPushSubscription.findOneAndUpdate.mockImplementation(async (_filter, _update, options) => {
            if (!options.upsert) return null;
            count += 1;
            return { _id: 'last-slot' };
        });
        const results = await Promise.allSettled([1, 2].map((index) => service.upsertExecutorSubscription({
            employeeId: 'employee-1', subscription: browserSubscription('https://fcm.googleapis.com/wp/' + index)
        })));
        expect(count).toBe(10);
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
        expect(results[1].reason.code).toBe('WEB_PUSH_SUBSCRIPTION_LIMIT');
    });

    test('a failed registration does not block the next account registration', async () => {
        WebPushSubscription.countDocuments.mockRejectedValueOnce(new Error('database unavailable'));
        const results = await Promise.allSettled([1, 2].map((index) => service.upsertExecutorSubscription({
            employeeId: 'employee-1', subscription: browserSubscription('https://fcm.googleapis.com/wp/' + index)
        })));
        expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    });

    test('sends only to selected employees and preserves payload and TTL options', async () => {
        const row = subscriptionRow(1);
        mockSubscriptions([row, subscriptionRow(2, 'foreign-employee'), { ...subscriptionRow(3), active: false }]);
        const result = await service.sendExecutorWebPush({
            employeeIds: ['employee-1', 'employee-1'], title: 'New task', body: 'Task ready',
            category: 'executor_task_new', collapseKey: 'one-task', ttl: 240, urgency: 'normal',
            data: { url: '/executor-portal/dashboard', taskId: 'task-1' }
        });
        expect(WebPushSubscription.find).toHaveBeenCalledTimes(1);
        expect(WebPushSubscription.find).toHaveBeenCalledWith({
            accountType: 'executor', userId: 'employee-1', active: true
        });
        expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
        expect(webpush.sendNotification).toHaveBeenCalledWith(row.subscription, expect.any(String), {
            TTL: 240, urgency: 'normal', timeout: 10000
        });
        expect(JSON.parse(webpush.sendNotification.mock.calls[0][1])).toEqual({
            title: 'New task', message: 'Task ready', tag: 'one-task', data: {
                url: '/executor-portal/dashboard', taskId: 'task-1', category: 'executor_task_new', collapseKey: 'one-task'
            }
        });
        expect(result).toEqual({ configured: true, attempted: 1, sent: 1, failed: 0 });
        expect(WebPushSubscription.updateOne.mock.calls[0][0]).toEqual({
            _id: row._id, userId: 'employee-1', accountType: 'executor', endpoint: row.endpoint, active: true
        });
        expect(WebPushSubscription.updateOne.mock.calls[0][1].$set).not.toHaveProperty('active');
    });

    test.each([
        ['unsafe legacy endpoint', (row) => {
            row.subscription.endpoint = row.endpoint = 'https://127.0.0.1/private';
        }],
        ['invalid legacy keys', (row) => { row.subscription.keys.auth = 'not-a-key'; }],
        ['off-curve legacy keys', (row) => {
            row.subscription.keys.p256dh = Buffer.alloc(65, 4).toString('base64url');
        }],
        ['mismatched stored endpoint', (row) => { row.endpoint = 'https://fcm.googleapis.com/wp/different'; }],
        ['unsafe stored metadata', (row) => { row.endpoint = 'https://localhost/private'; }]
    ])('quarantines %s without using it for network delivery', async (_name, corrupt) => {
        const invalid = subscriptionRow(1);
        corrupt(invalid);
        mockSubscriptions([invalid, subscriptionRow(2)]);
        const result = await service.sendExecutorWebPush({ employeeIds: ['employee-1'] });
        expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
        expect(webpush.sendNotification.mock.calls[0][0].endpoint).toBe(subscriptionRow(2).endpoint);
        expect(WebPushSubscription.updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: invalid._id }), {
            $set: { active: false, lastError: 'INVALID_WEB_PUSH_SUBSCRIPTION' }
        });
        expect(result).toEqual({ configured: true, attempted: 2, sent: 1, failed: 1 });
    });

    test.each([404, 410, 500, undefined])('stores a generic delivery error for status %s', async (statusCode) => {
        mockSubscriptions([subscriptionRow(1)]);
        webpush.sendNotification.mockRejectedValue(Object.assign(
            new Error('secret token https://internal.example/private-key'), { statusCode }
        ));
        const result = await service.sendExecutorWebPush({ employeeIds: ['employee-1'] });
        const expired = [404, 410].includes(statusCode);
        expect(WebPushSubscription.updateOne.mock.calls[0][1]).toEqual({ $set: {
            ...(expired ? { active: false } : {}),
            lastError: expired ? 'WEB_PUSH_SUBSCRIPTION_EXPIRED' : 'WEB_PUSH_FAILED'
        } });
        expect(JSON.stringify(WebPushSubscription.updateOne.mock.calls)).not.toContain('secret');
        expect(result).toEqual({ configured: true, attempted: 1, sent: 0, failed: 1 });
    });

    test('sanitizes previously stored provider errors when returning subscription status', async () => {
        WebPushSubscription.countDocuments.mockResolvedValue(1);
        const query = { sort: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue({ lastError: 'https://private.example/token secret' }) };
        WebPushSubscription.findOne.mockReturnValue(query);
        const status = await service.getExecutorWebPushStatus('employee-1');
        expect(status.lastError).toBe('WEB_PUSH_FAILED');
        expect(status.subscribed).toBe(true);
    });

    test('bounds queries and sends independently for excessive legacy subscriptions', async () => {
        const queries = mockSubscriptions(['employee-1', 'employee-2'].flatMap((id) =>
            Array.from({ length: 15 }, (_value, index) => subscriptionRow(index, id))));
        const result = await service.sendExecutorWebPush({ employeeIds: ['employee-1', 'employee-2'] });
        expect(result).toEqual({ configured: true, attempted: 20, sent: 20, failed: 0 });
        expect(queries).toHaveLength(2);
        for (const query of queries) {
            expect(query.sort).toHaveBeenCalledWith({ updatedAt: -1, _id: -1 });
            expect(query.limit).toHaveBeenCalledWith(10);
        }
    });

    test('bounds in-flight sends across simultaneous notification calls', async () => {
        const ids = ['employee-1', 'employee-2', 'employee-3'];
        mockSubscriptions(ids.flatMap((id) => Array.from({ length: 10 }, (_value, index) => subscriptionRow(index, id))));
        let inFlight = 0;
        let maximum = 0;
        webpush.sendNotification.mockImplementation(() => new Promise((resolve) => {
            inFlight += 1;
            maximum = Math.max(maximum, inFlight);
            setImmediate(() => { inFlight -= 1; resolve({ statusCode: 201 }); });
        }));
        const results = await Promise.all(ids.map((id) => service.sendExecutorWebPush({ employeeIds: [id] })));
        expect(maximum).toBe(4);
        expect(inFlight).toBe(0);
        expect(results.every((result) => result.sent === 10)).toBe(true);
    });

    test('releases send slots after rejection so later batches can complete', async () => {
        mockSubscriptions(Array.from({ length: 10 }, (_value, index) => subscriptionRow(index)));
        webpush.sendNotification.mockRejectedValueOnce(new Error('Socket timeout'));
        const result = await service.sendExecutorWebPush({ employeeIds: ['employee-1'], ttl: 1 });
        expect(result).toEqual({ configured: true, attempted: 10, sent: 9, failed: 1 });
        expect(webpush.sendNotification.mock.calls.every((call) => call[2].TTL === 60 && call[2].timeout === 10000))
            .toBe(true);
    });

    test('does not query subscriptions when unconfigured or without employees', async () => {
        expect(await service.sendExecutorWebPush({ employeeIds: [] }))
            .toEqual({ configured: true, attempted: 0, sent: 0, failed: 0 });
        delete process.env.WEB_PUSH_PRIVATE_KEY;
        expect(await service.sendExecutorWebPushTest('employee-1'))
            .toEqual({ configured: false, attempted: 0, sent: 0, failed: 0 });
        expect(WebPushSubscription.find).not.toHaveBeenCalled();
        expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    test('does not initialize VAPID when there are no subscriptions or only unsafe legacy rows', async () => {
        expect(await service.sendExecutorWebPush({ employeeIds: ['employee-1'] }))
            .toEqual({ configured: true, attempted: 0, sent: 0, failed: 0 });
        const row = subscriptionRow(1);
        row.endpoint = row.subscription.endpoint = 'https://localhost/private';
        mockSubscriptions([row]);
        expect(await service.sendExecutorWebPush({ employeeIds: ['employee-1'] }))
            .toEqual({ configured: true, attempted: 1, sent: 0, failed: 1 });
        expect(webpush.setVapidDetails).not.toHaveBeenCalled();
        expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    test.each(['success', 'failure'])('an in-flight %s never reactivates a disabled subscription', async (outcome) => {
        const row = subscriptionRow(1);
        mockSubscriptions([row]);
        webpush.sendNotification.mockImplementation(async () => {
            row.active = false;
            if (outcome === 'failure') throw new Error('Socket timeout');
            return { statusCode: 201 };
        });
        WebPushSubscription.updateOne.mockImplementation(async (filter, update) => {
            if (row.active === filter.active) Object.assign(row, update.$set);
            return { modifiedCount: 0 };
        });
        await service.sendExecutorWebPush({ employeeIds: ['employee-1'] });
        expect(row.active).toBe(false);
        expect(WebPushSubscription.updateOne.mock.calls[0][0].active).toBe(true);
        expect(WebPushSubscription.updateOne.mock.calls[0][1].$set).not.toHaveProperty('active');
    });

    test('a late expired response cannot disable a recycled slot for a new browser', async () => {
        const row = subscriptionRow(1);
        mockSubscriptions([row]);
        webpush.sendNotification.mockImplementation(async () => {
            row.endpoint = 'https://fcm.googleapis.com/wp/new-browser';
            row.subscription = browserSubscription(row.endpoint);
            throw Object.assign(new Error('Gone'), { statusCode: 410 });
        });
        WebPushSubscription.updateOne.mockImplementation(async (filter, update) => {
            if (filter.endpoint === row.endpoint) Object.assign(row, update.$set);
            return { modifiedCount: 0 };
        });
        await service.sendExecutorWebPush({ employeeIds: ['employee-1'] });
        expect(row.active).toBe(true);
        expect(WebPushSubscription.updateOne.mock.calls[0][0].endpoint)
            .toBe('https://fcm.googleapis.com/wp/browser-1');
    });

    test('keeps the test notification and unsubscribe API signatures', async () => {
        mockSubscriptions([subscriptionRow(1)]);
        await service.sendExecutorWebPushTest('employee-1');
        expect(JSON.parse(webpush.sendNotification.mock.calls[0][1]).data.url).toBe('/executor-portal/settings');
        WebPushSubscription.updateMany.mockResolvedValue({ modifiedCount: 2 });
        expect(await service.disableExecutorSubscription({ employeeId: 'employee-1' })).toBe(2);
        expect(WebPushSubscription.updateMany).toHaveBeenCalledWith(
            { userId: 'employee-1', accountType: 'executor' }, { $set: { active: false } }
        );
    });

    test('unsubscribes both canonical and legacy spellings of a lawful endpoint', async () => {
        WebPushSubscription.updateMany.mockResolvedValue({ modifiedCount: 1 });
        await service.disableExecutorSubscription({ employeeId: 'employee-1',
            endpoint: 'https://Fcm.Googleapis.Com:443/wp/token' });
        expect(WebPushSubscription.updateMany).toHaveBeenCalledWith({
            userId: 'employee-1', accountType: 'executor', endpoint: { $in: [
                'https://Fcm.Googleapis.Com:443/wp/token', 'https://fcm.googleapis.com/wp/token'
            ] }
        }, { $set: { active: false } });
        expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    test('allows removing an unsafe legacy endpoint without attempting delivery', async () => {
        WebPushSubscription.updateMany.mockResolvedValue({ modifiedCount: 1 });
        await service.disableExecutorSubscription({ employeeId: 'employee-1', endpoint: 'https://localhost/private' });
        expect(WebPushSubscription.updateMany).toHaveBeenCalledWith({
            userId: 'employee-1', accountType: 'executor', endpoint: 'https://localhost/private'
        }, { $set: { active: false } });
        expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    test('the installed web-push library encrypts valid subscriptions without external networking', () => {
        const actual = jest.requireActual('web-push');
        const vapid = actual.generateVAPIDKeys();
        const requestDetails = actual.generateRequestDetails(service.normalizeSubscription(browserSubscription()).subscription,
            'test payload', { timeout: 10000, TTL: 180, urgency: 'high', vapidDetails: {
                subject: 'mailto:test@ahrampay.com', publicKey: vapid.publicKey, privateKey: vapid.privateKey
            } });
        expect(requestDetails.endpoint).toBe(browserSubscription().endpoint);
        expect(requestDetails.timeout).toBe(10000);
        expect(requestDetails.headers['Content-Encoding']).toBe('aes128gcm');
        expect(Buffer.isBuffer(requestDetails.body)).toBe(true);
    });

    test.each(['timeout', 'redirect'])('the installed library handles %s without reaching another URL', async (behavior) => {
        const actual = jest.requireActual('web-push');
        const vapid = actual.generateVAPIDKeys();
        const request = new EventEmitter();
        request.write = jest.fn();
        request.destroy = jest.fn((error) => request.emit('error', error));
        const response = new EventEmitter();
        response.statusCode = 302;
        response.headers = { location: 'https://127.0.0.1/private' };
        const requestSpy = jest.spyOn(https, 'request').mockImplementation((_options, callback) => {
            request.end = jest.fn(() => process.nextTick(() => {
                if (behavior === 'timeout') request.emit('timeout');
                else { callback(response); response.emit('end'); }
            }));
            return request;
        });
        await expect(actual.sendNotification(browserSubscription(), 'test payload', {
            timeout: 10000, vapidDetails: {
                subject: 'mailto:test@ahrampay.com', publicKey: vapid.publicKey, privateKey: vapid.privateKey
            }
        })).rejects.toMatchObject(behavior === 'timeout' ? { message: 'Socket timeout' } : { statusCode: 302 });
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy.mock.calls[0][0]).toMatchObject({ hostname: 'fcm.googleapis.com', timeout: 10000 });
        if (behavior === 'timeout') expect(request.destroy).toHaveBeenCalledTimes(1);
    });
});
