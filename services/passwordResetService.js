'use strict';

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { escapeRegex } = require('../utils/helpers');
const { generateOtp, hashOtp, verifyOtp } = require('../utils/otp');
const { isValidOtpEmail, resolveAccountOtpEmail } = require('../utils/otpDeliveryChannel');
const { passwordResetStartBody } = require('../utils/passwordResetAvailability');
const { logAction } = require('./auditService');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const PasswordResetRequest = require('../models/PasswordResetRequest');
const MobileDeviceSession = require('../models/MobileDeviceSession');

const PURPOSE = 'password_reset';
const TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const ACCOUNT_WINDOW_MS = 10 * 60 * 1000;
const ACCOUNT_MAX_SENDS = 5;

const resendCooldownMs = () => Math.min(
    300,
    Math.max(30, Number(process.env.OTP_RESEND_COOLDOWN_SECONDS) || 60)
) * 1000;

const opaqueId = () => new mongoose.Types.ObjectId().toString();

const phoneCandidates = (phone) => {
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
    const stored = phoneCandidates(storedPhone);
    const submitted = phoneCandidates(submittedPhone);
    return stored.some((phone) => submitted.includes(phone));
};

const usernameLookup = (username) => {
    const raw = String(username || '').trim();
    const candidates = [raw];
    if (raw && !raw.includes('@')) candidates.push(`${raw}@ahram.com`);
    return {
        $or: [...new Set(candidates.filter(Boolean))].map((value) => ({
            webUsername: new RegExp(`^${escapeRegex(value)}$`, 'i')
        }))
    };
};

const auditReset = async ({ req, action, account, success, errorCode }) => {
    try {
        await logAction({
            action,
            req,
            performedById: account && account._id,
            performedByModel: account && account.accountModel,
            performedByName: account && (account.name || account.username || ''),
            targetId: account && account._id,
            targetModel: account && account.accountModel,
            success,
            errorCode: errorCode || '',
            severity: success ? 'info' : 'warning',
            metadata: { purpose: PURPOSE }
        });
    } catch (_error) {
        // Audit failure must not change the public response or include the code.
    }
};

const findResetAccount = async (username, phone) => {
    const user = await User.findOne(usernameLookup(username)).lean();
    if (user && phoneMatches(user.phone, phone) && (user.role || 'user') !== 'agent') {
        return {
            accountType: 'user',
            accountModel: 'User',
            Model: User,
            mobileAccountType: 'client_user',
            _id: user._id,
            name: user.name || user.webUsername,
            username: user.webUsername,
            phone: user.phone,
            email: resolveAccountOtpEmail(user)
        };
    }

    const subAccount = await SubAccount.findOne(usernameLookup(username)).lean();
    if (subAccount && phoneMatches(subAccount.phone, phone) && subAccount.masterType === 'user') {
        return {
            accountType: 'sub_client',
            accountModel: 'SubAccount',
            Model: SubAccount,
            mobileAccountType: 'sub_client',
            _id: subAccount._id,
            name: subAccount.name || subAccount.webUsername,
            username: subAccount.webUsername,
            phone: subAccount.phone,
            email: resolveAccountOtpEmail(subAccount)
        };
    }

    return null;
};

const publicStart = (requestId) => passwordResetStartBody(requestId || opaqueId());

const startPasswordReset = async ({ username, phone, req } = {}) => {
    const account = await findResetAccount(username, phone);
    if (!account || !isValidOtpEmail(account.email)) {
        await auditReset({
            req,
            action: 'PASSWORD_RESET_START',
            account,
            success: false,
            errorCode: account ? 'PASSWORD_RESET_NO_EMAIL' : 'PASSWORD_RESET_ACCOUNT_ABSENT'
        });
        return publicStart();
    }

    const since = new Date(Date.now() - ACCOUNT_WINDOW_MS);
    const sentCount = await PasswordResetRequest.countDocuments({
        accountId: account._id,
        accountType: account.accountType,
        otpPurpose: PURPOSE,
        createdAt: { $gte: since }
    });
    if (sentCount >= ACCOUNT_MAX_SENDS) {
        await auditReset({
            req,
            action: 'PASSWORD_RESET_START',
            account,
            success: false,
            errorCode: 'PASSWORD_RESET_RATE_LIMITED'
        });
        return publicStart();
    }

    const recent = await PasswordResetRequest.findOne({
        accountId: account._id,
        accountType: account.accountType,
        otpPurpose: PURPOSE,
        status: 'otp_sent',
        otpExpires: { $gt: new Date() }
    }).sort({ createdAt: -1 });
    if (recent && (Date.now() - new Date(recent.createdAt).getTime()) < resendCooldownMs()) {
        await auditReset({
            req,
            action: 'PASSWORD_RESET_START',
            account,
            success: true,
            errorCode: 'PASSWORD_RESET_RESEND_COOLDOWN'
        });
        return publicStart(String(recent._id));
    }

    const otp = generateOtp();
    const request = await PasswordResetRequest.create({
        accountType: account.accountType,
        accountModel: account.accountModel,
        accountId: account._id,
        username: account.username,
        phone: account.phone,
        name: account.name,
        status: 'otp_sent',
        otpPurpose: PURPOSE,
        otpCode: hashOtp(otp, PURPOSE),
        otpExpires: new Date(Date.now() + TTL_MS),
        otpAttempts: 0
    });

    const { sendPasswordResetEmail } = require('./emailOtpMailer');
    const delivery = await sendPasswordResetEmail({
        to: account.email,
        otp,
        expiresMinutes: TTL_MS / 60000,
        accountName: account.name
    });
    if (!delivery || !delivery.success) {
        request.status = 'expired';
        request.otpCode = undefined;
        await request.save();
        await auditReset({
            req,
            action: 'PASSWORD_RESET_START',
            account,
            success: false,
            errorCode: (delivery && delivery.code) || 'EMAIL_OTP_SEND_FAILED'
        });
        return publicStart();
    }

    await auditReset({
        req,
        action: 'PASSWORD_RESET_START',
        account,
        success: true,
        errorCode: ''
    });
    return publicStart(String(request._id));
};

const verifyPasswordReset = async ({ requestId, otp, req } = {}) => {
    const resetRequest = requestId ? await PasswordResetRequest.findById(requestId) : null;
    const fail = async (errorCode) => {
        await auditReset({
            req,
            action: 'PASSWORD_RESET_VERIFY',
            account: resetRequest ? {
                _id: resetRequest.accountId,
                accountModel: resetRequest.accountModel,
                name: resetRequest.name,
                username: resetRequest.username
            } : null,
            success: false,
            errorCode
        });
        return { success: false, code: errorCode, error: 'رمز الاستعادة غير صحيح أو منتهي.' };
    };

    if (!resetRequest || resetRequest.otpPurpose !== PURPOSE) return fail('PASSWORD_RESET_CODE_INVALID');
    if (resetRequest.status === 'otp_verified' || resetRequest.status === 'completed' || resetRequest.status === 'approved') {
        return fail('PASSWORD_RESET_REUSED');
    }
    if (resetRequest.status !== 'otp_sent') return fail('PASSWORD_RESET_CODE_INVALID');
    if (!resetRequest.otpExpires || resetRequest.otpExpires < new Date()) {
        resetRequest.status = 'expired';
        resetRequest.otpCode = undefined;
        await resetRequest.save();
        return fail('PASSWORD_RESET_EXPIRED');
    }
    if (Number(resetRequest.otpAttempts || 0) >= MAX_ATTEMPTS) {
        resetRequest.status = 'expired';
        resetRequest.otpCode = undefined;
        await resetRequest.save();
        return fail('PASSWORD_RESET_ATTEMPTS');
    }
    if (!verifyOtp(otp, resetRequest.otpCode, PURPOSE)) {
        resetRequest.otpAttempts = Number(resetRequest.otpAttempts || 0) + 1;
        if (resetRequest.otpAttempts >= MAX_ATTEMPTS) {
            resetRequest.status = 'expired';
            resetRequest.otpCode = undefined;
        }
        await resetRequest.save();
        return fail('PASSWORD_RESET_CODE_INVALID');
    }

    resetRequest.status = 'otp_verified';
    resetRequest.otpVerifiedAt = new Date();
    resetRequest.otpCode = undefined;
    await resetRequest.save();
    await auditReset({
        req,
        action: 'PASSWORD_RESET_VERIFY',
        account: {
            _id: resetRequest.accountId,
            accountModel: resetRequest.accountModel,
            name: resetRequest.name,
            username: resetRequest.username
        },
        success: true,
        errorCode: ''
    });
    return { success: true, message: 'تم التحقق من الرمز. اختر كلمة المرور الجديدة.' };
};

const completePasswordReset = async ({ requestId, newPassword, req } = {}) => {
    const resetRequest = requestId ? await PasswordResetRequest.findById(requestId) : null;
    const accountRef = resetRequest ? {
        _id: resetRequest.accountId,
        accountModel: resetRequest.accountModel,
        name: resetRequest.name,
        username: resetRequest.username
    } : null;
    const fail = async (errorCode) => {
        await auditReset({
            req,
            action: 'PASSWORD_RESET_FAILURE',
            account: accountRef,
            success: false,
            errorCode
        });
        return { success: false, code: errorCode, error: 'تعذر تغيير كلمة المرور. ابدأ الطلب من جديد.' };
    };

    if (!resetRequest || resetRequest.otpPurpose !== PURPOSE) return fail('PASSWORD_RESET_CODE_INVALID');
    if (resetRequest.status === 'completed' || resetRequest.status === 'approved') return fail('PASSWORD_RESET_REUSED');
    if (resetRequest.status !== 'otp_verified') return fail('PASSWORD_RESET_CODE_INVALID');

    const passwordHash = await bcrypt.hash(String(newPassword), 12);
    const Model = resetRequest.accountModel === 'SubAccount' ? SubAccount : User;
    await Model.updateOne(
        { _id: resetRequest.accountId },
        {
            $set: { webPassword: passwordHash },
            $inc: { sessionVersion: 1 },
            $unset: { refreshToken: 1, otpCode: 1, otpExpires: 1, otpChallengeId: 1, otpIssuedAt: 1 }
        },
        { strict: false }
    );
    await MobileDeviceSession.updateMany(
        {
            accountId: resetRequest.accountId,
            accountType: resetRequest.accountType === 'sub_client' ? 'sub_client' : 'client_user',
            active: true
        },
        { $set: { active: false, revokedAt: new Date(), revokeReason: 'password_reset' } }
    );

    resetRequest.status = 'completed';
    resetRequest.pendingPasswordHash = undefined;
    resetRequest.otpCode = undefined;
    await resetRequest.save();
    await auditReset({
        req,
        action: 'PASSWORD_RESET_SUCCESS',
        account: accountRef,
        success: true,
        errorCode: ''
    });
    return { success: true, message: 'تم تغيير كلمة المرور. سجّل الدخول من جديد على كل الأجهزة.' };
};

module.exports = {
    ACCOUNT_MAX_SENDS,
    MAX_ATTEMPTS,
    PURPOSE,
    TTL_MS,
    completePasswordReset,
    startPasswordReset,
    verifyPasswordReset
};
