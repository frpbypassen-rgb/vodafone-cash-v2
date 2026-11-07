'use strict';

jest.mock('../services/auditService', () => ({ logAction: jest.fn() }));
jest.mock('../services/adminAccountManagementService', () => ({
    findEditableAccount: jest.fn(),
    loadEditOptions: jest.fn().mockResolvedValue({ statuses: ['active'], roles: [], executors: [] }),
    getReturnUrl: () => '/employees'
}));

const express = require('express');
const path = require('node:path');
const request = require('supertest');
const Employee = require('../models/Employee');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientBot = require('../models/ClientBot');
const User = require('../models/User');
const SecurityAccessRequest = require('../models/SecurityAccessRequest');
const securityControl = require('../services/securityControlService');
const csrfProtection = require('../middlewares/csrfProtection');
const employees = require('../routes/employees');
const adminAccounts = require('../routes/adminAccounts');
const securityAdmin = require('../routes/securityAdmin');
const { findEditableAccount } = require('../services/adminAccountManagementService');

const employeeId = '000000000000000000000011';
const requestId = '000000000000000000000012';
const requestPath = `/admin/security/employees/${employeeId}/access-requests/${requestId}`;
const deviceRequest = {
    _id: requestId, principalId: employeeId, requestCode: 'SEC-A1B2C3D4',
    displayName: '<Phone>', expiresAt: new Date(Date.now() + 60_000)
};

function appFor(permissions, adminRole = 'admin') {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '../views'));
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => {
        req.session = { isLoggedIn: true, adminRole, adminPermissions: permissions, csrfToken: 'test-csrf' };
        res.locals.session = req.session;
        next();
    });
    app.use(csrfProtection);
    app.use(employees);
    app.use(adminAccounts);
    app.use('/admin/security', securityAdmin);
    return app;
}

beforeEach(() => {
    for (const model of [ClientEmployee, AgentEmployee, ExecutorGroup, ClientBot, User]) {
        jest.spyOn(model, 'find').mockReturnValue({
            select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([])
        });
    }
    jest.spyOn(Employee, 'find').mockReturnValue({
        lean: jest.fn().mockResolvedValue([{ _id: employeeId, name: 'موظف تجريبي', status: 'active' }])
    });
});

afterEach(() => jest.restoreAllMocks());

test.each([
    [[], false, false],
    [['security.read'], true, false],
    [['security.read', 'security.manage'], true, true]
])('renders pending requests and actions according to %j', async (permissions, canRead, canReview) => {
    const find = jest.spyOn(SecurityAccessRequest, 'find').mockReturnValue({
        select: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([deviceRequest])
    });
    const { text } = await request(appFor(permissions)).get('/employees').expect(200);
    expect(text.includes('SEC-A1B2C3D4')).toBe(canRead);
    expect(text.includes(`${requestPath}/approve`)).toBe(canReview);
    expect(text.includes(`${requestPath}/reject`)).toBe(canReview);
    if (canRead) {
        expect(text).toContain('&lt;Phone&gt;');
        expect(find).toHaveBeenCalledWith({
            principalType: 'executor', principalId: { $in: [employeeId] }, channel: 'app',
            status: 'pending', expiresAt: { $gt: expect.any(Date) }
        });
    } else {
        expect(find).not.toHaveBeenCalled();
    }
});

test('approve requires CSRF and security management and scopes the request to this employee and app', async () => {
    const find = jest.spyOn(SecurityAccessRequest, 'findOne').mockReturnValue({
        select: jest.fn().mockResolvedValue(deviceRequest)
    });
    const approve = jest.spyOn(securityControl, 'approveDeviceRequest').mockResolvedValue();
    const app = appFor(['security.read', 'security.manage']);
    await request(app).post(`${requestPath}/approve`).expect(403);
    await request(appFor(['security.read'])).post(`${requestPath}/approve`)
        .set('Accept', 'application/json').type('form').send({ _csrf: 'test-csrf' }).expect(403);
    expect(find).not.toHaveBeenCalled();
    await request(app).post(`${requestPath}/approve`).set('Accept', 'text/html').type('form')
        .send({ _csrf: 'test-csrf' }).expect(303).expect('Location', '/employees?deviceReview=approve#employee-device-requests');
    expect(find).toHaveBeenCalledWith({
        _id: requestId, principalType: 'executor', principalId: employeeId, channel: 'app',
        status: 'pending', expiresAt: { $gt: expect.any(Date) }
    });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ request: deviceRequest, platformApproval: true }));
});

test('employee profile renders only the selected employee requests with a profile return', async () => {
    findEditableAccount.mockResolvedValue({
        definition: { type: 'executor-employee', label: 'موظف منفذ' },
        account: { _id: employeeId, name: 'موظف تجريبي', status: 'active' }
    });
    const find = jest.spyOn(SecurityAccessRequest, 'find').mockReturnValue({
        select: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([deviceRequest])
    });
    const { text } = await request(appFor([], 'master'))
        .get(`/admin/accounts/executor-employee/${employeeId}/edit`).expect(200);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ principalId: { $in: [employeeId] } }));
    expect(text).toContain('SEC-A1B2C3D4');
    expect(text).toContain(`${requestPath}/approve`);
    expect(text).toContain('name="returnTo" value="profile"');
});

test('a stale or mismatched request cannot be approved', async () => {
    jest.spyOn(SecurityAccessRequest, 'findOne').mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    const approve = jest.spyOn(securityControl, 'approveDeviceRequest').mockResolvedValue();
    await request(appFor([], 'master')).post(`${requestPath}/approve`).type('form')
        .send({ _csrf: 'test-csrf' }).expect(404);
    expect(approve).not.toHaveBeenCalled();
});

test('reject records the decision and returns to the employee profile', async () => {
    jest.spyOn(SecurityAccessRequest, 'findOne').mockReturnValue({ select: jest.fn().mockResolvedValue(deviceRequest) });
    const update = jest.spyOn(SecurityAccessRequest, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
    await request(appFor([], 'master')).post(`${requestPath}/reject`).set('Accept', 'text/html').type('form')
        .send({ _csrf: 'test-csrf', returnTo: 'profile' }).expect(303)
        .expect('Location', `/admin/accounts/executor-employee/${employeeId}/edit?deviceReview=reject#employee-device-requests`);
    expect(update).toHaveBeenCalledWith(
        { _id: requestId, status: 'pending', expiresAt: { $gt: expect.any(Date) } },
        { $set: expect.objectContaining({ status: 'rejected' }) }
    );
});
