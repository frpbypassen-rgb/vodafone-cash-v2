'use strict';

jest.mock('../config/securityPolicy', () => ({
    ...jest.requireActual('../config/securityPolicy'),
    isPasskeyRequired: jest.fn(() => false)
}));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }));

const express = require('express');
const request = require('supertest');
const Admin = require('../models/Admin');
const securityAdminRoutes = require('../routes/securityAdmin');

afterEach(() => jest.restoreAllMocks());

test('admin creation endpoint stores accountant with fixed read-only permissions', async () => {
    const create = jest.spyOn(Admin, 'create').mockImplementation(async data => ({ _id: 'new-accountant', ...data }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = {
            isLoggedIn: true,
            adminRole: 'master',
            adminId: 'master-1',
            adminName: 'مدير تجريبي',
            adminPermissions: ['*']
        };
        next();
    });
    app.use('/admin/security', securityAdminRoutes);

    const response = await request(app).post('/admin/security/admins').send({
        name: 'محاسب تجريبي',
        webUsername: 'accountant_demo',
        password: 'StrongEnough#123',
        email: 'accountant@example.com',
        role: 'accountant',
        permissions: ['*', 'accounts.manage', 'executors.manage', 'reports.read']
    });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
        role: 'accountant',
        permissions: ['accounts.read', 'executors.read'],
        mustEnrollSecurity: true
    }));
});
