'use strict';

jest.mock('../middlewares/auth', () => ({
    requireAuth: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
}));
jest.mock('../services/auditService', () => ({ logAction: jest.fn() }));

const express = require('express');
const request = require('supertest');
const SecurityAccessRequest = require('../models/SecurityAccessRequest');
const SecurityDevice = require('../models/SecurityDevice');
const securityAdmin = require('../routes/securityAdmin');

afterEach(() => jest.restoreAllMocks());

test('administrative app approval revokes only the existing app binding', async () => {
    const accessRequest = {
        principalType: 'executor',
        principalId: 'executor-1',
        channel: 'app',
        deviceIdHash: 'new-app-hash',
        save: jest.fn()
    };
    jest.spyOn(SecurityAccessRequest, 'findOne').mockReturnValue({
        select: jest.fn().mockResolvedValue(accessRequest)
    });
    jest.spyOn(SecurityAccessRequest, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
    const revoke = jest.spyOn(SecurityDevice, 'updateMany').mockResolvedValue({});
    const create = jest.spyOn(SecurityDevice, 'create').mockResolvedValue({});
    const app = express();
    app.use((req, _res, next) => {
        req.session = { adminRole: 'master', adminId: 'admin-1', adminName: 'Admin' };
        req.body = {};
        next();
    });
    app.use('/admin/security', securityAdmin);

    await request(app).post('/admin/security/access-requests/request-1/approve')
        .set('Accept', 'application/json').expect(200);

    expect(revoke).toHaveBeenCalledWith({
        principalType: 'executor', principalId: 'executor-1', channel: 'app', status: 'active'
    }, expect.any(Object));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'app', deviceIdHash: 'new-app-hash', status: 'active'
    }));
});
