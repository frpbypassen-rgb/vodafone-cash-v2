const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const rateLimit = require('express-rate-limit');
const { escapeRegex, verifyAndUpgradePassword } = require('../utils/helpers');
const { generateOtp, hashOtp, verifyOtp } = require('../utils/otp');
const {
    getEmergencyClientOtpBypassState,
    isPasskeyRequired,
    isSecurityVerificationRequired
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
const operationPinService = require('../services/operationPinService');
const { findByCredentials } = require('../repositories/userRepository');
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
const ACCOUNT_MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ACCOUNT_MFA_MODELS = {
    user: User,
    company: ClientEmployee,
    sub_client: SubAccount,
    agent_staff: AgentEmployee
};

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
    const canonicalType = ({ user: 'client_user', company: 'client_company' })[accountType] || accountType;
    const mfaAccount = await accountMfaService.loadAccount(
        canonicalType,
        account._id,
        account.tenantId || (req.tenant && req.tenant._id) || null
    );
    if (!mfaAccount || !accountMfaService.isEnabled(mfaAccount)) return false;

    const token = String(req.body.mfaToken || '').trim();
    if (token && await accountMfaService.verifyAccountToken(mfaAccount, token)) {
        await onVerified();
        return true;
    }

    renderLogin(res, token ? 'رمز Authenticator غير صحيح.' : 'أدخل رمز Authenticator لإكمال الدخول.', {
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
    return loginAsExecutor(req, res, executor, { authenticatorVerified: true });
};

const renderAccountMfaChallenge = (res, error = null, username = '') => renderLogin(res, error, {
    mfaRequired: true,
    accountMfaChallenge: true,
    submittedUsername: username
});

const beginAccountMfaChallenge = async (req, res, account, accountType) => {
    const canonicalType = ({ user: 'client_user', company: 'client_company' })[accountType] || accountType;
    const mfaAccount = await accountMfaService.loadAccount(canonicalType, account._id, account.tenantId || null);
    if (!mfaAccount || !accountMfaService.isEnabled(mfaAccount)) return false;
    req.session.pendingAccountMfaLogin = {
        accountId: String(account._id),
        accountType,
        username: account.webUsername || String(req.body.username || ''),
        createdAt: Date.now()
    };
    req.session.pendingSecurityLocation = securityControl.parseLocation(req);
    await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
    renderAccountMfaChallenge(res, null, req.session.pendingAccountMfaLogin.username);
    return true;
};

const completeAccountMfaChallenge = async (req, res) => {
    const pending = req.session.pendingAccountMfaLogin;
    if (!pending?.accountId || !ACCOUNT_MFA_MODELS[pending.accountType]) return false;
    if (Date.now() - Number(pending.createdAt || 0) > ACCOUNT_MFA_CHALLENGE_TTL_MS) {
        delete req.session.pendingAccountMfaLogin;
        delete req.session.pendingSecurityLocation;
        await new Promise((resolve) => req.session.save(resolve));
        return renderLogin(res, 'انتهت مهلة التحقق. أدخل اسم المستخدم وكلمة المرور مرة أخرى.');
    }
    const Model = ACCOUNT_MFA_MODELS[pending.accountType];
    const account = await Model.findById(pending.accountId).lean();
    if (!account || account.status !== 'active') {
        delete req.session.pendingAccountMfaLogin;
        return renderLogin(res, 'الحساب غير مفعّل حالياً.');
    }
    if (pending.accountType === 'agent_staff') {
        const agent = await User.findById(account.agentId).select('status role').lean();
        if (!agent || agent.status !== 'active' || agent.role !== 'agent') {
            delete req.session.pendingAccountMfaLogin;
            return renderLogin(res, 'حساب الوكيل الرئيسي غير نشط.');
        }
    }
    const canonicalType = ({ user: 'client_user', company: 'client_company' })[pending.accountType] || pending.accountType;
    const mfaAccount = await accountMfaService.loadAccount(canonicalType, account._id, account.tenantId || null);
    if (!mfaAccount || !accountMfaService.isEnabled(mfaAccount)) {
        delete req.session.pendingAccountMfaLogin;
        return loginAsClient(req, res, account, pending.accountType);
    }
    const token = String(req.body.mfaToken || '').trim();
    if (!token || !(await accountMfaService.verifyAccountToken(mfaAccount, token))) {
        return renderAccountMfaChallenge(res, 'رمز Authenticator غير صحيح.', pending.username);
    }
    delete req.session.pendingAccountMfaLogin;
    return loginAsClient(req, res, account, pending.accountType, { authenticatorVerified: true });
};

// A deployment can invalidate the server-side session while the browser still
// carries a secure cookie from the previous process.  Give the login page a
// deterministic recovery path that destroys both sides of that stale session
// instead of leaving the visitor in a redirect loop.
const resetLoginSession = (req, res) => {
    const finish = () => {
        res.clearCookie('ahram.sid', {
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            secure: req.secure || process.env.SECURE_COOKIE === 'true'
        });
        return res.redirect(303, '/login?reset=done');
    };
    if (!req.session) return finish();
    return req.session.destroy(finish);
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
        req.session.mfaEnrollmentRequired = false;
        await new Promise((resolve) => req.session.save(resolve));
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

router.get('/security/mfa-enroll', requireWebMfaContext, async (req, res) => {
    const { account } = req.webMfaContext;
    if (accountMfaService.isEnabled(account)) {
        return res.redirect(req.session.isExecutorLoggedIn ? '/executor-portal/dashboard' : '/client/dashboard');
    }
    return res.render('mfa_enroll_required', {
        principalName: securityControl.sessionPrincipal(req.session)?.principalName || 'الحساب',
        csrfToken: req.csrfToken?.() || '',
        returnUrl: req.session.isExecutorLoggedIn ? '/executor-portal/dashboard' : '/client/dashboard'
    });
});

const webOperationPinPrincipal = (req) => securityControl.sessionPrincipal(req.session);
router.get('/security/operation-pin/status', requireWebMfaContext, async (req, res) => {
    try {
        return res.json({ success: true, ...(await operationPinService.status(webOperationPinPrincipal(req))) });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر تحميل حالة رمز العمليات.' });
    }
});

router.post('/security/operation-pin/setup', requireWebMfaContext, async (req, res) => {
    try {
        const { account } = req.webMfaContext;
        if (!accountMfaService.isEnabled(account)
            || !(await accountMfaService.verifyAccountToken(account, String(req.body?.mfaToken || '')))) {
            return res.status(403).json({ success: false, error: 'أدخل رمز Authenticator الصحيح لتفعيل رمز العمليات.' });
        }
        const profile = await operationPinService.setupInitialPin({
            principal: webOperationPinPrincipal(req),
            pin: req.body?.pin,
            createdBy: webOperationPinPrincipal(req)?.principalName
        });
        return res.json({ success: true, profile, message: 'تم تفعيل رمز العمليات؛ تغييره لاحقاً عبر الإدارة فقط.' });
    } catch (error) {
        const message = error.code === 'OPERATION_PIN_ADMIN_ONLY'
            ? 'تغيير رمز العمليات متاح للإدارة فقط.'
            : 'يجب أن يكون الرمز من 4 إلى 6 أرقام.';
        return res.status(422).json({ success: false, code: error.code, error: message });
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
        SECURITY_ACCESS_REQUEST_EXPIRED: 'انتهت صلاحية طلب الجهاز. أعد محاولة تسجيل الدخول.',
        SECURITY_ADMIN_APPROVAL_REQUIRED: 'هذا الطلب يحتاج موافقة الإدارة حفاظاً على أمان الحساب.'
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

const loginAsAdmin = async (req, res, adminData = null, { authenticatorVerified = false } = {}) => {
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
        // A brand-new master administrator is the only bootstrap exception;
        // every ordinary administrator still requires an approved device.
        req, res, principal, accountClass: 'admin',
        allowFirstDevice: principal.principalType === 'master_admin',
        authenticatorVerified
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

const loginAsExecutor = async (req, res, executor, { showMfaEnableNotice = false, authenticatorVerified = false } = {}) => {
    const principal = { principalType: 'executor', principalId: String(executor._id), principalName: executor.name || 'منفذ' };
    const authorization = await securityControl.authorizeLogin({ req, res, principal, accountClass: 'account', allowFirstDevice: false, authenticatorVerified });
    if (!authorization.allowed) {
        await logLoginFailure(req, req.body.username, authorization.code, authorization.message);
        return renderLogin(res, authorization.message, { submittedUsername: String(req.body.username || '') });
    }
    if (await requirePasskeyLogin({ req, res, principal, authorization, accountClass: 'account', loginKind: 'executor' })) return;
    await completeExecutorSession(req, executor);
    if (!accountMfaService.isEnabled(executor)) {
        req.session.mfaEnrollmentRequired = true;
        return saveAndRedirect(req, res, '/auth/security/mfa-enroll');
    }
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
    if (!account.mfaEnabled || account.mfaType !== 'totp') {
        req.session.showMfaEnableNotice = true;
    }
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

const loginAsClient = async (req, res, account, accountType, { authenticatorVerified = false } = {}) => {
    const principalType = ({ user: 'client_user', company: 'client_company', agent_staff: 'agent_staff', sub_client: 'sub_client' })[accountType] || 'client_user';
    const principal = { principalType, principalId: String(account._id), principalName: account.name || account.webUsername || 'حساب عميل' };
    if (!securityControl.parseLocation(req)) {
        return renderLogin(res, 'يجب السماح بالوصول إلى موقع الجهاز لإكمال تسجيل الدخول بأمان.', {
            submittedUsername: String(req.body.username || '')
        });
    }
    const authorization = await securityControl.authorizeLogin({ req, res, principal, accountClass: 'account', allowFirstDevice: false, authenticatorVerified });
    if (!authorization.allowed) {
        await logLoginFailure(req, req.body.username, authorization.code, authorization.message);
        return renderLogin(res, authorization.message, { submittedUsername: String(req.body.username || '') });
    }
    if (await requirePasskeyLogin({ req, res, principal, authorization, accountClass: 'account', loginKind: 'client', accountType })) return;
    await completeClientSession(req, account, accountType);
    if (!accountMfaService.isEnabled(account)) {
        req.session.mfaEnrollmentRequired = true;
        return saveAndRedirect(req, res, '/auth/security/mfa-enroll');
    }

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
    if (req.query?.reset === '1') return resetLoginSession(req, res);
    const pendingExecutorMfa = req.session.pendingExecutorMfaLogin;
    if (pendingExecutorMfa?.executorId) {
        if (Date.now() - Number(pendingExecutorMfa.createdAt || 0) <= EXECUTOR_MFA_CHALLENGE_TTL_MS) {
            return renderExecutorMfaChallenge(res, null, pendingExecutorMfa.username || '');
        }
        delete req.session.pendingExecutorMfaLogin;
    }
    const pendingAccountMfa = req.session.pendingAccountMfaLogin;
    if (pendingAccountMfa?.accountId && Date.now() - Number(pendingAccountMfa.createdAt || 0) <= ACCOUNT_MFA_CHALLENGE_TTL_MS) {
        return renderAccountMfaChallenge(res, null, pendingAccountMfa.username || '');
    }
    delete req.session.pendingAccountMfaLogin;
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
        if (req.session.pendingAccountMfaLogin?.accountId) {
            return completeAccountMfaChallenge(req, res);
        }
        // Keep the unified endpoint compatible with the active web, mobile
        // webview and legacy portal forms during the temporary rollout.  Some
        // older clients submit webUsername/webPassword instead of the current
        // username/password names.  They are normalized here before any
        // credential verification; this does not relax password validation.
        const username = String(
            req.body?.username
            ?? req.body?.webUsername
            ?? req.body?.userName
            ?? req.body?.phone
            ?? ''
        ).trim();
        const password = String(
            req.body?.password
            ?? req.body?.webPassword
            ?? req.body?.userPassword
            ?? req.body?.pass
            ?? ''
        ).trim();
        req.body.username = username;
        req.body.password = password;

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
                if (await guardWebMfa(req, res, adminData, 'admin', () => loginAsAdmin(req, res, adminData, { authenticatorVerified: true }))) return;
                return loginAsAdmin(req, res, adminData);
            }
        }

        const tenantId = req.tenant?._id || null;
        let authResult = await findByCredentials(username, password, tenantId);
        if (!authResult && tenantId) {
            authResult = await findByCredentials(username, password, null);
        }

        if (authResult?.error === 'ACCOUNT_BANNED') {
            await logLoginFailure(req, username, 'SUSPENDED', 'الحساب غير مفعّل حالياً');
            if (authResult.accountType === 'executor') {
                return renderLogin(res, 'حساب التنفيذ أو مجموعة التنفيذ غير مفعلة حالياً.', { submittedUsername: username });
            }
            if (authResult.accountType === 'sub_client') {
                return renderLogin(res, 'حساب العميل الفرعي معلق حالياً.', { submittedUsername: username });
            }
            if (authResult.accountType === 'client_company') {
                return renderLogin(res, 'حساب الشركة معلق حالياً.', { submittedUsername: username });
            }
            if (authResult.accountType === 'agent_staff') {
                return renderLogin(res, 'حساب موظف الوكيل معلق حالياً.', { submittedUsername: username });
            }
            return renderLogin(res, 'حساب العميل معلق حالياً.', { submittedUsername: username });
        }

        if (authResult?.account && authResult?.accountType) {
            const { account, accountType } = authResult;

            if (accountType === 'executor') {
                const executor = await Employee.findById(account._id).populate('groupId').lean();
                if (!executor || executor.status !== 'active' || !executor.groupId || executor.groupId.status !== 'active') {
                    await logLoginFailure(req, username, 'SUSPENDED', 'حساب التنفيذ أو مجموعته غير مفعلة حالياً');
                    return renderLogin(res, 'حساب التنفيذ أو مجموعة التنفيذ غير مفعلة حالياً.', { submittedUsername: username });
                }
                if (await beginExecutorMfaChallenge(req, res, executor)) return;
                return loginAsExecutor(req, res, executor, { showMfaEnableNotice: true });
            }

            if (accountType === 'sub_client') {
                if (await beginAccountMfaChallenge(req, res, account, 'sub_client')) return;
                return loginAsClient(req, res, account, 'sub_client');
            }

            if (accountType === 'client_user') {
                if (await beginAccountMfaChallenge(req, res, account, 'user')) return;
                return loginAsClient(req, res, account, 'user');
            }

            if (accountType === 'client_company') {
                if (await beginAccountMfaChallenge(req, res, account, 'company')) return;
                return loginAsClient(req, res, account, 'company');
            }

            if (accountType === 'agent_staff') {
                const agent = await User.findById(account.agentId).select('status role').lean();
                if (!agent || agent.status !== 'active' || agent.role !== 'agent') {
                    await logLoginFailure(req, username, 'SUSPENDED', 'حساب الوكيل الرئيسي غير نشط');
                    return renderLogin(res, 'حساب الوكيل الرئيسي غير نشط.', { submittedUsername: username });
                }
                if (await beginAccountMfaChallenge(req, res, account, 'agent_staff')) return;
                return loginAsClient(req, res, account, 'agent_staff');
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
