'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const router = express.Router();
const Admin = require('../models/Admin');
const securityControl = require('../services/securityControlService');
const { establishAuthenticatedSession } = require('../utils/sessionSecurity');
const { logAction } = require('../services/auditService');

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'تم تعليق محاولات دخول الطوارئ مؤقتاً.'
});

router.get('/security/emergency-access', (req, res) => {
    return res.render('emergency_access', {
        error: null,
        pendingUsername: '',
        credentialsVerified: false
    });
});

router.post('/security/emergency-access', limiter, async (req, res) => {
    const fail = async (message, code) => {
        await logAction({
            action: 'SECURITY_EMERGENCY_ACCESS_FAILED', req,
            performedByName: String(req.body.username || 'unknown'), success: false,
            errorCode: code, severity: 'critical'
        });
        const pending = req.session?.pendingEmergencyAccess;
        return res.status(422).render('emergency_access', {
            error: message,
            pendingUsername: pending?.username || String(req.body.username || ''),
            credentialsVerified: Boolean(pending && Number(pending.expiresAt || 0) > Date.now())
        });
    };
    try {
        const pending = req.session?.pendingEmergencyAccess;
        const pendingIsValid = Boolean(pending && Number(pending.expiresAt || 0) > Date.now());
        const username = String(pendingIsValid ? pending.username : req.body.username || '').trim();
        const password = String(req.body.password || '');
        const emergencyCode = String(req.body.emergencyCode || '').trim();
        if (!username || (!pendingIsValid && !password) || !emergencyCode) return fail('أدخل جميع بيانات الاستعادة.', 'MISSING_FIELDS');
        if (!securityControl.parseLocation(req)) return fail('يجب السماح بالموقع لإتمام إجراء الطوارئ.', 'LOCATION_REQUIRED');

        let admin = null;
        let valid = pendingIsValid;
        const envUser = String(process.env.PANEL_USER || '').trim();
        const envPass = String(process.env.PANEL_PASS || '');
        if (pendingIsValid && pending.adminId !== 'master_admin') {
            admin = await Admin.findOne({ _id: pending.adminId, status: 'active' }).lean();
            valid = Boolean(admin);
        } else if (!pendingIsValid && envUser && username.toLowerCase() === envUser.toLowerCase() && password === envPass) {
            valid = true;
        } else if (!pendingIsValid) {
            admin = await Admin.findOne({ webUsername: username }).lean();
            valid = Boolean(admin?.webPassword && admin.status !== 'suspended' && await bcrypt.compare(password, admin.webPassword));
        }
        if (!valid) return fail('تعذر التحقق من حساب الإدارة.', 'INVALID_ADMIN_CREDENTIALS');

        const state = await securityControl.activateEmergencyLockdown({
            code: emergencyCode,
            activatedBy: admin?.name || 'المدير الأساسي',
            reason: req.body.reason || 'دخول استعادة أمني',
            minutes: 60
        });
        delete req.session.pendingEmergencyAccess;
        await establishAuthenticatedSession(req, {
            isLoggedIn: true,
            adminName: admin?.name || 'المدير الأساسي - طوارئ',
            adminRole: 'master',
            adminId: admin?._id || 'master_admin',
            adminPermissions: ['security.read', 'security.manage'],
            adminSessionVersion: Number(admin?.sessionVersion || 0),
            emergencyOnly: true,
            securityExpiresAt: new Date(state.lockdownEndsAt).getTime()
        });
        await logAction({
            action: 'SECURITY_EMERGENCY_ACCESS_GRANTED', req,
            performedById: admin?._id || null, performedByModel: 'Admin',
            performedByName: admin?.name || 'المدير الأساسي', severity: 'critical',
            metadata: { lockdownEndsAt: state.lockdownEndsAt }
        });
        return req.session.save(() => res.redirect('/admin/security'));
    } catch (error) {
        return fail('رمز الاستعادة غير صحيح أو سبق استخدامه.', error.code || 'EMERGENCY_ACCESS_FAILED');
    }
});

module.exports = router;
