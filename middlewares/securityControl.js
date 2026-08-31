'use strict';

const crypto = require('crypto');
const SecurityDevice = require('../models/SecurityDevice');
const Admin = require('../models/Admin');
const securityControl = require('../services/securityControlService');
const { isPasskeyRequired, isSecurityVerificationRequired } = require('../config/securityPolicy');

const wantsJson = (req) => Boolean(
    req.xhr
    || req.path.startsWith('/api/')
    || String(req.headers?.accept || '').includes('application/json')
);

const endSession = (req, res, status, code, message) => {
    const respond = () => {
        if (wantsJson(req)) return res.status(status).json({ success: false, code, error: message });
        return res.redirect(`/login?security=${encodeURIComponent(code)}`);
    };
    if (!req.session) return respond();
    return req.session.destroy(() => respond());
};

const hashesEqual = (left, right) => {
    if (!left || !right || left.length !== right.length) return false;
    return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
};

const enforceSecuritySession = async (req, res, next) => {
    try {
        // Login must always remain reachable. A stale session from a deployment
        // cannot be allowed to redirect this public entry point back to itself.
        if (req.path === '/login') return next();
        const principal = securityControl.sessionPrincipal(req.session);
        if (!principal) return next();
        if (req.session.emergencyOnly) {
            if (req.path.startsWith('/admin/security') || req.path === '/logout') return next();
            if (wantsJson(req)) return res.status(423).json({ success: false, code: 'EMERGENCY_SESSION_RESTRICTED', error: 'جلسة الطوارئ مخصصة لمركز الأمان فقط.' });
            return res.redirect('/admin/security');
        }
        const state = await securityControl.getState();
        const expiresAt = Number(req.session.securityExpiresAt || 0);
        const accountClass = ['master_admin', 'admin'].includes(principal.principalType) ? 'admin' : 'account';
        const sessionHours = accountClass === 'admin' ? state.adminSessionHours : state.accountSessionHours;
        if (!expiresAt) {
            req.session.securityExpiresAt = Date.now() + (sessionHours * 60 * 60 * 1000);
        } else if (expiresAt <= Date.now()) {
            return endSession(req, res, 401, 'SECURITY_SESSION_EXPIRED', 'انتهت الجلسة الآمنة. سجل الدخول مرة أخرى.');
        }

        let currentAdmin = null;
        if (principal.principalType === 'admin') {
            const admin = await Admin.findById(principal.principalId).select('status sessionVersion mustEnrollSecurity').lean();
            if (!admin || admin.status !== 'active' || Number(admin.sessionVersion || 0) !== Number(req.session.adminSessionVersion || 0)) {
                return endSession(req, res, 401, 'ADMIN_SESSION_REVOKED', 'تم إنهاء الجلسة الإدارية. سجل الدخول مرة أخرى.');
            }
            currentAdmin = admin;
        }

        // Optional mode keeps account status, session expiry and revocation
        // protection active while making device/location/passkey checks advisory.
        if (!isSecurityVerificationRequired()) return next();

        const risk = securityControl.assessNetworkRisk(req);
        if (state.highConfidenceVpnBlockEnabled && risk.highRisk) {
            return endSession(req, res, 403, 'NETWORK_RISK_BLOCKED', 'تعذر متابعة الجلسة من هذه الشبكة.');
        }

        if (isPasskeyRequired() && currentAdmin?.mustEnrollSecurity) {
            const enrollmentPath = req.path.startsWith('/admin/security');
            if (!enrollmentPath && req.path !== '/logout') {
                if (wantsJson(req)) {
                    return res.status(428).json({
                        success: false,
                        code: 'ADMIN_SECURITY_ENROLLMENT_REQUIRED',
                        error: 'يجب تسجيل بصمة الجهاز الإداري قبل استخدام لوحة الإدارة.'
                    });
                }
                return res.redirect('/admin/security?enroll=1');
            }
        }

        const enforcementEnabled = accountClass === 'admin'
            ? state.adminDeviceEnforcementEnabled
            : state.accountDeviceEnforcementEnabled;
        if (!enforcementEnabled) return next();

        const deviceId = securityControl.ensureDeviceId(req, res);
        const deviceHash = securityControl.hashDeviceId(deviceId);
        const active = await SecurityDevice.findOne({
            principalType: principal.principalType,
            principalId: principal.principalId,
            channel: 'web',
            status: 'active'
        }).select('+deviceIdHash');
        if (!active || !hashesEqual(active.deviceIdHash, deviceHash)) {
            return endSession(req, res, 403, 'DEVICE_BINDING_MISMATCH', 'هذه الجلسة غير مرتبطة بالجهاز المصرح به.');
        }
        active.lastSeenAt = new Date();
        active.lastIp = securityControl.requestIp(req);
        await active.save();
        req.securityDevice = active;
        if (isPasskeyRequired() && !active.credentialId) {
            const adminEnrollmentPath = req.path.startsWith('/admin/security');
            const accountEnrollmentPath = req.path.startsWith('/security/enroll')
                || req.path.startsWith('/security/passkey/')
                || req.path.startsWith('/security/mfa/')
                || req.path.startsWith('/security/sessions')
                || req.path === '/logout';
            if (accountClass === 'admin' && !adminEnrollmentPath && req.path !== '/logout') {
                if (wantsJson(req)) return res.status(428).json({ success: false, code: 'PASSKEY_ENROLLMENT_REQUIRED', error: 'يجب تسجيل بصمة الجهاز الإداري أولاً.' });
                return res.redirect('/admin/security?enroll=1');
            }
            if (accountClass === 'account' && !accountEnrollmentPath) {
                if (wantsJson(req)) return res.status(428).json({ success: false, code: 'PASSKEY_ENROLLMENT_REQUIRED', error: 'يجب تسجيل بصمة الجهاز أولاً.' });
                return res.redirect('/security/enroll');
            }
        }
        return next();
    } catch (error) {
        console.error('[SecurityControl] session guard failed:', error.message);
        return res.status(503).json({ success: false, code: 'SECURITY_CONTROL_UNAVAILABLE', error: 'تعذر التحقق من حماية الجلسة.' });
    }
};

const protectedMutation = (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
    const path = req.path;
    if (path.startsWith('/admin/security') || path.startsWith('/security/emergency-access')) return false;
    return [
        /^\/transaction\//,
        /^\/user\//,
        /^\/company\//,
        /^\/sub-account\//,
        /^\/executor\//,
        /^\/executors\/add/,
        /^\/employees\//,
        /^\/admin\/accounts\//,
        /^\/settings\/update/,
        /^\/executor-portal\/api\/(accept-task|complete-task|cancel-task|return-task|edit-amount|route-task|request-deposit|zaynpay-execute)/,
        /^\/api\/(v1\/)?mobile\/(client\/(new-transfer|balance-transfer)|executor\/(accept-task|complete-task|cancel-task|request-deposit|route-task|tasks\/|employees)|agent\/sub-accounts)/,
        /^\/api\/v1\/merchant\/transfer/
    ].some((pattern) => pattern.test(path));
};

const enforceEmergencyLockdown = async (req, res, next) => {
    try {
        if (!protectedMutation(req) || !(await securityControl.isLockdownActive())) return next();
        const state = await securityControl.getState();
        const payload = {
            success: false,
            code: 'SECURITY_LOCKDOWN_ACTIVE',
            error: 'المعاملات متوقفة مؤقتاً بسبب إجراء أمني.',
            endsAt: state.lockdownEndsAt
        };
        if (wantsJson(req)) return res.status(423).json(payload);
        return res.status(423).render('security_lockdown', payload);
    } catch (error) {
        console.error('[SecurityControl] lockdown guard failed:', error.message);
        return res.status(503).json({ success: false, code: 'LOCKDOWN_STATUS_UNAVAILABLE', error: 'تعذر التحقق من حالة المعاملات.' });
    }
};

const permissionRules = [
    { pattern: /^\/admin\/security/, read: 'security.read', write: 'security.manage' },
    { pattern: /^\/settings/, read: 'settings.read', write: 'settings.manage' },
    { pattern: /^\/(transactions|transaction\/)/, read: 'transactions.read', write: 'transactions.manage' },
    { pattern: /^\/(clients|user\/|company\/|sub-account\/|admin\/accounts\/)/, read: 'accounts.read', write: 'accounts.manage' },
    { pattern: /^\/(executors|executor\/|employees)/, read: 'executors.read', write: 'executors.manage' },
    { pattern: /^\/(support|complaints|whatsapp-monitor)/, read: 'support.read', write: 'support.manage' },
    { pattern: /^\/(reports|audit-log|financial-movements)/, read: 'reports.read', write: 'reports.manage' },
    { pattern: /^\/$/, read: 'dashboard.read', write: 'dashboard.manage' }
];

const enforceAdminPermissions = async (req, res, next) => {
    try {
        if (!req.session?.isLoggedIn || req.session.adminRole === 'master') return next();
        const state = await securityControl.getState();
        if (!state.adminPermissionEnforcementEnabled) return next();
        const rule = permissionRules.find((item) => item.pattern.test(req.path));
        if (!rule) return next();
        const required = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? rule.read : rule.write;
        const permissions = new Set(req.session.adminPermissions || []);
        if (permissions.has('*') || permissions.has(required)) return next();
        if (wantsJson(req)) return res.status(403).json({ success: false, code: 'ADMIN_PERMISSION_DENIED', error: 'ليس لديك الصلاحية المطلوبة.' });
        return res.status(403).render('access_denied', { requiredPermission: required });
    } catch (error) {
        console.error('[SecurityControl] permission guard failed:', error.message);
        return res.status(503).send('Security control unavailable');
    }
};

module.exports = {
    enforceSecuritySession,
    enforceEmergencyLockdown,
    enforceAdminPermissions,
    protectedMutation,
    permissionRules
};
