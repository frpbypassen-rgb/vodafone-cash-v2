'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middlewares/auth');
const Admin = require('../models/Admin');
const AuditLog = require('../models/AuditLog');
const SecurityDevice = require('../models/SecurityDevice');
const SecurityAccessRequest = require('../models/SecurityAccessRequest');
const securityControl = require('../services/securityControlService');
const passkeyService = require('../services/passkeyService');
const { logAction } = require('../services/auditService');
const { isPasskeyRequired } = require('../config/securityPolicy');
const operationPinService = require('../services/operationPinService');

const PERMISSIONS = Object.freeze([
    ['dashboard.read', 'عرض لوحة القيادة'],
    ['transactions.read', 'عرض العمليات'],
    ['transactions.manage', 'إدارة وتوجيه العمليات'],
    ['accounts.read', 'عرض الحسابات'],
    ['accounts.manage', 'إدارة الحسابات والأرصدة'],
    ['executors.read', 'عرض شركات التنفيذ'],
    ['executors.manage', 'إدارة شركات التنفيذ'],
    ['reports.read', 'عرض التقارير وسجل التدقيق'],
    ['reports.manage', 'إدارة التقارير والحركات المالية'],
    ['support.read', 'عرض الدعم والشكاوى'],
    ['support.manage', 'إدارة الدعم والشكاوى'],
    ['settings.read', 'عرض الإعدادات'],
    ['settings.manage', 'تعديل إعدادات المنظومة'],
    ['security.read', 'عرض مركز الأمان'],
    ['security.manage', 'إدارة الحماية والأجهزة']
]);

router.use(requireAuth, requirePermission('security.read'));

const currentPrincipal = (req) => securityControl.sessionPrincipal(req.session);
const principalLabel = (type) => ({
    client_user: 'عميل', client_company: 'شركة', agent_staff: 'موظف وكيل',
    sub_client: 'عميل فرعي', executor: 'منفذ', admin: 'إدارة', master_admin: 'مدير رئيسي'
}[String(type || '')] || String(type || 'حساب'));
const publicState = (state) => {
    const value = state.toObject ? state.toObject() : { ...state };
    delete value.emergencyCodeHash;
    return value;
};

const requireSecurityManager = (req, res, next) => {
    if (req.session.adminRole === 'master') return next();
    return requirePermission('security.manage')(req, res, next);
};

const requireRecentPasskey = async (req, res, next) => {
    try {
        if (!isPasskeyRequired()) return next();
        const principal = currentPrincipal(req);
        const active = principal && await SecurityDevice.findOne({
            principalType: principal.principalType,
            principalId: principal.principalId,
            channel: 'web',
            status: 'active',
            credentialId: { $ne: null }
        }).select('_id credentialId');
        if (!active || Number(req.session.securityStepUpUntil || 0) > Date.now()) return next();
        return res.status(428).json({
            success: false,
            code: 'PASSKEY_STEP_UP_REQUIRED',
            error: 'استخدم مفتاح المرور لتأكيد هذا الإجراء.'
        });
    } catch (error) {
        return res.status(503).json({ success: false, error: 'تعذر التحقق من المصادقة القوية.' });
    }
};

router.get('/', async (req, res) => {
    const [state, devices, requests, admins, auditLogs] = await Promise.all([
        securityControl.getState({ fresh: true }),
        SecurityDevice.find().sort({ status: 1, lastSeenAt: -1 }).limit(100).lean(),
        SecurityAccessRequest.find({ status: 'pending', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(50).lean(),
        Admin.find().select('name role webUsername status permissions mustEnrollSecurity createdAt updatedAt').sort({ createdAt: 1 }).lean(),
        AuditLog.find({ action: /^SECURITY_/ }).sort({ createdAt: -1 }).limit(40).lean()
    ]);
    return res.render('admin_security', {
        activePage: 'security',
        securityState: publicState(state),
        devices,
        accessRequests: requests.map((request) => ({ ...request, principalLabel: principalLabel(request.principalType) })),
        admins,
        // Serialize this once on the server. Keeping the template free from a
        // nested map/JSON expression prevents a malformed inline script from
        // disabling the approval and rejection controls in the browser.
        adminRecordsJson: JSON.stringify(admins.map((admin) => ({
            id: String(admin._id),
            name: admin.name || '',
            username: admin.webUsername || '',
            role: admin.role || '',
            status: admin.status || '',
            permissions: Array.isArray(admin.permissions) ? admin.permissions : []
        }))).replace(/</g, '\\u003c'),
        auditLogs,
        permissions: PERMISSIONS,
        currentPrincipal: currentPrincipal(req),
        currentAdminRole: req.session.adminRole,
        enrollmentRequired: admins.some((admin) => (
            String(admin._id) === String(req.session.adminId)
            && isPasskeyRequired()
            && admin.mustEnrollSecurity
        ))
    });
});

router.get('/passkeys/register/options', requireSecurityManager, async (req, res) => {
    try {
        const principal = currentPrincipal(req);
        const devices = await SecurityDevice.find({
            principalType: principal.principalType,
            principalId: principal.principalId,
            channel: 'web',
            credentialId: { $ne: null }
        }).lean();
        const options = await passkeyService.registrationOptions({ req, principal, currentDevices: devices });
        req.session.passkeyRegistrationChallenge = options.challenge;
        await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
        return res.json({ success: true, options });
    } catch (error) {
        console.error('[SecurityAdmin] passkey registration options failed:', error.message);
        return res.status(400).json({ success: false, error: 'تعذر بدء تسجيل مفتاح المرور.' });
    }
});

router.post('/passkeys/register/verify', requireSecurityManager, async (req, res) => {
    try {
        const expectedChallenge = req.session.passkeyRegistrationChallenge;
        if (!expectedChallenge) return res.status(410).json({ success: false, error: 'انتهت محاولة التسجيل. ابدأ من جديد.' });
        const verification = await passkeyService.verifyRegistration({
            req,
            response: req.body.response,
            expectedChallenge
        });
        if (!verification.verified) return res.status(422).json({ success: false, error: 'لم يتم التحقق من مفتاح المرور.' });
        const principal = currentPrincipal(req);
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
            approvedBy: req.session.adminName || 'الإدارة'
        });
        if (principal.principalType === 'admin') {
            await Admin.updateOne(
                { _id: principal.principalId },
                { $set: { mustEnrollSecurity: false } }
            );
        }
        delete req.session.passkeyRegistrationChallenge;
        req.session.securityStepUpUntil = Date.now() + 10 * 60 * 1000;
        await logAction({
            action: 'SECURITY_PASSKEY_REGISTERED', req,
            performedById: req.session.adminId,
            performedByModel: 'Admin', performedByName: req.session.adminName,
            severity: 'warning', metadata: { principalType: principal.principalType }
        });
        return res.json({ success: true, policyActivated: true });
    } catch (error) {
        console.error('[SecurityAdmin] passkey registration verification failed:', error.message);
        return res.status(422).json({ success: false, error: 'فشل التحقق من مفتاح المرور.' });
    }
});

router.get('/passkeys/authenticate/options', requireSecurityManager, async (req, res) => {
    try {
        const principal = currentPrincipal(req);
        const devices = await SecurityDevice.find({
            principalType: principal.principalType,
            principalId: principal.principalId,
            channel: 'web',
            status: 'active',
            credentialId: { $ne: null }
        }).lean();
        if (!devices.length) return res.status(404).json({ success: false, code: 'PASSKEY_NOT_ENROLLED', error: 'لا يوجد مفتاح مرور مسجل.' });
        const options = await passkeyService.authenticationOptions({ req, devices });
        req.session.passkeyAuthenticationChallenge = options.challenge;
        await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
        return res.json({ success: true, options });
    } catch (error) {
        return res.status(400).json({ success: false, error: 'تعذر بدء التحقق بمفتاح المرور.' });
    }
});

router.post('/passkeys/authenticate/verify', requireSecurityManager, async (req, res) => {
    try {
        const challenge = req.session.passkeyAuthenticationChallenge;
        if (!challenge) return res.status(410).json({ success: false, error: 'انتهت محاولة التحقق.' });
        const principal = currentPrincipal(req);
        const credentialId = String(req.body.response?.id || '');
        const device = await SecurityDevice.findOne({
            principalType: principal.principalType,
            principalId: principal.principalId,
            channel: 'web',
            status: 'active',
            credentialId
        }).select('+credentialPublicKey');
        if (!device) return res.status(404).json({ success: false, error: 'مفتاح المرور غير معروف.' });
        const verification = await passkeyService.verifyAuthentication({
            req, response: req.body.response, expectedChallenge: challenge, device
        });
        if (!verification.verified) return res.status(422).json({ success: false, error: 'تعذر التحقق من الجهاز.' });
        delete req.session.passkeyAuthenticationChallenge;
        req.session.securityStepUpUntil = Date.now() + 10 * 60 * 1000;
        return res.json({ success: true });
    } catch (error) {
        console.error('[SecurityAdmin] passkey authentication failed:', error.message);
        return res.status(422).json({ success: false, error: 'فشل التحقق بمفتاح المرور.' });
    }
});

router.post('/policy', requireSecurityManager, requireRecentPasskey, async (req, res) => {
    try {
        const state = await securityControl.getState({ fresh: true });
        const enableAdminDevices = Boolean(req.body.adminDeviceEnforcementEnabled);
        if (enableAdminDevices) {
            const principal = currentPrincipal(req);
            const enrolled = await SecurityDevice.exists({
                principalType: principal.principalType,
                principalId: principal.principalId,
                channel: 'web',
                status: 'active',
                credentialId: { $ne: null }
            });
            if (!enrolled) return res.status(409).json({ success: false, error: 'سجل مفتاح مرور على الجهاز الإداري قبل تفعيل القفل.' });
        }
        state.adminDeviceEnforcementEnabled = enableAdminDevices;
        state.accountDeviceEnforcementEnabled = Boolean(req.body.accountDeviceEnforcementEnabled);
        state.mandatoryAuthenticatorEnabled = req.body.mandatoryAuthenticatorEnabled !== false;
        state.adminApprovalRequired = req.body.adminApprovalRequired !== false;
        state.singleDeviceOnly = req.body.singleDeviceOnly !== false;
        state.adminPermissionEnforcementEnabled = Boolean(req.body.adminPermissionEnforcementEnabled);
        state.locationRequired = req.body.locationRequired !== false;
        state.highConfidenceVpnBlockEnabled = req.body.highConfidenceVpnBlockEnabled !== false;
        state.adminSessionHours = Math.min(24, Math.max(1, Number(req.body.adminSessionHours) || 12));
        state.accountSessionHours = Math.min(24, Math.max(1, Number(req.body.accountSessionHours) || 12));
        state.updatedBy = req.session.adminName || '';
        await state.save();
        securityControl.invalidateStateCache();
        await logAction({
            action: 'SECURITY_POLICY_UPDATED', req,
            performedById: req.session.adminId, performedByModel: 'Admin', performedByName: req.session.adminName,
            severity: 'critical', newData: publicState(state)
        });
        return res.json({ success: true, state: publicState(state) });
    } catch (error) {
        console.error('[SecurityAdmin] policy update failed:', error.message);
        return res.status(400).json({ success: false, error: 'تعذر حفظ سياسة الأمان.' });
    }
});

router.post('/access-requests/:id/:decision', requireSecurityManager, async (req, res) => {
    try {
        const decision = req.params.decision;
        if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ success: false, error: 'قرار غير صالح.' });
        const request = await SecurityAccessRequest.findOne({
            _id: req.params.id,
            status: 'pending',
            expiresAt: { $gt: new Date() }
        }).select('+deviceIdHash');
        if (!request) return res.status(404).json({ success: false, error: 'الطلب غير موجود أو انتهت صلاحيته.' });
        request.status = decision === 'approve' ? 'approved' : 'rejected';
        request.reviewedBy = req.session.adminName || '';
        request.reviewedAt = new Date();
        request.reviewNote = String(req.body.note || '').slice(0, 500);
        await request.save();
        if (decision === 'approve') {
            await SecurityDevice.updateMany(
                { principalType: request.principalType, principalId: request.principalId, status: 'active' },
                { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: 'approved_device_transfer' } }
            );
            await SecurityDevice.create({
                principalType: request.principalType,
                principalId: request.principalId,
                channel: request.channel || 'web',
                tenantId: request.tenantId,
                displayName: request.displayName,
                deviceIdHash: request.deviceIdHash,
                deviceType: request.deviceType,
                platform: request.platform,
                browser: request.browser,
                userAgent: request.userAgent,
                firstIp: request.ipAddress,
                lastIp: request.ipAddress,
                firstLocation: request.location,
                lastLocation: request.location,
                status: 'active',
                approvedBy: req.session.adminName || '',
                approvedAt: new Date(),
                lastSeenAt: new Date()
            });
        }
        await logAction({
            action: decision === 'approve' ? 'SECURITY_DEVICE_TRANSFER_APPROVED' : 'SECURITY_DEVICE_TRANSFER_REJECTED',
            req, performedById: req.session.adminId, performedByModel: 'Admin', performedByName: req.session.adminName,
            targetId: request.principalId, targetModel: request.principalType, severity: 'critical',
            metadata: { requestCode: request.requestCode, riskSignals: request.riskSignals }
        });
        // Decision forms intentionally work without JavaScript. This keeps the
        // emergency approval workflow available even if a browser extension or
        // another page script fails to load.
        if (req.accepts(['html', 'json']) === 'html') {
            return res.redirect(303, '/admin/security');
        }
        return res.json({ success: true });
    } catch (error) {
        console.error('[SecurityAdmin] access request decision failed:', error.message);
        return res.status(400).json({ success: false, error: 'تعذر تنفيذ قرار الجهاز.' });
    }
});

router.post('/devices/:id/revoke', requireSecurityManager, requireRecentPasskey, async (req, res) => {
    const device = await SecurityDevice.findById(req.params.id);
    if (!device) return res.status(404).json({ success: false, error: 'الجهاز غير موجود.' });
    device.status = 'revoked';
    device.revokedAt = new Date();
    device.revokedReason = String(req.body.reason || 'revoked_by_admin').slice(0, 300);
    await device.save();
    await logAction({
        action: 'SECURITY_DEVICE_REVOKED', req,
        performedById: req.session.adminId, performedByModel: 'Admin', performedByName: req.session.adminName,
        targetId: device.principalId, targetModel: device.principalType, severity: 'critical'
    });
    return res.json({ success: true });
});

// Administrative-only reset is intentional: a person with a stolen account
// session cannot change the code which protects outgoing transfers.
router.post('/operation-pins/:principalType/:principalId/reset', requireSecurityManager, requireRecentPasskey, async (req, res) => {
    try {
        const allowedTypes = new Set(['executor', 'client_user', 'client_company', 'agent_staff', 'sub_client', 'admin']);
        if (!allowedTypes.has(req.params.principalType)) return res.status(422).json({ success: false, error: 'نوع الحساب غير صالح.' });
        const profile = await operationPinService.adminResetPin({
            principal: { principalType: req.params.principalType, principalId: req.params.principalId },
            pin: req.body?.pin,
            adminName: req.session.adminName || 'الإدارة',
            enabled: req.body?.enabled !== false
        });
        await logAction({
            action: 'SECURITY_OPERATION_PIN_RESET', req,
            performedById: req.session.adminId, performedByModel: 'Admin', performedByName: req.session.adminName,
            targetId: req.params.principalId, targetModel: req.params.principalType, severity: 'critical'
        });
        return res.json({ success: true, profile });
    } catch (error) {
        return res.status(422).json({ success: false, error: 'يجب أن يكون رمز العمليات من 4 إلى 6 أرقام.' });
    }
});

router.post('/emergency-code/rotate', requireSecurityManager, requireRecentPasskey, async (req, res) => {
    const code = await securityControl.rotateEmergencyCode(req.session.adminName || 'master');
    await logAction({
        action: 'SECURITY_EMERGENCY_CODE_ROTATED', req,
        performedById: req.session.adminId, performedByModel: 'Admin', performedByName: req.session.adminName,
        severity: 'critical'
    });
    return res.json({ success: true, code });
});

router.post('/lockdown/activate', requireSecurityManager, async (req, res) => {
    try {
        const state = await securityControl.activateEmergencyLockdown({
            code: req.body.code,
            activatedBy: req.session.adminName || 'master',
            reason: req.body.reason,
            minutes: 60
        });
        await logAction({
            action: 'SECURITY_LOCKDOWN_ACTIVATED', req,
            performedById: req.session.adminId, performedByModel: 'Admin', performedByName: req.session.adminName,
            severity: 'critical', metadata: { endsAt: state.lockdownEndsAt }
        });
        return res.json({ success: true, endsAt: state.lockdownEndsAt });
    } catch (error) {
        return res.status(422).json({ success: false, error: 'رمز الطوارئ غير صحيح أو سبق استخدامه.' });
    }
});

router.post('/admins', requireSecurityManager, requireRecentPasskey, async (req, res) => {
    try {
        const username = String(req.body.webUsername || '').trim().toLowerCase();
        const password = String(req.body.password || '');
        if (!/^[a-z0-9._-]{4,80}(?:@ahram\.com)?$/.test(username)) {
            return res.status(422).json({ success: false, error: 'اسم المستخدم غير صالح.' });
        }
        if (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^\w]/.test(password)) {
            return res.status(422).json({ success: false, error: 'كلمة المرور يجب أن تكون 12 محرفاً وتحتوي على حرف كبير وصغير ورقم ورمز.' });
        }
        const allowed = new Set(PERMISSIONS.map(([value]) => value));
        const permissions = [...new Set((req.body.permissions || []).filter((item) => allowed.has(item)))];
        const role = req.body.role === 'master' && req.session.adminRole === 'master'
            ? 'master'
            : 'admin';
        const admin = await Admin.create({
            name: String(req.body.name || '').trim().slice(0, 120),
            webUsername: username,
            webPassword: password,
            role,
            permissions,
            status: 'active',
            mustEnrollSecurity: true
        });
        await logAction({
            action: 'SECURITY_ADMIN_CREATED', req,
            performedById: req.session.adminId, performedByModel: 'Admin', performedByName: req.session.adminName,
            targetId: admin._id, targetModel: 'Admin', severity: 'critical', newData: { username, permissions }
        });
        return res.json({ success: true });
    } catch (error) {
        const message = error?.code === 11000 ? 'اسم المستخدم مستخدم بالفعل.' : 'تعذر إنشاء حساب الإدارة.';
        return res.status(422).json({ success: false, error: message });
    }
});

router.patch('/admins/:id', requireSecurityManager, requireRecentPasskey, async (req, res) => {
    try {
        const target = await Admin.findById(req.params.id);
        if (!target) return res.status(404).json({ success: false, error: 'حساب الإدارة غير موجود.' });
        if (target.role === 'master' && req.session.adminRole !== 'master') {
            return res.status(403).json({ success: false, error: 'لا يمكن تعديل حساب مدير رئيسي.' });
        }
        const nextStatus = req.body.status === 'suspended' ? 'suspended' : 'active';
        if (String(target._id) === String(req.session.adminId) && nextStatus === 'suspended') {
            return res.status(409).json({ success: false, error: 'لا يمكنك تعليق الحساب المستخدم حالياً.' });
        }
        const allowed = new Set(PERMISSIONS.map(([value]) => value));
        const previous = { status: target.status, permissions: target.permissions || [] };
        target.status = nextStatus;
        target.permissions = [...new Set((req.body.permissions || []).filter((item) => allowed.has(item)))];
        if (req.body.invalidateSessions) target.sessionVersion = Number(target.sessionVersion || 0) + 1;
        await target.save();
        await logAction({
            action: 'SECURITY_ADMIN_UPDATED', req,
            performedById: req.session.adminId, performedByModel: 'Admin', performedByName: req.session.adminName,
            targetId: target._id, targetModel: 'Admin', severity: 'critical',
            oldData: previous,
            newData: { status: target.status, permissions: target.permissions, sessionsInvalidated: Boolean(req.body.invalidateSessions) }
        });
        return res.json({ success: true });
    } catch (error) {
        console.error('[SecurityAdmin] admin update failed:', error.message);
        return res.status(422).json({ success: false, error: 'تعذر تحديث حساب الإدارة.' });
    }
});

module.exports = router;
