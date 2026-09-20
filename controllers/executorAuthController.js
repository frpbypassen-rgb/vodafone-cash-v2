const Employee = require('../models/Employee');
const RegistrationRequest = require('../models/RegistrationRequest');
const Admin = require('../models/Admin');
const { escapeRegex, verifyAndUpgradePassword, getTodayString } = require('../utils/helpers');
const { verifyOtp } = require('../utils/otp');
const accountMfaService = require('../services/accountMfaService');
const { logAction } = require('../services/auditService');
const securityControl = require('../services/securityControlService');
const { establishAuthenticatedSession } = require('../utils/sessionSecurity');
const { isLoginOtpRequired, issueLoginOtp, getLoginOtpPortal } = require('../services/loginOtpService');
const {
    ExecutorAccountError,
    normalizeExecutorPhone,
    normalizeExecutorUsername
} = require('../services/executorAccountService');
const {
    getExecutorServiceOptions,
    normalizeExecutorServiceKey
} = require('../utils/executorServiceCatalog');

// Do not leave an authenticated-password step open indefinitely while waiting
// for the Authenticator code.
const EXECUTOR_MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

const executorRegistrationFormData = (body = {}) => ({
    companyName: String(body.companyName || '').trim(),
    managerName: String(body.managerName || '').trim(),
    phone: String(body.phone || '').trim(),
    webUsername: String(body.webUsername || '').trim().replace(/@ahram\.com$/i, ''),
    executorServiceKey: normalizeExecutorServiceKey(body.executorServiceKey || 'vodafone')
});

const renderExecutorRegistration = (res, { error = null, success = null, formData = {} } = {}) => (
    res.render('executor/register', {
        error,
        success,
        formData,
        executorServiceOptions: getExecutorServiceOptions()
    })
);


const completeExecutorLogin = async (req, res, executor, { showMfaNotice = false, authenticatorVerified = false } = {}) => {
    delete req.session.pendingExecutorMfaId;
    delete req.session.pendingExecutorMfaStartedAt;
    const principal = {
        principalType: 'executor',
        principalId: String(executor._id),
        principalName: executor.name || 'منفذ'
    };
    const authorization = await securityControl.authorizeLogin({
        req,
        res,
        principal,
        accountClass: 'account',
        allowFirstDevice: true,
        authenticatorVerified
    });
    if (!authorization.allowed) {
        return res.render('executor/login', {
            error: authorization.message,
            mfaRequired: false,
            mfaNotice: false,
            submittedUsername: executor.webUsername || ''
        });
    }
    await establishAuthenticatedSession(req, {
        isExecutorLoggedIn: true,
        executorId: executor._id,
        executorGroupId: executor.groupId ? executor.groupId._id : null,
        executorName: executor.name || 'منفذ'
    });
    if (showMfaNotice) req.session.showMfaEnableNotice = true;
    await securityControl.applySessionSecurity(req, principal, 'account');
    await logAction({
        action: 'LOGIN_SUCCESS',
        req,
        performedById: executor._id,
        performedByModel: 'Employee',
        performedByName: executor.name,
        metadata: { role: executor.role, groupId: req.session.executorGroupId, mfaEnabled: accountMfaService.isEnabled(executor) }
    });
    return req.session.save(() => res.redirect('/executor-portal/dashboard'));
};

const startExecutorOtp = async (req, res, executor) => {
    const issued = await issueLoginOtp({ account: executor, accountType: 'executor', session: req.session });
    const portal = issued.portal || getLoginOtpPortal('executor');
    if (issued.status === 'reuse') {
        return req.session.save(() => res.redirect(portal.verifyPath));
    }
    if (issued.status === 'emergency_bypass') {
        await logAction({
            action: 'LOGIN_OTP_EMERGENCY_BYPASS',
            req,
            performedById: executor._id,
            performedByModel: 'Employee',
            performedByName: executor.name,
            success: true,
            metadata: {
                accountType: 'executor',
                deliveryFailureCode: issued.code,
                emergencyExpiresAt: issued.emergencyExpiresAt
            }
        });
        return completeExecutorLogin(req, res, executor, { showMfaNotice: true });
    }
    if (issued.status !== 'sent') {
        return res.render('executor/login', {
            error: issued.message || 'تعذر إرسال رمز التحقق عبر واتساب حالياً.',
            mfaRequired: false,
            mfaNotice: false,
            submittedUsername: executor.webUsername || ''
        });
    }
    await establishAuthenticatedSession(req, {
        tempExecutorId: executor._id,
        tempAccountType: 'executor',
        otpChallengeId: issued.otpChallengeId,
        pendingSecurityLocation: securityControl.parseLocation(req),
        pendingSecurityUsername: executor.webUsername || String(req.body.username || '')
    });
    return req.session.save(() => res.redirect(portal.verifyPath));
};

const continueExecutorAfterPassword = async (req, res, executor, options = {}) => {
    if (isLoginOtpRequired()) return startExecutorOtp(req, res, executor);
    return completeExecutorLogin(req, res, executor, options);
};

exports.getLogin = (req, res) => {
    if (req.session.isExecutorLoggedIn) return res.redirect('/executor-portal/dashboard');
    res.render('executor/login', { error: null, mfaRequired: false, mfaNotice: false, submittedUsername: '' });
};

exports.postLogin = async (req, res) => {
    try {
        const username = req.body.username?.trim();
        const password = req.body.password?.trim();
        const mfaToken = String(req.body.mfaToken || '').trim();
        const pendingMfaId = req.session.pendingExecutorMfaId;

        // A pending challenge may only be completed with its Authenticator code;
        // do not allow a second password submission to bypass that state.
        if (pendingMfaId && !mfaToken) {
            return res.render('executor/login', {
                error: 'أدخل رمز Authenticator لإكمال الدخول.',
                mfaRequired: true,
                mfaNotice: false,
                submittedUsername: ''
            });
        }

        if (mfaToken && pendingMfaId) {
            const challengeStartedAt = Number(req.session.pendingExecutorMfaStartedAt || 0);
            if (!challengeStartedAt || Date.now() - challengeStartedAt > EXECUTOR_MFA_CHALLENGE_TTL_MS) {
                delete req.session.pendingExecutorMfaId;
                delete req.session.pendingExecutorMfaStartedAt;
                return req.session.save(() => res.render('executor/login', {
                    error: 'انتهت مهلة التحقق. أدخل اسم المستخدم وكلمة المرور مرة أخرى.',
                    mfaRequired: false,
                    mfaNotice: false,
                    submittedUsername: ''
                }));
            }
            const executor = await Employee.findById(pendingMfaId).populate('groupId');
            if (!executor) {
                delete req.session.pendingExecutorMfaId;
                delete req.session.pendingExecutorMfaStartedAt;
                return req.session.save(() => res.render('executor/login', { error: 'انتهت جلسة الدخول، أعد المحاولة.', mfaRequired: false, mfaNotice: false, submittedUsername: '' }));
            }
            const mfaAccount = await accountMfaService.loadAccount('executor', executor._id, executor.tenantId || null);
            if (!mfaAccount || !accountMfaService.isEnabled(mfaAccount)) {
                return continueExecutorAfterPassword(req, res, executor, { showMfaNotice: true });
            }
            const valid = await accountMfaService.verifyAccountToken(mfaAccount, mfaToken);
            if (!valid) {
                return res.render('executor/login', {
                    error: 'رمز Authenticator غير صحيح.',
                    mfaRequired: true,
                    mfaNotice: false,
                    submittedUsername: executor.webUsername || ''
                });
            }
            delete req.session.pendingExecutorMfaId;
            return completeExecutorLogin(req, res, executor, { authenticatorVerified: true });
        }

        if (!username || !password) return res.render('executor/login', { error: 'يرجى إدخال البيانات.', mfaRequired: false, mfaNotice: false, submittedUsername: '' });

        const safeUsername = escapeRegex(username);
        const usernameRegex = new RegExp('^' + safeUsername + '$', 'i');

        const executor = await Employee.findOne({
            $or: [{ webUsername: usernameRegex }, { phone: username }]
        }).populate('groupId').lean();

        if (!executor) return res.render('executor/login', { error: 'اسم المستخدم أو كلمة المرور غير صحيحة.', mfaRequired: false, mfaNotice: false, submittedUsername: '' });

        const isMatch = await verifyAndUpgradePassword(password, executor.webPassword, Employee, executor._id);
        if (!isMatch) return res.render('executor/login', { error: 'اسم المستخدم أو كلمة المرور غير صحيحة.', mfaRequired: false, mfaNotice: false, submittedUsername: '' });

        if (executor.status !== 'active' || !executor.groupId || executor.groupId.status !== 'active') {
            return res.render('executor/login', { error: 'حسابك أو مجموعة التنفيذ غير مفعلة حالياً.', mfaRequired: false, mfaNotice: false, submittedUsername: '' });
        }

        const mfaAccount = await accountMfaService.loadAccount('executor', executor._id, executor.tenantId || null);
        if (mfaAccount && accountMfaService.isEnabled(mfaAccount)) {
            req.session.pendingExecutorMfaId = String(executor._id);
            req.session.pendingExecutorMfaStartedAt = Date.now();
            return req.session.save(() => res.render('executor/login', {
                error: null,
                mfaRequired: true,
                mfaNotice: false,
                submittedUsername: executor.webUsername || ''
            }));
        }

        return continueExecutorAfterPassword(req, res, executor, { showMfaNotice: true });
    } catch (e) {
        console.error(e);
        res.render('executor/login', { error: 'حدث خطأ في النظام.', mfaRequired: false, mfaNotice: false, submittedUsername: '' });
    }
};

exports.getRegister = (req, res) => {
    if (req.session.isExecutorLoggedIn) return res.redirect('/executor-portal/dashboard');
    renderExecutorRegistration(res);
};

exports.postRegister = async (req, res) => {
    const formData = executorRegistrationFormData(req.body);
    try {
        const companyName = formData.companyName;
        const managerName = formData.managerName;
        const { webPassword, confirmPassword } = req.body;
        
        if (!companyName || !managerName || !formData.phone || !formData.webUsername || !formData.executorServiceKey || !webPassword || !confirmPassword) {
            return renderExecutorRegistration(res, { error: 'يرجى ملء جميع الحقول المطلوبة.', formData });
        }
        if (companyName.length < 3 || managerName.length < 3) {
            return renderExecutorRegistration(res, { error: 'يرجى إدخال اسم المنفذ واسم المسؤول بشكل كامل.', formData });
        }
        if (webPassword !== confirmPassword) {
            return renderExecutorRegistration(res, { error: 'كلمات المرور غير متطابقة.', formData });
        }
        if (String(webPassword).length < 6) {
            return renderExecutorRegistration(res, { error: 'كلمة المرور يجب ألا تقل عن 6 أحرف.', formData });
        }

        const finalUsername = normalizeExecutorUsername(formData.webUsername);
        const phone = normalizeExecutorPhone(formData.phone);
        const usernameRegex = new RegExp(`^${escapeRegex(finalUsername)}$`, 'i');
        
        const existingEmployee = await Employee.exists({ webUsername: usernameRegex });
        if (existingEmployee) {
            return renderExecutorRegistration(res, { error: 'اسم المستخدم مسجل مسبقاً، يرجى اختيار اسم آخر.', formData });
        }
        
        const existingRequest = await RegistrationRequest.findOne({
            status: 'pending',
            $or: [{ phone }, { username: usernameRegex }]
        }).lean();
        if (existingRequest) {
            return renderExecutorRegistration(res, {
                error: `يوجد طلب تسجيل سابق بهذه البيانات برقم مرجعي: ${existingRequest.refCode}. يرجى انتظار المراجعة.`,
                formData
            });
        }

        const regRequest = await RegistrationRequest.create({
            accountType: 'executor',
            tenantId: (req.tenant && req.tenant._id) || undefined,
            fullName: managerName,
            phone: phone,
            username: finalUsername,
            password: webPassword,
            companyName: companyName,
            executorServiceKey: formData.executorServiceKey,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
            userAgent: req.headers['user-agent'] || 'unknown'
        });

        try {
            const Notification = require('../models/Notification');
            const admins = await Admin.find({});
            for (const admin of admins) {
                await Notification.create({
                    userId: admin.webUsername || 'admin',
                    title: 'طلب تسجيل منفذ جديد',
                    message: `🚨 طلب تسجيل منفذ جديد!\n\nالشركة: ${companyName}\nالمدير: ${managerName}\nالهاتف: ${phone}\nالخدمة: ${formData.executorServiceKey}\nرقم الطلب: ${regRequest.refCode}`,
                    type: 'registration'
                }).catch(() => {});
            }
        } catch (err) { }
        
        return renderExecutorRegistration(res, {
            success: { refCode: regRequest.refCode, username: finalUsername },
            formData: {}
        });
    } catch (e) {
        console.error(e);
        const errorMessage = e instanceof ExecutorAccountError
            ? e.message
            : 'حدث خطأ داخلي، يرجى المحاولة لاحقاً.';
        return renderExecutorRegistration(res, { error: errorMessage, formData });
    }
};

exports.getVerify = (req, res) => {
    if (!req.session.tempExecutorId) return res.redirect('/login');
    res.render('executor/verify', { error: null });
};

exports.postVerify = async (req, res) => {
    try {
        const otp = String(req.body.otp || '').trim();
        const accountId = req.session.tempExecutorId;
        const otpChallengeId = String(req.session.otpChallengeId || '');
        if (!accountId || !otpChallengeId || !otp) return res.redirect('/login');

        const account = await Employee.findById(accountId).lean();
        const otpAccepted = Boolean(
            account
            && account.otpChallengeId === otpChallengeId
            && account.otpExpires
            && new Date(account.otpExpires) >= new Date()
            && verifyOtp(otp, account.otpCode)
        );
        if (!otpAccepted) {
            if (account) {
                const updated = await Employee.findOneAndUpdate(
                    { _id: account._id, otpChallengeId },
                    { $inc: { otpAttempts: 1 } },
                    { new: true }
                ).lean();
                if (Number(updated?.otpAttempts || 0) >= 5) {
                    await Employee.updateOne(
                        { _id: account._id, otpChallengeId },
                        { $unset: { otpCode: 1, otpExpires: 1, otpChallengeId: 1, otpIssuedAt: 1, otpAttempts: 1 } }
                    );
                    return res.render('executor/verify', { error: 'تم تجاوز عدد المحاولات. سجل الدخول من جديد للحصول على رمز آخر.' });
                }
            }
            return res.render('executor/verify', { error: 'الرمز غير صحيح أو انتهت صلاحيته.' });
        }

        const consumedAccount = await Employee.findOneAndUpdate(
            {
                _id: account._id,
                otpCode: account.otpCode,
                otpChallengeId,
                otpExpires: { $gte: new Date() }
            },
            {
                $set: { lastOtpDate: getTodayString() },
                $unset: { otpCode: 1, otpExpires: 1, otpChallengeId: 1, otpIssuedAt: 1, otpAttempts: 1 }
            },
            { new: true }
        ).populate('groupId').lean();
        if (!consumedAccount) {
            return res.render('executor/verify', { error: 'تم استخدام الرمز أو انتهت صلاحيته. سجل الدخول من جديد.' });
        }

        delete req.session.tempExecutorId;
        delete req.session.otpChallengeId;
        delete req.session.tempAccountType;
        return completeExecutorLogin(req, res, consumedAccount, { showMfaNotice: true });
    } catch (e) {
        console.error('[Executor OTP] verify failed:', e.message);
        return res.render('executor/verify', { error: 'تعذر إكمال التحقق. أعد المحاولة.' });
    }
};

exports.logout = (req, res) => { req.session.destroy(); res.redirect('/login'); };
