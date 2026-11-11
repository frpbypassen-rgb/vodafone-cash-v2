'use strict';
process.env.SESSION_SECRET ||= 'isolated-device-review-secret-at-least-32-characters';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Device = require('../models/SecurityDevice');
const AccessRequest = require('../models/SecurityAccessRequest');
const State = require('../models/SecurityState');
const service = require('../services/securityControlService');
let replica;
jest.setTimeout(60000);
beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri());
    await Promise.all([Device.init(), AccessRequest.init(), State.init()]);
    await State.create({ key: 'global', adminApprovalRequired: false });
    await service.getState({ fresh: true });
});
afterAll(async () => {
    jest.restoreAllMocks();
    await mongoose.disconnect();
    await replica?.stop();
});
test('a rejected device request cannot be approved from an earlier pending read', async () => {
    const principal = { principalType: 'client_user', principalId: String(new mongoose.Types.ObjectId()), principalName: 'Test account' };
    const existingHash = service.hashDeviceId('existing-audit-device');
    const existing = await Device.create({ ...principal, channel: 'app', deviceIdHash: existingHash, status: 'active' });
    const pending = await AccessRequest.create({
        ...principal, requestCode: 'SEC-AUDIT-ATOMIC', channel: 'app', deviceIdHash: service.hashDeviceId('new-audit-device'),
        expiresAt: new Date(Date.now() + 60000)
    });
    let release, read;
    const gate = new Promise(resolve => { release = resolve; });
    const loaded = new Promise(resolve => { read = resolve; });
    const original = AccessRequest.findOne.bind(AccessRequest);
    jest.spyOn(AccessRequest, 'findOne').mockImplementationOnce((...args) => {
        const query = original(...args);
        const select = query.select.bind(query);
        query.select = async (...fields) => {
            const result = await select(...fields);
            read();
            await gate;
            return result;
        };
        return query;
    });
    const request = { principal, requestId: pending._id, reviewedBy: 'test-owner',
        req: { headers: { 'x-device-id': 'existing-audit-device' }, originalUrl: '/api/mobile/client/security' } };
    const approval = service.reviewPrincipalAccessRequest({ ...request, approve: true }).then(
        () => ({ approved: true }), error => ({ code: error.code })
    );
    await loaded;
    try {
        await service.reviewPrincipalAccessRequest({ ...request, approve: false });
    } finally { release(); }
    expect(await approval).toEqual({ code: 'SECURITY_ACCESS_REQUEST_NOT_FOUND' });
    expect((await AccessRequest.findById(pending._id)).status).toBe('rejected');
    expect((await Device.findById(existing._id).select('+deviceIdHash')).deviceIdHash).toBe(existingHash);
    expect(await Device.countDocuments({ status: 'active', principalId: principal.principalId })).toBe(1);
});
test('successful owner approval returns the committed approved state', async () => {
    const principal = { principalType: 'client_user', principalId: String(new mongoose.Types.ObjectId()), principalName: 'Second test account' };
    await Device.create({ ...principal, channel: 'app', deviceIdHash: service.hashDeviceId('trusted-second-device'), status: 'active' });
    const pending = await AccessRequest.create({
        ...principal, requestCode: 'SEC-AUDIT-SUCCESS', channel: 'web', deviceIdHash: service.hashDeviceId('approved-web-device'),
        expiresAt: new Date(Date.now() + 60000)
    });
    const result = await service.reviewPrincipalAccessRequest({
        principal, requestId: pending._id, approve: true, reviewedBy: 'test-owner',
        req: { headers: { 'x-device-id': 'trusted-second-device' }, originalUrl: '/api/mobile/client/security' }
    });
    expect(result.request.status).toBe('approved');
    expect((await AccessRequest.findById(pending._id)).status).toBe('approved');
});
