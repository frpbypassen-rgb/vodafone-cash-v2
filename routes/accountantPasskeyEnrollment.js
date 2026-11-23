'use strict';

const express = require('express');
const router = express.Router();
const Admin = require('../models/Admin');
const SecurityDevice = require('../models/SecurityDevice');
const { requireAuth } = require('../middlewares/auth');
const { isPasskeyRequired } = require('../config/securityPolicy');
const securityControl = require('../services/securityControlService');
const passkeyService = require('../services/passkeyService');
const { logAction } = require('../services/auditService');

router.use(requireAuth, async (req, res, next) => {
    if (req.session.adminRole !== 'accountant') return res.status(403).end();
    if (!isPasskeyRequired()) return res.redirect('/clients');
    const admin = await Admin.findById(req.session.adminId).select('role status mustEnrollSecurity').lean();
    if (!admin || admin.role !== 'accountant' || admin.status !== 'active') return res.status(403).end();
    if (!admin.mustEnrollSecurity) return res.redirect('/clients');
    return next();
});

const principalFor = (req) => ({
    principalType: 'admin',
    principalId: String(req.session.adminId),
    principalName: req.session.adminName || 'محاسب'
});

router.get('/', (_req, res) => res.render('accountant_passkey_enroll'));

router.get('/options', async (req, res) => {
    try {
        const principal = principalFor(req);
        const currentDevices = await SecurityDevice.find({
            principalType: 'admin',
            principalId: principal.principalId,
            channel: 'web',
            credentialId: { $ne: null }
        }).lean();
        const options = await passkeyService.registrationOptions({ req, principal, currentDevices });
        req.session.passkeyRegistrationChallenge = options.challenge;
        await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
        return res.json({ success: true, options });
    } catch (error) {
        console.error('[AccountantEnrollment] options failed:', error.message);
        return res.status(400).json({ success: false, error: 'تعذر بدء تسجيل مفتاح المرور.' });
    }
});

router.post('/verify', async (req, res) => {
    try {
        const expectedChallenge = req.session.passkeyRegistrationChallenge;
        if (!expectedChallenge) return res.status(410).json({ success: false, error: 'انتهت محاولة التسجيل. ابدأ من جديد.' });
        const verification = await passkeyService.verifyRegistration({
            req,
            response: req.body?.response,
            expectedChallenge
        });
        if (!verification.verified) return res.status(422).json({ success: false, error: 'لم يتم التحقق من مفتاح المرور.' });
        const principal = principalFor(req);
        const credential = verification.registrationInfo.credential;
        await securityControl.activateDevice({
            req,
            res,
            principal,
            credential: {
                ...credential,
                deviceType: verification.registrationInfo.credentialDeviceType,
                backedUp: verification.registrationInfo.credentialBackedUp
            },
            approvedBy: req.session.adminName || 'المحاسب'
        });
        await Admin.updateOne({ _id: principal.principalId, role: 'accountant', mustEnrollSecurity: true }, {
            $set: { mustEnrollSecurity: false }
        });
        delete req.session.passkeyRegistrationChallenge;
        await logAction({
            action: 'SECURITY_PASSKEY_REGISTERED', req,
            performedById: req.session.adminId,
            performedByModel: 'Admin', performedByName: req.session.adminName,
            severity: 'warning', metadata: { principalType: 'admin' }
        });
        return res.json({ success: true, next: '/clients' });
    } catch (error) {
        console.error('[AccountantEnrollment] verification failed:', error.message);
        return res.status(422).json({ success: false, error: 'فشل تسجيل مفتاح المرور.' });
    }
});

module.exports = router;
