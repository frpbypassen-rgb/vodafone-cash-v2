'use strict';

const { randomUUID } = require('crypto');
const { generateOtp, hashOtp } = require('../utils/otp');
const {
    getEmergencyClientOtpBypassState,
    shouldBypassClientOtp
} = require('../config/securityPolicy');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const SubAccount = require('../models/SubAccount');
const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const { isLoginOtpEnabledForAccount, selectLoginOtpChannel } = require('../utils/otpDeliveryChannel');

const LOGIN_OTP_PORTALS = Object.freeze({
    user: {
        Model: User,
        accountType: 'user',
        label: 'العميل',
        performedByModel: 'User',
        verifyPath: '/client/verify',
        sessionTempIdKey: 'tempClientId'
    },
    company: {
        Model: ClientEmployee,
        accountType: 'company',
        label: 'الشركة',
        performedByModel: 'ClientEmployee',
        verifyPath: '/client/verify',
        sessionTempIdKey: 'tempClientId'
    },
    agent_staff: {
        Model: AgentEmployee,
        accountType: 'agent_staff',
        label: 'موظف الوكيل',
        performedByModel: 'AgentEmployee',
        verifyPath: '/client/verify',
        sessionTempIdKey: 'tempClientId'
    },
    sub_client: {
        Model: SubAccount,
        accountType: 'sub_client',
        label: 'عميل الوكالة',
        performedByModel: 'SubAccount',
        verifyPath: '/client/verify',
        sessionTempIdKey: 'tempClientId'
    },
    executor: {
        Model: Employee,
        accountType: 'executor',
        label: 'المنفذ',
        performedByModel: 'Employee',
        verifyPath: '/executor-portal/verify',
        sessionTempIdKey: 'tempExecutorId'
    },
    admin: {
        Model: Admin,
        accountType: 'admin',
        label: 'الإدارة',
        performedByModel: 'Admin',
        verifyPath: '/admin/verify',
        sessionTempIdKey: 'tempAdminId'
    }
});

const OTP_UNSET = {
    otpCode: 1,
    otpExpires: 1,
    otpChallengeId: 1,
    otpIssuedAt: 1,
    otpAttempts: 1
};

const publicDeliveryMessage = (code, fallback) => {
    const normalized = String(code || 'WHATSAPP_OTP_FAILED').replace(/[^A-Z0-9_]/g, '');
    const messages = {
        WHATSAPP_PHONE_REQUIRED: 'لا يوجد رقم واتساب مسجّل لإرسال رمز التحقق. راجع الإدارة أو فعّل وضع الطوارئ الموثّق لمدة 24 ساعة.',
        WHATSAPP_PHONE_INVALID: 'رقم الواتساب المسجّل غير صالح لإرسال رمز التحقق. راجع الإدارة.',
        WHATCHIMP_CONFIG_MISSING: `إعداد واتساب غير مكتمل على الخادم. رمز الحالة: ${normalized}`,
        WHATCHIMP_DISABLED: `تكامل واتساب غير مفعّل. رمز الحالة: ${normalized}`,
        WHATCHIMP_OTP_TEMPLATE_NOT_APPROVED: `قالب رمز التحقق غير معتمد حالياً. رمز الحالة: ${normalized}`,
        WHATCHIMP_TIMEOUT: `انتهت مهلة إرسال واتساب. أعد المحاولة بعد دقيقة. رمز الحالة: ${normalized}`,
        WHATCHIMP_REQUEST_FAILED: `تعذر الاتصال بمزوّد واتساب. أعد المحاولة بعد دقيقة. رمز الحالة: ${normalized}`,
        EMAIL_OTP_ADDRESS_INVALID: 'البريد الإلكتروني المسجّل غير صالح لإرسال رمز التحقق. راجع الإدارة.',
        EMAIL_OTP_DISABLED: 'إرسال رمز التحقق عبر البريد متوقف. تواصل مع الإدارة.',
        LOGIN_OTP_NOT_ENABLED: 'رمز التحقق غير مفعّل لهذا الحساب. تابع تسجيل الدخول أو تواصل مع الإدارة إذا كنت تتوقع طلب الرمز.',
        WHATSAPP_LOGIN_OTP_DISABLED: 'رمز تسجيل الدخول عبر واتساب غير متاح. تواصل مع الإدارة لتفعيل رمز التحقق بالبريد عند الحاجة.',
        WHATSAPP_OTP_DISABLED: 'رمز التحقق عبر واتساب غير متاح. تواصل مع الإدارة.',
        SMTP_CONFIG_MISSING: `إعداد البريد غير مكتمل على الخادم. رمز الحالة: ${normalized}`,
        EMAIL_OTP_SEND_FAILED: `تعذر إرسال رمز التحقق عبر البريد. أعد المحاولة بعد دقيقة. رمز الحالة: ${normalized}`,
        EMAIL_OTP_TIMEOUT: `انتهت مهلة إرسال البريد. أعد المحاولة بعد دقيقة. رمز الحالة: ${normalized}`
    };
    if (messages[normalized]) return messages[normalized];
    return fallback || `تعذر إرسال رمز التحقق عبر واتساب حالياً. أعد المحاولة بعد دقيقة. رمز الحالة: ${normalized}`;
};

const getLoginOtpPortal = (accountType) => LOGIN_OTP_PORTALS[accountType] || null;

const isLoginOtpRequired = (env = process.env, now = Date.now()) => !shouldBypassClientOtp(env, now);

/**
 * OTP is an explicit per-account opt-in controlled by administration.
 * Accounts without the email channel use password-only login; WhatsApp is
 * never used for login OTP.
 */
const shouldSkipLoginOtp = (account = {}, accountType) => (
    accountType !== 'admin' && !isLoginOtpEnabledForAccount(account)
);
const shouldSkipLoginOtpWithoutEmail = shouldSkipLoginOtp;

const buildLoginOtpSkippedAudit = ({ account = {}, accountType, reason = 'not_enabled_by_admin' } = {}) => {
    const portal = getLoginOtpPortal(accountType);
    return {
        action: 'LOGIN_OTP_SKIPPED',
        performedById: account._id,
        performedByModel: portal?.performedByModel,
        performedByName: account.name || account.webUsername || '',
        success: true,
        severity: 'warning',
        metadata: {
            accountId: String(account._id || ''),
            portal: accountType,
            reason
        }
    };
};

const resendCooldownSeconds = () => Math.min(
    300,
    Math.max(30, Number(process.env.OTP_RESEND_COOLDOWN_SECONDS) || 60)
);

const hasReusableChallenge = ({ account, accountType, session = {} }) => {
    const portal = getLoginOtpPortal(accountType);
    if (!portal) return false;
    const pendingChallenge = String(session.otpChallengeId || '');
    const issuedAtMs = new Date(account.otpIssuedAt || 0).getTime();
    const cooldownActive = Number.isFinite(issuedAtMs)
        && (Date.now() - issuedAtMs) < (resendCooldownSeconds() * 1000);
    return (
        String(session[portal.sessionTempIdKey] || '') === String(account._id)
        && String(session.tempAccountType || '') === accountType
        && pendingChallenge
        && pendingChallenge === String(account.otpChallengeId || '')
        && account.otpExpires
        && new Date(account.otpExpires) > new Date()
        && cooldownActive
    );
};

const readLoginOtpAttempt = (req = {}) => {
    const headers = req.headers || {};
    const headerUa = headers['user-agent'] || headers['User-Agent'] || '';
    const fromGetter = typeof req.get === 'function' ? req.get('user-agent') : '';
    return {
        at: new Date(),
        userAgent: String(fromGetter || headerUa || '').replace(/[\r\n]+/g, ' ').trim(),
        loginAccount: String((req.body && req.body.username) || '').replace(/[\r\n]+/g, ' ').trim()
    };
};

const deliverLoginOtp = async ({ otp, accountName, account, expiresAt, attempt }) => {
    const selection = selectLoginOtpChannel(account || {});
    if (selection.code) {
        return {
            success: false,
            provider: selection.channel === 'email' ? 'smtp' : 'none',
            channel: selection.channel,
            code: selection.code
        };
    }
    if (selection.channel !== 'email') {
        return { success: false, provider: 'none', channel: 'disabled', code: 'LOGIN_OTP_NOT_ENABLED' };
    }
    if (selection.channel === 'email') {
        try {
            const { sendLoginOtpEmail } = require('./emailOtpMailer');
            return await sendLoginOtpEmail({
                to: selection.email,
                otp,
                expiresMinutes: 5,
                expiresAt,
                accountName: accountName || '',
                attemptAt: attempt && attempt.at,
                userAgent: attempt && attempt.userAgent,
                loginAccount: attempt && attempt.loginAccount
            });
        } catch (error) {
            return {
                success: false,
                provider: 'smtp',
                channel: 'email',
                code: error.code || 'EMAIL_OTP_SEND_FAILED'
            };
        }
    }

    return { success: false, provider: 'none', channel: 'disabled', code: 'LOGIN_OTP_NOT_ENABLED' };
};

const clearStoredOtp = async (Model, accountId) => {
    await Model.updateOne({ _id: accountId }, { $unset: OTP_UNSET }, { strict: false });
};

/**
 * Persist a hashed login OTP and deliver it by email only for accounts where
 * administration explicitly enabled the email channel. An invalid enabled
 * address or failed email delivery fails closed. WhatsApp is never used for
 * login OTP.
 */
const issueLoginOtp = async ({ account, accountType, session = {}, attempt = null }) => {
    const portal = getLoginOtpPortal(accountType);
    if (!portal) {
        return { status: 'unsupported', code: 'OTP_ACCOUNT_TYPE_UNSUPPORTED', message: 'نوع الحساب لا يدعم رمز التحقق.' };
    }
    if (shouldSkipLoginOtp(account, accountType)) {
        await clearStoredOtp(portal.Model, account._id);
        return { status: 'skip_no_email', portal, reason: 'not_enabled_by_admin' };
    }
    if (hasReusableChallenge({ account, accountType, session })) {
        return { status: 'reuse', portal, otpChallengeId: String(account.otpChallengeId) };
    }

    const otp = generateOtp();
    const otpExpires = new Date(Date.now() + 5 * 60 * 1000);
    const otpChallengeId = randomUUID();
    await portal.Model.updateOne(
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

    const delivery = await deliverLoginOtp({
        otp,
        accountName: account.name || account.webUsername || '',
        account,
        expiresAt: otpExpires,
        attempt
    });

    if (delivery?.success) {
        return { status: 'sent', portal, otpChallengeId, delivery };
    }

    await clearStoredOtp(portal.Model, account._id);
    const emergencyBypass = getEmergencyClientOtpBypassState();
    const code = delivery?.code || 'WHATSAPP_OTP_FAILED';
    if (emergencyBypass.active) {
        return {
            status: 'emergency_bypass',
            portal,
            delivery,
            code,
            emergencyExpiresAt: emergencyBypass.expiresAt
        };
    }
    return {
        status: 'failed',
        portal,
        delivery,
        code,
        message: publicDeliveryMessage(code, delivery?.message)
    };
};

module.exports = {
    LOGIN_OTP_PORTALS,
    buildLoginOtpSkippedAudit,
    clearStoredOtp,
    getLoginOtpPortal,
    hasReusableChallenge,
    isLoginOtpRequired,
    issueLoginOtp,
    publicDeliveryMessage,
    readLoginOtpAttempt,
    selectLoginOtpChannel,
    shouldSkipLoginOtp,
    shouldSkipLoginOtpWithoutEmail
};
