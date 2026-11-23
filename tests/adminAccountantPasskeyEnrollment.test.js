'use strict';

jest.mock('../config/securityPolicy', () => ({
    ...jest.requireActual('../config/securityPolicy'),
    isPasskeyRequired: jest.fn(() => true)
}));
jest.mock('../services/passkeyService', () => ({
    registrationOptions: jest.fn(),
    verifyRegistration: jest.fn()
}));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }));

const express = require('express');
const request = require('supertest');
const path = require('node:path');
const ejs = require('ejs');
const Admin = require('../models/Admin');
const SecurityDevice = require('../models/SecurityDevice');
const passkeyService = require('../services/passkeyService');
const securityControl = require('../services/securityControlService');
const { enforceAccountantScope } = require('../middlewares/securityControl');
const router = require('../routes/accountantPasskeyEnrollment');

const createApp = (role = 'accountant') => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.session = {
            isLoggedIn: true,
            adminRole: role,
            adminId: 'accountant-1',
            adminName: 'محاسب تجريبي',
            save: callback => callback()
        };
        res.render = view => res.json({ view });
        next();
    });
    app.use(enforceAccountantScope);
    app.use('/admin/accountant-enroll', router);
    return app;
};

beforeEach(() => {
    jest.spyOn(Admin, 'findById').mockReturnValue({ select: () => ({ lean: async () => ({ role: 'accountant', status: 'active', mustEnrollSecurity: true }) }) });
});

afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
});

test('accountant may open only the temporary enrollment page', async () => {
    const app = createApp();
    const allowed = await request(app).get('/admin/accountant-enroll');
    const forbidden = await request(app).get('/admin/security').set('Accept', 'application/json');
    const otherAdmin = await request(createApp('admin')).get('/admin/accountant-enroll');
    expect(allowed.status).toBe(200);
    expect(allowed.body.view).toBe('accountant_passkey_enroll');
    expect(forbidden.status).toBe(403);
    expect(otherAdmin.status).toBe(403);
});

test('enrollment view renders a CSRF-protected verification request', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/accountant_passkey_enroll.ejs'), { csrfToken: 'test-token' });
    expect(html).toContain('test-token');
    expect(html).toContain("'/admin/accountant-enroll/verify'");
    expect(html).not.toContain('/admin/security');
});

test('successful passkey registration clears enrollment and returns to directory', async () => {
    jest.spyOn(SecurityDevice, 'find').mockReturnValue({ lean: async () => [] });
    passkeyService.registrationOptions.mockResolvedValue({ challenge: 'challenge-1' });
    passkeyService.verifyRegistration.mockResolvedValue({
        verified: true,
        registrationInfo: { credential: { id: 'credential-1' }, credentialDeviceType: 'singleDevice', credentialBackedUp: false }
    });
    const activateDevice = jest.spyOn(securityControl, 'activateDevice').mockResolvedValue({});
    const updateOne = jest.spyOn(Admin, 'updateOne').mockResolvedValue({ matchedCount: 1 });
    const app = createApp();
    const options = await request(app).get('/admin/accountant-enroll/options');
    expect(options.status).toBe(200);
    expect(options.body.options.challenge).toBe('challenge-1');

    // The same request session must contain a challenge before registration.
    const verifyApp = express();
    verifyApp.use(express.json());
    verifyApp.use((req, _res, next) => {
        req.session = { isLoggedIn: true, adminRole: 'accountant', adminId: 'accountant-1', adminName: 'محاسب تجريبي', passkeyRegistrationChallenge: 'challenge-1' };
        next();
    });
    verifyApp.use(enforceAccountantScope);
    verifyApp.use('/admin/accountant-enroll', router);
    const verified = await request(verifyApp).post('/admin/accountant-enroll/verify').send({ response: { id: 'credential-1' } });
    expect(verified.status).toBe(200);
    expect(verified.body.next).toBe('/clients');
    expect(activateDevice).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledWith(expect.objectContaining({ role: 'accountant', mustEnrollSecurity: true }), {
        $set: { mustEnrollSecurity: false }
    });
});
