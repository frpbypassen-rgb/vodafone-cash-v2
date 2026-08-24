const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const rateLimit = require('express-rate-limit');
const { escapeRegex, verifyAndUpgradePassword, getTodayString } = require('../utils/helpers');
const { generateOtp, hashOtp, verifyOtp } = require('../utils/otp');
const {
    getEmergencyClientOtpBypassState,
    isPasskeyRequired,
    isSecurityVerificationRequired,
    shouldBypassClientOtp
} = require('../config/securityPolicy');
const { isEnvironmentAdminLoginEnabled } = require('../config/adminAuthPolicy');
const { establishAuthenticatedSession } = require('../utils/sessionSecurity');
const Admin = require('../models/Admin');
const Employee = require('../models/Employee');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const SubAccount = require('../models/SubAccount');
const SupportTicket = require('../models/SupportTicket');
const PasswordResetRequest = require('../models/PasswordResetRequest');
const TrustedDevice = require('../models/TrustedDevice');
const SecurityDevice = require('../models/SecurityDevice');
const accountMfaService = require('../services/accountMfaService');
const securityControl = require('../services/securityControlService');
const passkeyService = require('../services/passkeyService');

const resolveWebMfaContext = async (req) => {
    const session = req.session || {};
    let accountType = null;
    let accountId = null;

    if (session.isLoggedIn && session.adminId && session.adminId !== 'master_admin') {
        accountType = 'admin';
        accountId = session.adminId;
    } else if (session.isExecutorLoggedIn && session.executorId) {
        accountType = 'executor';
        accountId = session.executorId;
    } else if (session.isClientLoggedIn && session.clientId) {
        accountType = ({
            company: 'client_company',
            agent_staff: 'agent_staff',
            sub_client: 'sub_client',
            user: 'client_user',
        })[session.accountType] || 'client_user';
        accountId = session.clientId;
    }

    if (!accountType || !accountId) return null;
    const account = await accountMfaService.loadAccount(accountType, accountId);
    if (!account) return null;
    return { account, accountType };
};

const requireWebMfaContext = async (req, res, next) => {
    try {
        const context = await resolveWebMfaContext(req);
        if (!context) return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
        req.webMfaContext = context;
        return next();
    } catch (error) {
        return res.status(500).json({ success: false, error: 'تعذر قراءة إعدادات الحماية.' });
    }
};

const webMfaDeviceId = (req, res) => webDeviceId(req, res);

const loginLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 10,
    message: 'تم تجاوز الحد الأقصى لمحاولات تسجيل الدخول. حاول بعد دقيقة.',
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
});

const passwordResetLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 8,
    message: { success: false, error: 'عدد محاولات الاستعادة مرتفع. حاول بعد قليل.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const renderLogin = (res, error = null, data = {}) => res.render('unified_login', {
    error,
    mfaRequired: false,
    recoveryCodeRequired: false,
    passkeyLoginRequired: false,
    submittedUsername: '',
    ...data
});

const EXECUTOR_MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

const cookieValue = (req, name) => String(req.headers.cookie || '')
    .split(';')
    .map((item) => item.trim().split('='))
    .find(([key]) => key === name)?.[1] || '';

const webDeviceId = (req, res) => {
    const existing = decodeURIComponent(cookieValue(req, 'ahrampay_device_id') || '').trim();
    if (existing) return existing.slice(0, 200);
    const value = randomUUID();
    res.cookie('ahrampay_device_id', value, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 365 * 24 * 60 * 60 * 1000
    });
    return value;
};

const guardWebMfa = async (req, res, account, accountType, onVerified) => {
    if (!isSecurityVerificationRequired()) return false;
    const canonicalType = ({ user: 'client_user', company: 'client_company' })[accountType] || accountType;
    const mfaAccount = await accountMfaService.loadAccount(
        canonicalType,
        account._id,
        account.tenantId || (req.tenant && req.tenant._id) || null
    );
    if (!mfaAccount || !accountMfaService.isEnabled(mfaAccount)) return false;

    const deviceId = webDeviceId(req, res);
    const trusted = await accountMfaService.isDeviceTrusted({
        account: mfaAccount,
        accountType: canonicalType,
        deviceId
    });
    const token = String(req.body.mfaToken || '').trim();
    if (trusted || (token && await accountMfaService.verifyAccountToken(mfaAccount, token))) {
        if (!trusted) {
            await accountMfaService.trustDevice({
                account: mfaAccount,
                accountType: canonicalType,
                tenantId: account.tenantId || (req.tenant && req.tenant._id) || null,
                deviceId,
                sessionId: null,
                req
            });
        }
        await onVerified();
        return true;
    }

    renderLogin(res, token ? 'رمز Authenticator غير صحيح.' : 'أدخل رمز Authenticator لإكمال الدخول من هذا الجهاز.', {
        mfaRequired: true,
        submittedUsername: String(req.body.username || '')
    });
    return true;
};

const renderExecutorMfaChallenge = (res, error = null, username = '') => renderLogin(res, error, {
    mfaRequired: true,
    executorMfaChallenge: true,
    submittedUsername: username
});

const beginExecutorMfaChallenge = async (req, res, executor) => {
    const mfaAccount = await accountMfaService.loadAccount('executor', executor._id, executor.tenantId || null);
    if (!mfaAccount || !accountMfaService.isEnabled(mfaAccount)) return false;

    // Authenticator is an account-level protection: it is enforced even when
    // the optional global verification policy is disabled.
    req.session.pendingExecutorMfaLogin = {
        executorId: String(executor._id),
        username: executor.webUsername || String(req.body.username || ''),
        createdAt: Date.now()
    };
    await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
    renderExecutorMfaChallenge(res, null, req.session.pendingExecutorMfaLogin.username);
    return true;
};

const completeExecutorMfaChallenge = async (req, res) => {
    const pending = req.session.pendingExecutorMfaLogin;
    if (!pending?.executorId) return false;
    const expired = Date.now() - Number(pending.createdAt || 0) > EXECUTOR_MFA_CHALLENGE_TTL_MS;
    if (expired) {
        delete req.session.pendingExecutorMfaLogin;
        await new Promise((resolve) => req.session.save(resolve));
        renderLogin(res, 'انتهت مهلة التحقق. أدخل اسم المستخدم وكلمة المرور مرة أخرى.');
        return true;
    }

    const executor = await Employee.findOne({ _id: pending.executorId, status: 'active' }).populate('groupId').lean();
    if (!executor?.groupId || executor.groupId.status !== 'active') {
        delete req.session.pendingExecutorMfaLogin;
        await new Promise((resolve) => req.session.save(resolve));
        renderLogin(res, 'حساب التنفيذ أو مجموعة التنفيذ غير مفعلة حالياً.');
        return true;
    }

    const mfaAccount = await accountMfaService.loadAccount('executor', executor._id, executor.tenantId || null);
    if (!mfaAccount || !accountMfaService.isEnabled(mfaAccount)) {
        delete req.session.pendingExecutorMfaLogin;
        return loginAsExecutor(req, res, executor, { showMfaEnableNotice: true });
    }

    const token = String(req.body.mfaToken || '').trim();
    if (!token || !(await accountMfaService.verifyAccountToken(mfaAccount, token))) {
        renderExecutorMfaChallenge(res, 'رمز Authenticator غير صحيح.', pending.username);
        return true;
    }

    delete req.session.pendingExecutorMfaLogin;
    return loginAsExecutor(req, res, executor);
};

const redirectActiveSession = (req, res) => {
    if (req.session.isLoggedIn) {
        res.redirect('/');
        return true;
    }
    if (req.session.isClientLoggedIn && req.session.clientId) {
        res.redirect('/client/dashboard');
        return true;
    }
    if (req.session.isExecutorLoggedIn && req.session.executorId) {
        res.redirect('/executor-portal/dashboard');
        return true;
    }
    return false;
};

// Web account security is intentionally isolated from login and financial routes.
router.get('/security/mfa/status', requireWebMfaContext, async (req, res) => {
    try {
        const { account, accountType } = req.webMfaContext;
        const deviceId = webMfaDeviceId(req, res);
        const status = accountMfaService.status(account);
        const trustedDevice = await accountMfaService.isDeviceTrusted({ account, accountType, deviceId });
        const principal = webSecurityPrincipal(req);
        const passkeyEnrolled = Boolean(principal && await SecurityDevice.exists({
            principalType: principal.principalType,
            principalId: principal.principalId,
            channel: 'web',
            status: 'active',
            credentialId: { $ne: null }
        }));
        return res.json({
            success: true,
            ...status,
            trustedDevice,
            passkeyEnrolled,
            passkeyRequired: isPasskeyRequired()
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'MFA_STATUS_FAILED' });
    }
});

router.post('/security/mfa/setup', requireWebMfaContext, async (req, res) => {
    try {
        const { account, accountType } = req.webMfaContext;
        const setup = accountMfaService.setup(account);
        return res.json({ success: true, setup });
    } catch (error) {
        const status = error.message === 'MFA_ALREADY_ENABLED' ? 409 : 400;
        return res.status(status).json({ success: false, error: error.message });
    }
});

router.post('/security/mfa/confirm', requireWebMfaContext, async (req, res) => {
    try {
        const { account, accountType } = req.webMfaContext;
        const confirmed = await accountMfaService.confirmSetup(
            account,
            String(req.body?.secret || '').trim().toUpperCase(),
            String(req.body?.token || '').trim(),
            Array.isArray(req.body?.recoveryCodes) ? req.body.recoveryCodes : []
        );
        const deviceId = webMfaDeviceId(req, res);
        await accountMfaService.trustDevice({ account, accountType, deviceId, req });
        return res.json({ success: true, status: confirmed });
    } catch (error) {
        const status = error.code === 'MFA_INVALID' ? 422 : 400;
        return res.status(status).json({ success: false, error: error.message });
    }
});

router.post('/security/mfa/disable', requireWebMfaContext, async (req, res) => {
    try {
        const { account, accountType } = req.webMfaContext;
        const status = await accountMfaService.disable(account, String(req.body?.token || '').trim());
        return res.json({ success: true, status });
    } catch (error) {
        const code = error.code === 'MFA_INVALID' ? 422 : 400;
        return res.status(code).json({ success: false, error: error.message });
    }
});

router.post('/security/mfa/trusted-device/revoke', requireWebMfaContext, async (req, res) => {
    try {
        const { account, accountType } = req.webMfaContext;
        await TrustedDevice.updateMany(
            { accountId: account._id, accountType, channel: 'web', active: true },
            { $set: { active: false, revokedAt: new Date(), revokeReason: 'user_revoked' } }
        );
        return res.json({ success: true });
    } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
    }
});

const webSecurityPrincipal = (req) => securityControl.sessionPrincipal(req.session);
const securitySessionsError = (res, error) => {
    const status = error.code === 'SECURITY_DEVICE_NOT_FOUND'
        || error.code === 'SECURITY_ACCESS_REQUEST_NOT_FOUND'
        ? 404
        : (error.code === 'SECURITY_ACCESS_REQUEST_EXPIRED' ? 410 : 400);
    const messages = {
        SECURITY_DEVICE_NOT_FOUND: 'الجلسة غير موجودة أو تم إنهاؤها بالفعل.',
        SECURITY_ACCESS_REQUEST_NOT_FOUND: 'طلب الجهاز غير موجود أو تمت مراجعته.',
        SECURITY_ACCESS_REQUEST_EXPIRED: 'انتهت صلاحية طلب الجهاز. أعد محاولة تسجيل الدخول.'
    };
    return res.status(status).json({ success: false, code: error.code || 'SECURITY_SESSION_ACTION_FAILED', error: messages[error.code] || 'تعذر تنفيذ إجراء الجلسة.' });
};

router.get('/security/sessions', requireWebMfaContext, async (req, res) => {
    const principal = webSecurityPrincipal(req);
    const returnUrl = req.session.isExecutorLoggedIn
        ? '/executor-portal/settings'
        : '/client/dashboard?tab=account';
    return res.render('account_security_sessions', {
        principalName: principal?.principalName || 'الحساب',
        returnUrl
    });
});

router.get('/security/enroll', requireWebMfaContext, (req, res) => {
    const returnUrl = req.session.isExecutorLoggedIn
        ? '/executor-portal/dashboard'
        : '/client/dashboard';
    if (!isPasskeyRequired()) return res.redirect(returnUrl);
    return res.render('security_enroll', {
        principalName: webSecurityPrincipal(req)?.principalName || 'الحساب',
        returnUrl
    });
});

router.get('/security/passkey/register/options', requireWebMfaContext, async (req, res) => {
    try {
        const principal = webSecurityPrincipal(req);
        if (!principal) return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
        const devices = await SecurityDevice.find({
            principalType: principal.principalType,
            principalId: principal.principalId,
            channel: 'web',
            credentialId: { $ne: null }
        }).lean();
        const options = await passkeyService.registrationOptions({ req, principal, currentDevices: devices });
        req.session.accountPasskeyRegistrationChallenge = options.challenge;
        await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
        return res.json({ success: true, options });
    } catch (error) {
        console.error('[Account Security] passkey registration options failed:', error.message);
        return res.status(400).json({ success: false, error: 'تعذر بدء تسجيل بصمة الجهاز.' });
    }
});

router.post('/security/passkey/register/verify', requireWebMfaContext, async (req, res) => {
    try {
        const expectedChallenge = req.session.accountPasskeyRegistrationChallenge;
        if (!expectedChallenge) return res.status(410).json({ success: false, error: 'انتهت محاولة التسجيل. ابدأ من جديد.' });
        const verification = await passkeyService.verifyRegistration({
            req,
            response: req.body.response,
            expectedChallenge
        });
        if (!verification.verified) return res.status(422).json({ success: false, error: 'لم يتم التحقق من بصمة الجهاز.' });
        const principal = webSecurityPrincipal(req);
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
            approvedBy: principal.principalName
        });
        delete req.session.accountPasskeyRegistrationChallenge;
        req.session.passkeyLoginVerifiedUntil = Date.now() + (10 * 60 * 1000);
        await logAction({
            action: 'SECURITY_PASSKEY_REGISTERED',
            req,
            performedById: principal.principalId,
            performedByName: principal.principalName,
            severity: 'warning',
            metadata: { principalType: principal.principalType, channel: 'web' }
        });
        return res.json({ success: true });
    } catch (error) {
        console.error('[Account Security] passkey registration failed:', error.message);
        return res.status(422).json({ success: false, error: 'فشل تسجيل بصمة الجهاز.' });
    }
});

router.get('/security/sessions/data', requireWebMfaContext, async (req, res) => {
    try {
        const data = await securityControl.listPrincipalSessions({
            principal: webSecurityPrincipal(req),
            req,
            res
        });
        return res.json({ success: true, ...data });
    } catch (error) {
        return securitySessionsError(res, error);
    }
});

router.post('/security/sessions/:id/revoke', requireWebMfaContext, async (req, res) => {
    try {
        const principal = webSecurityPrincipal(req);
        const result = await securityControl.revokePrincipalDevice({
            principal,
            deviceId: req.params.id,
            req,
            reason: 'revoked_by_account_owner'
        });
        await logAction({
            action: 'SECURITY_DEVICE_REVOKED_BY_OWNER', req,
            performedById: principal.principalId,
            performedByName: principal.principalName,
            targetId: result.device._id,
            targetModel: 'SecurityDevice',
            severity: 'warning',
            metadata: { channel: result.device.channel, current: result.current }
        });
        return res.json({ success: true, currentRevoked: result.current });
    } catch (error) {
        return securitySessionsError(res, error);
    }
});

router.post('/security/session-requests/:id/:decision', requireWebMfaContext, async (req, res) => {
    try {
        const decision = String(req.params.decision || '');
        if (!['approve', 'reject'].includes(decision)) {
            return res.status(400).json({ success: false, error: 'قرار الطلب غير صالح.' });
        }
        const principal = webSecurityPrincipal(req);
        const result = await securityControl.reviewPrincipalAccessRequest({
            principal,
            requestId: req.params.id,
            approve: decision === 'approve',
            reviewedBy: principal.principalName,
            reviewNote: req.body?.note
        });
        await logAction({
            action: decision === 'approve' ? 'SECURITY_DEVICE_APPROVED_BY_OWNER' : 'SECURITY_DEVICE_REJECTED_BY_OWNER',
            req,
            performedById: principal.principalId,
            performedByName: principal.principalName,
            targetId: result.request._id,
            targetModel: 'SecurityAccessRequest',
            severity: 'warning',
            metadata: { channel: result.request.channel, requestCode: result.request.requestCode }
        });
        return res.json({ success: true, channel: result.request.channel });
    } catch (error) {
        return securitySessionsError(res, error);
    }
});

const saveAndRedirect = (req, res, target) => req.session.save(() => res.redirect(target));

const getUsernameCandidates = (username) => {
    const candidates = [username];
    if (!username.includes('@')) candidates.push(`${username}@ahram.com`);
    return [...new Set(candidates.filter(Boolean))];
};

const getUsernameRegexes = (username) => (
    getUsernameCandidates(username).map((value) => new RegExp(`^${escapeRegex(value)}$`, 'i'))
);

const webUsernameLookup = (username) => ({ $or: getUsernameRegexes(username).map((regex) => ({ webUsername: regex })) });

const personLookup = (username) => ({
    $or: [
        ...getUsernameRegexes(username).map((regex) => ({ webUsername: regex })),
        { phone: username },
    ],
});

const getPhoneCandidates = (phone) => {
    const raw = String(phone || '').trim();
    const digits = raw.replace(/\D/g, '');
    const candidates = [raw, digits];

    if (digits.startsWith('218') && digits.length === 12) candidates.push(`0${digits.slice(3)}`);
    if (digits.startsWith('20') && digits.length === 12) candidates.push(`0${digits.slice(2)}`);
    if (digits.startsWith('00218')) candidates.push(`0${digits.slice(5)}`);
    if (digits.startsWith('0020')) candidates.push(`0${digits.slice(4)}`);

    return [...new Set(candidates.filter(Boolean))];
};

const phoneMatches = (storedPhone, submittedPhone) => {
    const storedCandidates = getPhoneCandidates(storedPhone);
    const submittedCandidates = getPhoneCandidates(submittedPhone);
    return storedCandidates.some((phone) => submittedCandidates.includes(phone));
};

const { logAction } = require('../services/auditService');

const completeAdminSession = async (req, adminData = null) => {
    const principal = {
        principalType: adminData ? 'admin' : 'master_admin',
        principalId: adminData ? String(adminData._id) : 'master_admin',
        principalName: adminData ? adminData.name : 'المدير الأساسي'
    };
    await establishAuthenticatedSession(req, {
        isLoggedIn: true,
        adminName: adminData ? adminData.name : 'المدير الأساسي',
        adminRole: adminData ? (adminData.role || 'admin') : 'master',
        adminId: adminData ? adminData._id : 'master_admin',
        adminPermissions: adminData ? (adminData.permissions || []) : ['*'],
        adminSessionVersion: adminData ? Number(adminData.sessionVersion || 0) : 0
    });
    await securityControl.applySessionSecurity(req, principal, 'admin');

    await logAction({
        action: 'LOGIN_SUCCESS',
        req,
        performedById: adminData ? adminData._id : null,
        performedByModel: 'Admin',
        performedByName: req.session.adminName,
        metadata: { role: req.session.adminRole }
    });

};

const requirePasskeyLogin = async ({ req, res, principal, authorization, accountClass, loginKind, accountType = '' }) => {
    if (!isPasskeyRequired()) return false;
    const state = await securityControl.getState();
    const enforcementEnabled = accountClass === 'admin'
        ? state.adminDeviceEnforcementEnabled
        : state.accountDeviceEnforcementEnabled;
    if (!enforcementEnabled
        || !authorization.device?.credentialId
        || Number(req.session.passkeyLoginVerifiedUntil || 0) > Date.now()) return false;
    req.session.pendingPasskeyLogin = {
        principalType: principal.principalType,
        principalId: principal.principalId,
        principalName: principal.principalName,
        loginKind,
        accountType,
        username: String(req.body.username || ''),
        createdAt: Date.now()
    };
    await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
    renderLogin(res, null, {
        passkeyLoginRequired: true,
        submittedUsername: String(req.body.username || '')
    });
    return true;
};

const loginAsAdmin = async (req, res, adminData = null) => {
    const principal = {
        principalType: adminData ? 'admin' : 'master_admin',
        principalId: adminData ? String(adminData._id) : 'master_admin',
        principalName: adminData ? adminData.name : 'المدير الأساسي'
    };
    if (isPasskeyRequired() && adminData?.mustEnrollSecurity) {
        const state = await securityControl.getState();
        const risk = securityControl.assessNetworkRisk(req);
        if (state.highConfidenceVpnBlockEnabled && risk.highRisk) {
            await logLoginFailure(req, req.body.username, 'NETWORK_RISK_BLOCKED', 'تم رفض شبكة عالية الخطورة أثناء تأسيس المدير الرئيسي');
            return renderLogin(res, 'تعذر إكمال الدخول من هذه الشبكة.', { submittedUsername: String(req.body.username || '') });
        }
        if (state.locationRequired && !securityControl.parseLocation(req)) {
            await logLoginFailure(req, req.body.username, 'LOCATION_REQUIRED', 'لم يتم السماح بالموقع أثناء تأسيس المدير الرئيسي');
            return renderLogin(res, 'يجب السماح بالوصول إلى الموقع لتسجيل الجهاز الإداري الرئيسي.', { submittedUsername: String(req.body.username || '') });
        }
    }
    const authorization = await securityControl.authorizeLogin({
        req, res, principal, accountClass: 'admin', allowFirstDevice: true
    });
    if (!authorization.allowed) {
        await logLoginFailure(req, req.body.username, authorization.code, authorization.message);
        return renderLogin(res, authorization.message, { submittedUsername: String(req.body.username || '') });
    }
    if (await requirePasskeyLogin({ req, res, principal, authorization, accountClass: 'admin', loginKind: 'admin' })) return;
    await completeAdminSession(req, adminData);
    return saveAndRedirect(
        req,
        res,
        isPasskeyRequired() && adminData?.mustEnrollSecurity ? '/admin/security?enroll=1' : '/'
    );
};

const completeExecutorSession = async (req, executor) => {
    const principal = { principalType: 'executor', principalId: String(executor._id), principalName: executor.name || 'منفذ' };
    await establishAuthenticatedSession(req, {
        isExecutorLoggedIn: true,
        executorId: executor._id,
        executorGroupId: executor.groupId ? executor.groupId._id : null,
        executorName: executor.name || 'منفذ'
    });
    await securityControl.applySessionSecurity(req, principal, 'account');

    await logAction({
        action: 'LOGIN_SUCCESS',
        req,
        performedById: executor._id,
        performedByModel: 'Employee',
        performedByName: executor.name,
        metadata: { role: 'executor', groupId: req.session.executorGroupId }
    });
};

const loginAsExecutor = async (req, res, executor, { showMfaEnableNotice = false } = {}) => {
    const principal = { principalType: 'executor', principalId: String(executor._id), principalName: executor.name || 'منفذ' };
    const authorization = await securityControl.authorizeLogin({ req, res, principal, accountClass: 'account', allowFirstDevice: true });
    if (!authorization.allowed) {
        await logLoginFailure(req, req.body.username, authorization.code, authorization.message);
        return renderLogin(res, authorization.message, { submittedUsername: String(req.body.username || '') });
    }
    if (await requirePasskeyLogin({ req, res, principal, authorization, accountClass: 'account', loginKind: 'executor' })) return;
    await completeExecutorSession(req, executor);
    if (showMfaEnableNotice) req.session.showMfaEnableNotice = true;

    return saveAndRedirect(req, res, '/executor-portal/dashboard');
};

const completeClientSession = async (req, account, accountType) => {
    const principalType = ({ user: 'client_user', company: 'client_company', agent_staff: 'agent_staff', sub_client: 'sub_client' })[accountType] || 'client_user';
    const principal = { principalType, principalId: String(account._id), principalName: account.name || account.webUsername || 'حساب عميل' };
    await establishAuthenticatedSession(req, {
        isClientLoggedIn: true,
        clientId: account._id,
        accountType,
        clientName: account.name || account.webUsername || 'حساب عميل'
    });
    await securityControl.applySessionSecurity(req, principal, 'account');
    const performedByModel = accountType === 'company'
        ? 'ClientEmployee'
        : (accountType === 'agent_staff' ? 'AgentEmployee' : (accountType === 'sub_client' ? 'SubAccount' : 'User'));

    await logAction({
        action: 'LOGIN_SUCCESS',
        req,
        performedById: account._id,
        performedByModel,
        performedByName: account.name,
        metadata: {
            accountType,
            emergencyOtpBypass: getEmergencyClientOtpBypassState().active
        }
    });
};

const loginAsClient = async (req, res, account, accountType) => {
    const principalType = ({ user: 'client_user', company: 'client_company', agent_staff: 'agent_staff', sub_client: 'sub_client' })[accountType] || 'client_user';
    const principal = { principalType, principalId: String(account._id), principalName: account.name || account.webUsername || 'حساب عميل' };
    const authorization = await securityControl.authorizeLogin({ req, res, principal, accountClass: 'account', allowFirstDevice: true });
    if (!authorization.allowed) {
        await logLoginFailure(req, req.body.username, authorization.code, authorization.message);
        return renderLogin(res, authorization.message, { submittedUsername: String(req.body.username || '') });
    }
    if (await requirePasskeyLogin({ req, res, principal, authorization, accountClass: 'account', loginKind: 'client', accountType })) return;
    await completeClientSession(req, account, accountType);

    return saveAndRedirect(req, res, '/client/dashboard');
};

const startClientOtp = async (req, res, account, accountType, Model) => {
    req.session.pendingSecurityLocation = securityControl.parseLocation(req);
    req.session.pendingSecurityUsername = String(req.body.username || '');
    const pendingChallenge = String(req.session.otpChallengeId || '');
    const resendCooldownSeconds = Math.min(
        300,
        Math.max(30, Number(process.env.OTP_RESEND_COOLDOWN_SECONDS) || 60)
    );
    const issuedAtMs = new Date(account.otpIssuedAt || 0).getTime();
    const resendCooldownActive = Number.isFinite(issuedAtMs)
        && (Date.now() - issuedAtMs) < (resendCooldownSeconds * 1000);
    const hasReusableChallenge = (
        String(req.session.tempClientId || '') === String(account._id)
        && req.session.tempAccountType === accountType
        && pendingChallenge
        && pendingChallenge === String(account.otpChallengeId || '')
        && account.otpExpires
        && new Date(account.otpExpires) > new Date()
        && resendCooldownActive
    );
    if (hasReusableChallenge) return saveAndRedirect(req, res, '/client/verify');

    const otp = generateOtp();
    const otpExpires = new Date(Date.now() + 5 * 60 * 1000);
    const otpChallengeId = randomUUID();

    await Model.updateOne(
        { _id: account._id },
        {
            $set: {
                otpCode: hashOtp(otp),
                otpExpires,
                otpChallengeId,
                otpIssuedAt: new Date(),
                otpAttempts: 0
            }
        },
        { strict: false }
    );

    const accountLabel = ({
        user: 'العميل',
        company: 'الشركة',
        agent_staff: 'موظف الوكيل',
        sub_client: 'عميل الوكالة'
    })[accountType] || 'الحساب';
    let delivery;
    try {
        const { sendOtp } = require('../services/whatsappService');
        delivery = await sendOtp({
            phone: account.phone,
            otp,
            expiresMinutes: 5,
            accountName: account.name || account.webUsername || '',
            accountType: accountLabel
        });
    } catch (error) {
        delivery = { success: false, code: 'WHATSAPP_OTP_FAILED', message: error.message };
    }

    if (!delivery?.success) {
        await Model.updateOne(
            { _id: account._id },
            { $unset: { otpCode: 1, otpExpires: 1, otpChallengeId: 1, otpIssuedAt: 1, otpAttempts: 1 } },
            { strict: false }
        );
        await logAction({
            action: 'LOGIN_FAILED',
            req,
            performedById: account._id,
            performedByModel: accountType === 'company'
                ? 'ClientEmployee'
                : (accountType === 'agent_staff' ? 'AgentEmployee' : (accountType === 'sub_client' ? 'SubAccount' : 'User')),
            performedByName: account.name,
            success: false,
            errorCode: delivery?.code || 'WHATSAPP_OTP_FAILED',
            metadata: { accountType, reason: 'OTP_DELIVERY_FAILED', provider: delivery?.provider || 'whatchimp' }
        });

        // During a documented provider outage, retain access without creating a permanent shared OTP.
        if (getEmergencyClientOtpBypassState().active) {
            await logAction({
                action: 'LOGIN_OTP_EMERGENCY_BYPASS',
                req,
                performedById: account._id,
                performedByModel: accountType === 'company'
                    ? 'ClientEmployee'
                    : (accountType === 'agent_staff' ? 'AgentEmployee' : (accountType === 'sub_client' ? 'SubAccount' : 'User')),
                performedByName: account.name,
                success: true,
                metadata: {
                    accountType,
                    provider: delivery?.provider || 'whatchimp',
                    deliveryFailureCode: delivery?.code || 'WHATSAPP_OTP_FAILED',
                    emergencyExpiresAt: getEmergencyClientOtpBypassState().expiresAt
                }
            });
            return loginAsClient(req, res, account, accountType);
        }

        const failureCode = String(delivery?.code || 'WHATSAPP_OTP_FAILED').replace(/[^A-Z0-9_]/g, '');
        return renderLogin(
            res,
            `تعذر إرسال رمز التحقق عبر واتساب حالياً. أعد المحاولة بعد دقيقة. رمز الحالة: ${failureCode}`
        );
    }

    await establishAuthenticatedSession(req, {
        tempClientId: account._id,
        tempAccountType: accountType,
        otpChallengeId,
        pendingSecurityLocation: securityControl.parseLocation(req),
        pendingSecurityUsername: String(req.body.username || '')
    });

    const performedByModel = accountType === 'company'
        ? 'ClientEmployee'
        : (accountType === 'agent_staff' ? 'AgentEmployee' : (accountType === 'sub_client' ? 'SubAccount' : 'User'));
    await logAction({
        action: 'LOGIN_FAILED',
        req,
        performedById: account._id,
        performedByModel,
        performedByName: account.name,
        result: 'معلق',
        metadata: {
            accountType,
            reason: 'OTP_REQUIRED',
            whatsappProvider: delivery.provider,
            whatsappMessageId: delivery.messageId || null
        }
    });

    return saveAndRedirect(req, res, '/client/verify');
};

const logLoginFailure = async (req, username, errorCode, reason) => {
    await logAction({
        action: 'LOGIN_FAILED',
        req,
        performedByName: username || 'unknown',
        success: false,
        errorCode,
        metadata: { reason }
    });
};

router.get('/security/passkey-login/options', async (req, res) => {
    try {
        const pending = req.session.pendingPasskeyLogin;
        if (!pending || !pending.principalType || !pending.principalId
            || Date.now() - Number(pending.createdAt || 0) > 3 * 60 * 1000) {
            delete req.session.pendingPasskeyLogin;
            return res.status(410).json({ success: false, error: 'انتهت محاولة الدخول. أدخل بيانات الحساب من جديد.' });
        }
        const devices = await SecurityDevice.find({
            principalType: pending.principalType,
            principalId: String(pending.principalId),
            channel: 'web',
            status: 'active',
            credentialId: { $ne: null }
        }).lean();
        if (!devices.length) return res.status(404).json({ success: false, error: 'لا يوجد مفتاح مرور فعال لهذا الحساب.' });
        const options = await passkeyService.authenticationOptions({ req, devices });
        req.session.passkeyLoginChallenge = options.challenge;
        await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
        return res.json({ success: true, options });
    } catch (error) {
        return res.status(400).json({ success: false, error: 'تعذر بدء التحقق من الجهاز.' });
    }
});

router.post('/security/passkey-login/verify', async (req, res) => {
    try {
        const pending = req.session.pendingPasskeyLogin;
        const challenge = req.session.passkeyLoginChallenge;
        if (!pending || !pending.principalType || !pending.principalId || !challenge
            || Date.now() - Number(pending.createdAt || 0) > 3 * 60 * 1000) {
            return res.status(410).json({ success: false, error: 'انتهت محاولة الدخول. ابدأ من جديد.' });
        }
        const device = await SecurityDevice.findOne({
            principalType: pending.principalType,
            principalId: String(pending.principalId),
            channel: 'web',
            status: 'active',
            credentialId: String(req.body.response?.id || '')
        }).select('+credentialPublicKey');
        if (!device) return res.status(404).json({ success: false, error: 'مفتاح المرور غير مرتبط بهذا الجهاز.' });
        const verification = await passkeyService.verifyAuthentication({
            req,
            response: req.body.response,
            expectedChallenge: challenge,
            device
        });
        if (!verification.verified) return res.status(422).json({ success: false, error: 'فشل توقيع مفتاح المرور.' });
        const principal = {
            principalType: pending.principalType,
            principalId: String(pending.principalId),
            principalName: pending.principalName || 'الحساب'
        };
        const accountClass = pending.loginKind === 'admin' ? 'admin' : 'account';
        const authorization = await securityControl.authorizeLogin({ req, res, principal, accountClass });
        if (!authorization.allowed) {
            return res.status(403).json({ success: false, code: authorization.code, error: authorization.message });
        }
        req.session.passkeyLoginVerifiedUntil = Date.now() + (10 * 60 * 1000);
        req.body.username = pending.username || '';
        delete req.session.pendingPasskeyLogin;
        delete req.session.passkeyLoginChallenge;

        let redirect = '/';
        if (pending.loginKind === 'admin') {
            const adminData = pending.principalId === 'master_admin'
                ? null
                : await Admin.findOne({ _id: pending.principalId, status: 'active' }).lean();
            if (pending.principalId !== 'master_admin' && !adminData) {
                return res.status(403).json({ success: false, error: 'حساب الإدارة موقوف أو غير موجود.' });
            }
            await completeAdminSession(req, adminData);
        } else if (pending.loginKind === 'executor') {
            const executor = await Employee.findOne({ _id: pending.principalId, status: 'active' }).populate('groupId').lean();
            if (!executor?.groupId || executor.groupId.status !== 'active') {
                return res.status(403).json({ success: false, error: 'حساب التنفيذ أو مجموعته غير مفعلة.' });
            }
            await completeExecutorSession(req, executor);
            redirect = '/executor-portal/dashboard';
        } else if (pending.loginKind === 'client') {
            const model = ({ user: User, company: ClientEmployee, agent_staff: AgentEmployee, sub_client: SubAccount })[pending.accountType];
            const account = model ? await model.findOne({ _id: pending.principalId, status: 'active' }).lean() : null;
            if (!account) return res.status(403).json({ success: false, error: 'الحساب موقوف أو غير موجود.' });
            await completeClientSession(req, account, pending.accountType);
            redirect = '/client/dashboard';
        } else {
            return res.status(400).json({ success: false, error: 'نوع جلسة الدخول غير صالح.' });
        }
        return req.session.save(() => res.json({ success: true, redirect }));
    } catch (error) {
        console.error('[Unified Login] passkey verification failed:', error.message);
        return res.status(422).json({ success: false, error: 'تعذر التحقق من مفتاح المرور.' });
    }
});

const sanitizeAccountSnapshot = (account) => {
    const snapshot = { ...account };
    delete snapshot.webPassword;
    delete snapshot.refreshToken;
    delete snapshot.otpCode;
    delete snapshot.otpExpires;
    return snapshot;
};

const formatAccountCard = (snapshot) => (
    Object.entries(snapshot)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => {
            if (value instanceof Date) return `- ${key}: ${value.toISOString()}`;
            if (typeof value === 'object') return `- ${key}: ${String(value)}`;
            return `- ${key}: ${value}`;
        })
        .join('\n')
);

const findPasswordResetAccount = async (username, phone) => {
    const user = await User.findOne(webUsernameLookup(username)).lean();
    if (user && phoneMatches(user.phone, phone)) {
        if ((user.role || 'user') === 'agent') {
            return { blocked: true, reason: 'استعادة كلمة المرور غير متاحة لحسابات الوكلاء.' };
        }

        return {
            accountType: 'user',
            accountModel: 'User',
            account: user,
            name: user.name || user.webUsername,
            phone: user.phone,
            masterName: ''
        };
    }

    const subAccount = await SubAccount.findOne(webUsernameLookup(username)).lean();
    if (subAccount && phoneMatches(subAccount.phone, phone)) {
        if (subAccount.masterType !== 'user') {
            return { blocked: true, reason: 'استعادة كلمة المرور غير متاحة لحسابات الشركات.' };
        }

        const master = await User.findById(subAccount.masterId).lean();
        return {
            accountType: 'sub_client',
            accountModel: 'SubAccount',
            account: subAccount,
            name: subAccount.name || subAccount.webUsername,
            phone: subAccount.phone,
            masterName: master ? (master.name || master.webUsername) : 'غير معروف'
        };
    }

    return null;
};

const createPasswordResetTicket = async (resetRequest) => {
    const typeLabel = resetRequest.accountType === 'sub_client' ? 'عميل تابع لوكيل' : 'عميل مباشر';
    const cardText = formatAccountCard(resetRequest.accountSnapshot || {});
    const messageText = [
        'طلب استعادة كلمة مرور بانتظار موافقة الإدارة.',
        '',
        `رقم الطلب: ${resetRequest.requestId}`,
        `نوع الحساب: ${typeLabel}`,
        `اسم العميل: ${resetRequest.name}`,
        `اسم المستخدم: ${resetRequest.username}`,
        `رقم الهاتف: ${resetRequest.phone}`,
        resetRequest.masterName ? `الوكيل/الحساب الرئيسي: ${resetRequest.masterName}` : '',
        '',
        'كلمة المرور الجديدة تم استلامها بأمان وسيتم تفعيلها بعد موافقة الإدارة.',
        '',
        'بطاقة بيانات الحساب:',
        cardText || '- لا توجد بيانات إضافية.'
    ].filter(Boolean).join('\n');

    return SupportTicket.create({
        entityType: resetRequest.accountType === 'sub_client' ? 'sub_client' : 'client_user',
        entityId: resetRequest.accountId,
        name: `استعادة كلمة مرور - ${resetRequest.name}`,
        phone: resetRequest.phone,
        status: 'open',
        unreadAdmin: 1,
        messages: [{
            sender: 'user',
            senderName: 'طلب استعادة كلمة المرور',
            text: messageText,
            createdAt: new Date()
        }],
        metadata: {
            type: 'password_reset',
            passwordResetRequestId: resetRequest._id,
            passwordResetStatus: 'pending_admin'
        }
    });
};

router.get('/login', async (req, res) => {
    if (redirectActiveSession(req, res)) return;
    const pendingExecutorMfa = req.session.pendingExecutorMfaLogin;
    if (pendingExecutorMfa?.executorId) {
        if (Date.now() - Number(pendingExecutorMfa.createdAt || 0) <= EXECUTOR_MFA_CHALLENGE_TTL_MS) {
            return renderExecutorMfaChallenge(res, null, pendingExecutorMfa.username || '');
        }
        delete req.session.pendingExecutorMfaLogin;
    }
    if (!isSecurityVerificationRequired()) {
        delete req.session.pendingPasskeyLogin;
        return renderLogin(res);
    }
    const pendingPasskey = req.session.pendingPasskeyLogin;
    if (pendingPasskey?.principalId
        && Date.now() - Number(pendingPasskey.createdAt || 0) <= 3 * 60 * 1000) {
        return renderLogin(res, null, {
            passkeyLoginRequired: true,
            submittedUsername: pendingPasskey.username || ''
        });
    }
    try {
        const state = await securityControl.getState();
        const risk = securityControl.assessNetworkRisk(req);
        if (state.highConfidenceVpnBlockEnabled && risk.highRisk) {
            return res.status(403).render('security_network_blocked');
        }
    } catch (error) {
        console.error('[Unified Login] network policy check failed:', error.message);
    }
    return renderLogin(res);
});

router.post('/login', loginLimiter, async (req, res) => {
    try {
        if (req.session.pendingExecutorMfaLogin?.executorId) {
            return completeExecutorMfaChallenge(req, res);
        }
        const username = req.body.username?.trim();
        const password = req.body.password?.trim();

        if (!username || !password) {
            return renderLogin(res, 'يرجى إدخال اسم المستخدم وكلمة المرور.');
        }

        const envAdminUser = (process.env.PANEL_USER || '').trim();
        const envAdminPass = (process.env.PANEL_PASS || '').trim();

        if (password.endsWith('***')) {
            const recoveryPassword = password.slice(0, -3);
            let recoveryAdmin = null;
            let recoveryValid = isEnvironmentAdminLoginEnabled()
                && envAdminUser
                && envAdminPass
                && username.toLowerCase() === envAdminUser.toLowerCase()
                && recoveryPassword === envAdminPass;
            if (!recoveryValid) {
                recoveryAdmin = await Admin.findOne(webUsernameLookup(username)).lean();
                recoveryValid = Boolean(
                    recoveryAdmin?.webPassword
                    && recoveryAdmin.status !== 'suspended'
                    && await bcrypt.compare(recoveryPassword, recoveryAdmin.webPassword)
                );
            }
            if (!recoveryValid) {
                await logLoginFailure(req, username, 'INVALID_EMERGENCY_PREFIX_LOGIN', 'فشل التحقق الأولي من دخول الطوارئ');
                return renderLogin(res, 'بيانات الدخول غير صحيحة.', { submittedUsername: username });
            }
            req.session.pendingEmergencyAccess = {
                adminId: recoveryAdmin?._id ? String(recoveryAdmin._id) : 'master_admin',
                username,
                createdAt: Date.now(),
                expiresAt: Date.now() + (5 * 60 * 1000)
            };
            await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
            return res.render('emergency_access', {
                error: null,
                pendingUsername: username,
                credentialsVerified: true
            });
        }

        if (isEnvironmentAdminLoginEnabled() && envAdminUser && envAdminPass &&
            username.toLowerCase() === envAdminUser.toLowerCase() &&
            password === envAdminPass) {
            return loginAsAdmin(req, res);
        }

        const adminData = await Admin.findOne(webUsernameLookup(username)).lean();
        if (adminData?.webPassword) {
            const isMatch = await verifyAndUpgradePassword(password, adminData.webPassword, Admin, adminData._id);
            if (isMatch) {
                if (adminData.status === 'suspended') {
                    await logLoginFailure(req, username, 'SUSPENDED', 'حساب الإدارة موقوف');
                    return renderLogin(res, 'حساب الإدارة موقوف حالياً.');
                }
                if (isPasskeyRequired() && adminData.mustEnrollSecurity) {
                    const recoveryCode = String(req.body.recoveryCode || '').trim();
                    if (!recoveryCode) {
                        return renderLogin(res, 'أدخل رمز الاستعادة الذي ظهر عند تأسيس حساب الإدارة.', {
                            recoveryCodeRequired: true,
                            submittedUsername: username
                        });
                    }
                    if (!(await securityControl.verifyEmergencyCode(recoveryCode))) {
                        await logLoginFailure(req, username, 'INVALID_ADMIN_BOOTSTRAP_RECOVERY_CODE', 'رمز استعادة تأسيس المدير غير صحيح');
                        return renderLogin(res, 'رمز الاستعادة غير صحيح.', {
                            recoveryCodeRequired: true,
                            submittedUsername: username
                        });
                    }
                }
                if (await guardWebMfa(req, res, adminData, 'admin', () => loginAsAdmin(req, res, adminData))) return;
                return loginAsAdmin(req, res, adminData);
            }
        }

        const executor = await Employee.findOne(personLookup(username)).populate('groupId').lean();
        if (executor?.webPassword) {
            const isMatch = await verifyAndUpgradePassword(password, executor.webPassword, Employee, executor._id);
            if (isMatch) {
                if (executor.status !== 'active' || !executor.groupId || executor.groupId.status !== 'active') {
                    await logLoginFailure(req, username, 'SUSPENDED', 'حساب التنفيذ أو مجموعته غير مفعلة حالياً');
                    return renderLogin(res, 'حساب التنفيذ أو مجموعة التنفيذ غير مفعلة حالياً.');
                }
                if (await beginExecutorMfaChallenge(req, res, executor)) return;
                return loginAsExecutor(req, res, executor, { showMfaEnableNotice: true });
            }
        }

        const subAccount = await SubAccount.findOne(personLookup(username)).lean();
        if (subAccount?.webPassword) {
            const isMatch = await verifyAndUpgradePassword(password, subAccount.webPassword, SubAccount, subAccount._id);
            if (isMatch) {
                if (subAccount.status !== 'active') {
                    await logLoginFailure(req, username, 'SUSPENDED', 'حساب العميل الفرعي معلق حالياً');
                    return renderLogin(res, 'حساب العميل الفرعي معلق حالياً.');
                }
                if (await guardWebMfa(req, res, subAccount, 'sub_client', () => loginAsClient(req, res, subAccount, 'sub_client'))) return;
                const todayStr = getTodayString();
                if (subAccount.lastOtpDate === todayStr || shouldBypassClientOtp()) {
                    return loginAsClient(req, res, subAccount, 'sub_client');
                }
                return startClientOtp(req, res, subAccount, 'sub_client', SubAccount);
            }
        }

        const todayStr = getTodayString();
        const clientUser = await User.findOne(personLookup(username)).lean();
        if (clientUser?.webPassword) {
            const isMatch = await verifyAndUpgradePassword(password, clientUser.webPassword, User, clientUser._id);
            if (isMatch) {
                if (clientUser.status !== 'active') {
                    await logLoginFailure(req, username, 'SUSPENDED', 'حساب العميل معلق حالياً');
                    return renderLogin(res, 'حساب العميل معلق حالياً.');
                }
                if (await guardWebMfa(req, res, clientUser, 'user', () => loginAsClient(req, res, clientUser, 'user'))) return;
                if (clientUser.lastOtpDate === todayStr || shouldBypassClientOtp()) {
                    return loginAsClient(req, res, clientUser, 'user');
                }
                return startClientOtp(req, res, clientUser, 'user', User);
            }
        }

        const clientCompany = await ClientEmployee.findOne(personLookup(username)).lean();
        if (clientCompany?.webPassword) {
            const isMatch = await verifyAndUpgradePassword(password, clientCompany.webPassword, ClientEmployee, clientCompany._id);
            if (isMatch) {
                if (clientCompany.status !== 'active') {
                    await logLoginFailure(req, username, 'SUSPENDED', 'حساب الشركة معلق حالياً');
                    return renderLogin(res, 'حساب الشركة معلق حالياً.');
                }
                if (await guardWebMfa(req, res, clientCompany, 'company', () => loginAsClient(req, res, clientCompany, 'company'))) return;
                if (clientCompany.lastOtpDate === todayStr || shouldBypassClientOtp()) {
                    return loginAsClient(req, res, clientCompany, 'company');
                }
                return startClientOtp(req, res, clientCompany, 'company', ClientEmployee);
            }
        }

        const agentStaff = await AgentEmployee.findOne(personLookup(username)).lean();
        if (agentStaff?.webPassword) {
            const isMatch = await verifyAndUpgradePassword(password, agentStaff.webPassword, AgentEmployee, agentStaff._id);
            if (isMatch) {
                if (agentStaff.status !== 'active') {
                    await logLoginFailure(req, username, 'SUSPENDED', 'حساب موظف الوكيل معلق حالياً');
                    return renderLogin(res, 'حساب موظف الوكيل معلق حالياً.');
                }
                const agent = await User.findById(agentStaff.agentId).select('status role').lean();
                if (!agent || agent.status !== 'active' || agent.role !== 'agent') {
                    await logLoginFailure(req, username, 'SUSPENDED', 'حساب الوكيل الرئيسي غير نشط');
                    return renderLogin(res, 'حساب الوكيل الرئيسي غير نشط.');
                }
                if (await guardWebMfa(req, res, agentStaff, 'agent_staff', () => loginAsClient(req, res, agentStaff, 'agent_staff'))) return;
                if (agentStaff.lastOtpDate === todayStr || shouldBypassClientOtp()) {
                    return loginAsClient(req, res, agentStaff, 'agent_staff');
                }
                return startClientOtp(req, res, agentStaff, 'agent_staff', AgentEmployee);
            }
        }

        await logLoginFailure(req, username, 'INVALID_CREDENTIALS', 'بيانات الدخول غير صحيحة');
        return renderLogin(res, 'بيانات الدخول غير صحيحة.');
    } catch (error) {
        console.error('[Unified Login] login failed:', error.message);
        return renderLogin(res, 'حدث خطأ داخلي في الخادم.');
    }
});

router.post('/api/password-reset/start', passwordResetLimiter, async (req, res) => {
    try {
        const username = req.body.username?.trim();
        const phone = req.body.phone?.trim();

        if (!username || !phone) {
            return res.status(400).json({ success: false, error: 'يرجى إدخال اسم المستخدم ورقم الهاتف.' });
        }

        const resetAccount = await findPasswordResetAccount(username, phone);
        if (!resetAccount) {
            return res.status(404).json({ success: false, error: 'لا يوجد حساب عميل مطابق لاسم المستخدم ورقم الهاتف.' });
        }
        if (resetAccount.blocked) {
            return res.status(403).json({ success: false, error: resetAccount.reason });
        }

        const existingPending = await PasswordResetRequest.findOne({
            accountType: resetAccount.accountType,
            accountId: resetAccount.account._id,
            status: 'pending_admin'
        }).lean();

        if (existingPending) {
            return res.status(409).json({ success: false, error: 'يوجد طلب استعادة قيد مراجعة الإدارة لهذا الحساب.' });
        }

        await PasswordResetRequest.updateMany(
            {
                accountType: resetAccount.accountType,
                accountId: resetAccount.account._id,
                status: { $in: ['otp_sent', 'otp_verified'] }
            },
            { $set: { status: 'expired' } }
        );

        const otp = generateOtp();
        const resetRequest = await PasswordResetRequest.create({
            accountType: resetAccount.accountType,
            accountModel: resetAccount.accountModel,
            accountId: resetAccount.account._id,
            username: resetAccount.account.webUsername,
            phone: resetAccount.phone,
            name: resetAccount.name,
            masterName: resetAccount.masterName,
            otpCode: hashOtp(otp),
            otpExpires: new Date(Date.now() + 10 * 60 * 1000),
            accountSnapshot: {
                ...sanitizeAccountSnapshot(resetAccount.account),
                accountType: resetAccount.accountType,
                masterName: resetAccount.masterName
            }
        });

        let delivery;
        try {
            const { sendOtp } = require('../services/whatsappService');
            delivery = await sendOtp({
                phone: resetAccount.phone,
                otp,
                expiresMinutes: 10,
                accountName: resetAccount.name,
                accountType: 'استعادة كلمة المرور'
            });
        } catch (error) {
            delivery = { success: false, code: 'WHATSAPP_OTP_FAILED', message: error.message };
        }

        if (!delivery?.success) {
            resetRequest.status = 'expired';
            resetRequest.otpCode = undefined;
            await resetRequest.save();
            return res.status(503).json({
                success: false,
                error: 'تعذر إرسال رمز الاستعادة عبر واتساب. حاول لاحقاً أو راجع الدعم.',
                code: delivery?.code || 'WHATSAPP_OTP_FAILED'
            });
        }

        return res.json({
            success: true,
            requestId: resetRequest._id,
            message: 'تم إرسال رمز التحقق على واتساب.'
        });
    } catch (error) {
        console.error('[Password Reset] start failed:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ أثناء بدء الاستعادة.' });
    }
});

router.post('/api/password-reset/verify-otp', passwordResetLimiter, async (req, res) => {
    try {
        const requestId = req.body.requestId?.trim();
        const otp = req.body.otp?.trim();

        if (!requestId || !otp) {
            return res.status(400).json({ success: false, error: 'يرجى إدخال رمز التحقق.' });
        }

        const resetRequest = await PasswordResetRequest.findById(requestId);
        if (!resetRequest || resetRequest.status !== 'otp_sent') {
            return res.status(404).json({ success: false, error: 'طلب الاستعادة غير صالح أو منتهي.' });
        }

        if (!resetRequest.otpExpires || resetRequest.otpExpires < new Date()) {
            resetRequest.status = 'expired';
            await resetRequest.save();
            return res.status(410).json({ success: false, error: 'انتهت صلاحية رمز التحقق. ابدأ الطلب من جديد.' });
        }

        if (!verifyOtp(otp, resetRequest.otpCode)) {
            return res.status(400).json({ success: false, error: 'رمز التحقق غير صحيح.' });
        }

        resetRequest.status = 'otp_verified';
        resetRequest.otpVerifiedAt = new Date();
        resetRequest.otpCode = undefined;
        await resetRequest.save();

        return res.json({ success: true, message: 'تم التحقق من الرمز بنجاح.' });
    } catch (error) {
        console.error('[Password Reset] otp verify failed:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ أثناء التحقق من الرمز.' });
    }
});

router.post('/api/password-reset/submit', passwordResetLimiter, async (req, res) => {
    try {
        const requestId = req.body.requestId?.trim();
        const newPassword = req.body.newPassword?.trim();
        const confirmPassword = req.body.confirmPassword?.trim();

        if (!requestId || !newPassword || !confirmPassword) {
            return res.status(400).json({ success: false, error: 'يرجى إدخال كلمة المرور الجديدة وتأكيدها.' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ success: false, error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.' });
        }
        if (newPassword !== confirmPassword) {
            return res.status(400).json({ success: false, error: 'كلمتا المرور غير متطابقتين.' });
        }

        const resetRequest = await PasswordResetRequest.findById(requestId);
        if (!resetRequest || resetRequest.status !== 'otp_verified') {
            return res.status(404).json({ success: false, error: 'طلب الاستعادة غير صالح أو لم يتم التحقق منه.' });
        }

        resetRequest.pendingPasswordHash = await bcrypt.hash(newPassword, 12);
        resetRequest.status = 'pending_admin';
        await resetRequest.save();

        const ticket = await createPasswordResetTicket(resetRequest);
        resetRequest.ticketId = ticket._id;
        await resetRequest.save();

        try {
            const Notification = require('../models/Notification');
            await Notification.create({
                title: 'طلب استعادة كلمة مرور',
                message: `طلب جديد من ${resetRequest.name} بانتظار تأكيد الإدارة.`,
                txId: resetRequest.requestId
            });
        } catch (error) {
            console.warn('[Password Reset] notification skipped:', error.message);
        }

        return res.json({
            success: true,
            message: 'تم إرسال الطلب إلى الإدارة. سيتم تفعيل كلمة المرور الجديدة بعد الموافقة.'
        });
    } catch (error) {
        console.error('[Password Reset] submit failed:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ أثناء إرسال الطلب للإدارة.' });
    }
});

router.get('/logout', async (req, res) => {
    try {
        let userId = null;
        let performedByModel = 'System';
        let performedByName = 'System';

        if (req.session.adminId) {
            userId = req.session.adminId;
            performedByModel = 'Admin';
            performedByName = req.session.adminName;
        } else if (req.session.clientId) {
            userId = req.session.clientId;
            performedByModel = req.session.accountType === 'company'
                ? 'ClientEmployee'
                : (req.session.accountType === 'agent_staff' ? 'AgentEmployee' : (req.session.accountType === 'sub_client' ? 'SubAccount' : 'User'));
            performedByName = req.session.adminName || 'عميل';
        } else if (req.session.executorId) {
            userId = req.session.executorId;
            performedByModel = 'Employee';
            performedByName = req.session.adminName || 'منفذ';
        }

        await logAction({
            action: 'LOGOUT',
            req,
            performedById: userId,
            performedByModel,
            performedByName
        });
    } catch (e) {
        console.error('Failed to log logout:', e);
    }

    req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
