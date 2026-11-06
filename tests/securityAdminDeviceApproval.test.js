'use strict';

jest.mock('../middlewares/auth', () => ({
    requireAuth: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
}));
jest.mock('../services/auditService', () => ({ logAction: jest.fn() }));

const express = require('express');
const request = require('supertest');
const SecurityAccessRequest = require('../models/SecurityAccessRequest');
const mongoose = require('mongoose');
const SecurityDevice = require('../models/SecurityDevice');
const MobileDeviceSession = require('../models/MobileDeviceSession');
const securityAdmin = require('../routes/securityAdmin');

afterEach(() => jest.restoreAllMocks());

test('administrative app approval revokes only the existing app binding', async () => {
    const accessRequest = {
        _id: 'request-1',
        principalType: 'executor',
        principalId: 'executor-1',
        channel: 'app',
        deviceIdHash: 'new-app-hash',
        platformApprovalOnly: true,
        location: {}
    };
    jest.spyOn(SecurityAccessRequest, 'findOne').mockReturnValue({
        select: jest.fn().mockResolvedValue(accessRequest)
    });
    const session = { withTransaction: jest.fn(callback => callback()), endSession: jest.fn() };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    const claim = jest.spyOn(SecurityAccessRequest, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
    const revoke = jest.spyOn(MobileDeviceSession, 'updateMany').mockResolvedValue({});
    const replace = jest.spyOn(SecurityDevice, 'findOneAndReplace').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({ _id: 'old-app', channel: 'app' })
    });
    const archive = jest.spyOn(SecurityDevice, 'create').mockResolvedValue([]);
    const app = express();
    app.use((req, _res, next) => {
        req.session = { adminRole: 'master', adminId: 'admin-1', adminName: 'Admin' };
        req.body = {};
        next();
    });
    app.use('/admin/security', securityAdmin);

    await request(app).post('/admin/security/access-requests/request-1/approve')
        .set('Accept', 'application/json').expect(200);

    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ _id: 'request-1', status: 'pending' }),
        expect.objectContaining({ $set: expect.objectContaining({ status: 'approved' }) }), { session });
    expect(replace).toHaveBeenCalledWith({
        principalType: 'executor', principalId: 'executor-1', channel: 'app', status: 'active'
    }, expect.objectContaining({ deviceIdHash: 'new-app-hash', firstLocation: null, lastLocation: null }), { session });
    expect(archive).toHaveBeenCalledWith([expect.objectContaining({ channel: 'app', status: 'revoked' })], { session });
    expect(revoke).toHaveBeenCalledWith({ accountId: 'executor-1', accountType: 'executor', active: true },
        expect.any(Object), { session });
});
