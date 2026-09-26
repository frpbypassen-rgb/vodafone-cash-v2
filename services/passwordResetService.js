'use strict';

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { escapeRegex } = require('../utils/helpers');
const { generateOtp, hashOtp, verifyOtp } = require('../utils/otp');
const { resolveAccountOtpEmail } = require('../utils/otpDeliveryChannel');
const { isAdminApprovedResetEmail } = require('../utils/trustedResetEmail');
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
const DEFAULT_COMPLETE_WINDOW_SECONDS = 600;
const MIN_COMPLETE_WINDOW_SECONDS = 60;
const MAX_COMPLETE_WINDOW_SECONDS = 600;

const resendCooldownMs = () => Math.min(
    300,
    Math.max(30, Number(process.env.OTP_RESEND_COOLDOWN_SECONDS) || 60)
) * 1000;

const completeWindowMs = (env = process.env) => {
    const parsed = Number(env.PASSWORD_RESET_COMPLETE_WINDOW_SECONDS);
    const seconds = Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed)
        : DEFAULT_COMPLETE_WINDOW_SECONDS;
    const clamped = Math.min(
        MAX_COMPLETE_WINDOW_SECONDS,
        Math.max(MIN_COMPLETE_WINDOW_SECONDS, seconds)
    );
    return clamped * 1000;
};

const opaqueId = () => new mongoose.Types.ObjectId().toString();

const asObjectId = (value) => {
    const text = String(value || '').trim();
    return /^[a-f0-9]{24}$/i.test(text) ? text : '';
};

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

const accountRefFrom = (doc) => (doc ? {
    _id: doc.accountId,
    accountModel: doc.accountModel,
    name: doc.name,
    username: doc.username
} : null);

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
            email: resolveAccountOtpEmail(user),
            otpDeliveryChannel: user.otpDeliveryChannel
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
            email: resolveAccountOtpEmail(subAccount),
            otpDeliveryChannel: subAccount.otpDeliveryChannel
        };
    }

    return null;
};

const publicStart = (requestId) => passwordResetStartBody(requestId || opaqueId());

const deleteWebSessions = async (accountId, dbSession) => {
    const id = asObjectId(accountId);
    if (!id || !mongoose.connection || !mongoose.connection.db) return;
    const collection = mongoose.connection.collection('sessions');
    await collection.deleteMany({
        $or: [
            { session: new RegExp(escapeRegex(id)) },
            { 'session.clientId': id }
        ]
    }, { session: dbSession });
};

const startPasswordReset = async ({ username, phone, req } = {}) => {
    const account = await findResetAccount(username, phone);
    if (!account || !isAdminApprovedResetEmail(account)) {
        await auditReset({
            req,
            action: 'PASSWORD_RESET_START',
            account,
            success: false,
            errorCode: account ? 'PASSWORD_RESET_EMAIL_NOT_APPROVED' : 'PASSWORD_RESET_ACCOUNT_ABSENT'
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
        await PasswordResetRequest.updateOne(
            { _id: request._id, status: 'otp_sent' },
            { $set: { status: 'expired' }, $unset: { otpCode: 1 } }
        );
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
    const id = asObjectId(requestId);
    const fail = async (errorCode, doc) => {
        await auditReset({
            req,
            action: 'PASSWORD_RESET_VERIFY',
            account: accountRefFrom(doc),
            success: false,
            errorCode
        });
        return { success: false, code: errorCode, error: 'رمز الاستعادة غير صحيح أو منتهي.' };
    };

    if (!id) return fail('PASSWORD_RESET_CODE_INVALID', null);

    const now = new Date();
    const resetRequest = await PasswordResetRequest.findOneAndUpdate(
        {
            _id: id,
            otpPurpose: PURPOSE,
            status: 'otp_sent',
            otpExpires: { $gt: now },
            otpAttempts: { $lt: MAX_ATTEMPTS }
        },
        { $inc: { otpAttempts: 1 } },
        { returnDocument: 'after' }
    );

    if (!resetRequest) {
        const current = await PasswordResetRequest.findById(id)
            .select('status otpPurpose otpExpires otpAttempts accountId accountModel name username');
        if (!current || current.otpPurpose !== PURPOSE) return fail('PASSWORD_RESET_CODE_INVALID', current);
        if (['otp_verified', 'completing', 'completed', 'approved'].includes(current.status)) {
            return fail('PASSWORD_RESET_REUSED', current);
        }
        if (current.status === 'otp_sent' && (!current.otpExpires || current.otpExpires < now)) {
            await PasswordResetRequest.updateOne(
                { _id: id, status: 'otp_sent' },
                { $set: { status: 'expired' }, $unset: { otpCode: 1 } }
            );
            return fail('PASSWORD_RESET_EXPIRED', current);
        }
        if (current.status === 'expired' || Number(current.otpAttempts || 0) >= MAX_ATTEMPTS) {
            if (current.status === 'otp_sent') {
                await PasswordResetRequest.updateOne(
                    { _id: id, status: 'otp_sent', otpAttempts: { $gte: MAX_ATTEMPTS } },
                    { $set: { status: 'expired' }, $unset: { otpCode: 1 } }
                );
            }
            return fail(
                Number(current.otpAttempts || 0) >= MAX_ATTEMPTS
                    ? 'PASSWORD_RESET_ATTEMPTS'
                    : 'PASSWORD_RESET_EXPIRED',
                current
            );
        }
        return fail('PASSWORD_RESET_CODE_INVALID', current);
    }

    if (!verifyOtp(otp, resetRequest.otpCode, PURPOSE)) {
        if (Number(resetRequest.otpAttempts) >= MAX_ATTEMPTS) {
            await PasswordResetRequest.updateOne(
                { _id: id, status: 'otp_sent', otpAttempts: { $gte: MAX_ATTEMPTS } },
                { $set: { status: 'expired' }, $unset: { otpCode: 1 } }
            );
            return fail('PASSWORD_RESET_ATTEMPTS', resetRequest);
        }
        return fail('PASSWORD_RESET_CODE_INVALID', resetRequest);
    }

    const verified = await PasswordResetRequest.findOneAndUpdate(
        {
            _id: id,
            status: 'otp_sent',
            otpPurpose: PURPOSE,
            otpCode: resetRequest.otpCode
        },
        {
            $set: { status: 'otp_verified', otpVerifiedAt: new Date() },
            $unset: { otpCode: 1 }
        },
        { returnDocument: 'after' }
    );
    if (!verified) return fail('PASSWORD_RESET_REUSED', resetRequest);

    await auditReset({
        req,
        action: 'PASSWORD_RESET_VERIFY',
        account: accountRefFrom(verified),
        success: true,
        errorCode: ''
    });
    return { success: true, message: 'تم التحقق من الرمز. اختر كلمة المرور الجديدة.' };
};

const completePasswordReset = async ({ requestId, newPassword, req } = {}) => {
    const id = asObjectId(requestId);
    const fail = async (errorCode, account) => {
        await auditReset({
            req,
            action: 'PASSWORD_RESET_FAILURE',
            account,
            success: false,
            errorCode
        });
        return { success: false, code: errorCode, error: 'تعذر تغيير كلمة المرور. ابدأ الطلب من جديد.' };
    };

    if (!id) return fail('PASSWORD_RESET_CODE_INVALID', null);
    const existing = await PasswordResetRequest.findById(id);
    const account = accountRefFrom(existing);
    if (!existing || existing.otpPurpose !== PURPOSE) return fail('PASSWORD_RESET_CODE_INVALID', account);
    if (['completed', 'approved', 'otp_verified', 'completing'].includes(existing.status) && existing.status !== 'otp_verified') {
        return fail(existing.status === 'completing' ? 'PASSWORD_RESET_CODE_INVALID' : 'PASSWORD_RESET_REUSED', account);
    }
    if (existing.status !== 'otp_verified') return fail('PASSWORD_RESET_CODE_INVALID', account);

    const cutoff = new Date(Date.now() - completeWindowMs());
    if (!existing.otpVerifiedAt || existing.otpVerifiedAt < cutoff) {
        await PasswordResetRequest.updateOne(
            { _id: id, status: 'otp_verified' },
            { $set: { status: 'expired' }, $unset: { otpCode: 1 } }
        );
        return fail('PASSWORD_RESET_EXPIRED', account);
    }

    const passwordHash = await bcrypt.hash(String(newPassword), 12);
    const Model = existing.accountModel === 'SubAccount' ? SubAccount : User;
    const sessionCollections = mongoose.connection && mongoose.connection.db
        ? await mongoose.connection.db.listCollections({ name: 'sessions' }).toArray()
        : [];
    const webSessionsExist = sessionCollections.length > 0;
    const dbSession = await mongoose.startSession();
    let committed = false;
    try {
        await dbSession.withTransaction(async () => {
            committed = false;
            const claimed = await PasswordResetRequest.findOneAndUpdate(
                {
                    _id: id,
                    otpPurpose: PURPOSE,
                    status: 'otp_verified',
                    otpVerifiedAt: { $gte: cutoff }
                },
                { $set: { status: 'completing' } },
                { returnDocument: 'after', session: dbSession }
            );
            if (!claimed) return;

            const passwordWrite = await Model.updateOne(
                { _id: claimed.accountId },
                {
                    $set: { webPassword: passwordHash },
                    $inc: { sessionVersion: 1 },
                    $unset: {
                        refreshToken: 1,
                        otpCode: 1,
                        otpExpires: 1,
                        otpChallengeId: 1,
                        otpIssuedAt: 1
                    }
                },
                { session: dbSession }
            );
            if (!passwordWrite.matchedCount) throw new Error('PASSWORD_RESET_ACCOUNT_MISSING');

            if (webSessionsExist) await deleteWebSessions(claimed.accountId, dbSession);
            await MobileDeviceSession.updateMany(
                {
                    accountId: claimed.accountId,
                    accountType: claimed.accountType === 'sub_client' ? 'sub_client' : 'client_user',
                    active: true
                },
                { $set: { active: false, revokedAt: new Date(), revokeReason: 'password_reset' } },
                { session: dbSession }
            );

            const finished = await PasswordResetRequest.updateOne(
                { _id: id, status: 'completing' },
                { $set: { status: 'completed' }, $unset: { otpCode: 1, pendingPasswordHash: 1 } },
                { session: dbSession }
            );
            if (!finished.modifiedCount) throw new Error('PASSWORD_RESET_COMPLETE_INCOMPLETE');
            committed = true;
        });
    } catch (_error) {
        // The transaction aborted. The request stays otp_verified, and the
        // password, sessionVersion, refresh token, and device sessions are
        // unchanged. It is not left in completing.
        return fail('PASSWORD_RESET_COMPLETE_FAILED', account);
    } finally {
        await dbSession.endSession();
    }

    if (!committed) {
        const latest = await PasswordResetRequest.findById(id).select('status');
        const code = latest && (latest.status === 'completed' || latest.status === 'approved')
            ? 'PASSWORD_RESET_REUSED'
            : 'PASSWORD_RESET_EXPIRED';
        return fail(code, account);
    }

    await auditReset({
        req,
        action: 'PASSWORD_RESET_SUCCESS',
        account,
        success: true,
        errorCode: ''
    });
    return { success: true, message: 'تم تغيير كلمة المرور. سجّل الدخول من جديد على كل الأجهزة.' };
};

module.exports = {
    ACCOUNT_MAX_SENDS,
    DEFAULT_COMPLETE_WINDOW_SECONDS,
    MAX_ATTEMPTS,
    PURPOSE,
    TTL_MS,
    completePasswordReset,
    completeWindowMs,
    startPasswordReset,
    verifyPasswordReset
};
