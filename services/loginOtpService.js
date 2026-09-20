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
        WHATCHIMP_REQUEST_FAILED: `تعذر الاتصال بمزوّد واتساب. أعد المحاولة بعد دقيقة. رمز الحالة: ${normalized}`
    };
    if (messages[normalized]) return messages[normalized];
    return fallback || `تعذر إرسال رمز التحقق عبر واتساب حالياً. أعد المحاولة بعد دقيقة. رمز الحالة: ${normalized}`;
};

const getLoginOtpPortal = (accountType) => LOGIN_OTP_PORTALS[accountType] || null;

const isLoginOtpRequired = (env = process.env, now = Date.now()) => !shouldBypassClientOtp(env, now);

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

const deliverLoginOtp = async ({ phone, otp, accountName, accountTypeLabel }) => {
    try {
        const { sendOtp } = require('./whatsappService');
        return await sendOtp({
            phone,
            otp,
            expiresMinutes: 5,
            accountName: accountName || '',
            accountType: accountTypeLabel
        });
    } catch (error) {
        return {
            success: false,
            provider: 'whatchimp',
            code: error.code || 'WHATSAPP_OTP_FAILED',
            message: error.message
        };
    }
};

const clearStoredOtp = async (Model, accountId) => {
    await Model.updateOne({ _id: accountId }, { $unset: OTP_UNSET }, { strict: false });
};

/**
 * Persist a hashed login OTP and attempt WhatsApp delivery.
 * Returns a status the HTTP layer can turn into a redirect, emergency login, or error.
 */
const issueLoginOtp = async ({ account, accountType, session = {} }) => {
    const portal = getLoginOtpPortal(accountType);
    if (!portal) {
        return { status: 'unsupported', code: 'OTP_ACCOUNT_TYPE_UNSUPPORTED', message: 'نوع الحساب لا يدعم رمز التحقق.' };
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
        phone: account.phone,
        otp,
        accountName: account.name || account.webUsername || '',
        accountTypeLabel: portal.label
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
    clearStoredOtp,
    getLoginOtpPortal,
    hasReusableChallenge,
    isLoginOtpRequired,
    issueLoginOtp,
    publicDeliveryMessage
};
