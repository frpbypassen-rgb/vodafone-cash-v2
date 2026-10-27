'use strict';
const crypto = require('crypto');
const QRCode = require('qrcode');
const mfa = require('./accountMfaService');
const { encrypt, decrypt } = require('../utils/encryption');
const SETUP_TTL = 10 * 60000;
const RECOVERY_TTL = 15 * 60000;
const ownerKey = (account, type) => `${type}:${account._id}`;
const fingerprint = (account) =>
    crypto
        .createHash('sha256')
        .update(String(account.totpSecretEncrypted || ''))
        .digest('hex');
const fail = (code, message, statusCode = 410) => Object.assign(new Error(message), { code, statusCode });
const read = (session, account, type) => {
    const pending = session.webMfaEnrollment;
    if (!pending || pending.owner !== ownerKey(account, type) || pending.expiresAt <= Date.now()) {
        delete session.webMfaEnrollment;
        return null;
    }
    if (
        (pending.stage === 'recovery' &&
            (!mfa.isEnabled(account) || pending.factor !== fingerprint(account))) ||
        (pending.stage === 'setup' && mfa.isEnabled(account))
    ) {
        delete session.webMfaEnrollment;
        return null;
    }
    try {
        return { ...pending, data: JSON.parse(decrypt(pending.encrypted)) };
    } catch (_) {
        delete session.webMfaEnrollment;
        return null;
    }
};
const publicSetup = async (pending, account) => ({
    ...pending.data,
    accountLabel: account.webUsername || account.name || 'Al-Ahram Pay',
    expiresAt: pending.expiresAt,
    qrImage: await QRCode.toDataURL(pending.data.qrUri, { width: 216, margin: 4, errorCorrectionLevel: 'M' }),
});
const resume = async (session, account, type) => {
    const pending = read(session, account, type);
    if (!pending) return null;
    return pending.stage === 'setup'
        ? { stage: 'setup', setup: await publicSetup(pending, account) }
        : { stage: 'recovery', recoveryCodes: pending.data.recoveryCodes, expiresAt: pending.expiresAt };
};
const start = async (session, account, type) => {
    if (mfa.isEnabled(account))
        throw fail(
            'MFA_ALREADY_ENABLED',
            'الحماية مفعلة بالفعل. أوقفها من إدارة التحقق قبل تغيير التطبيق.',
            409
        );
    let pending = read(session, account, type);
    if (!pending) {
        const { secret, qrUri, recoveryCodes } = mfa.setup(account);
        session.webMfaEnrollment = {
            owner: ownerKey(account, type),
            stage: 'setup',
            expiresAt: Date.now() + SETUP_TTL,
            encrypted: encrypt(JSON.stringify({ secret, qrUri, recoveryCodes })),
        };
        pending = read(session, account, type);
    }
    return publicSetup(pending, account);
};
const confirm = async (session, account, type, token) => {
    const pending = read(session, account, type);
    if (!pending || pending.stage !== 'setup')
        throw fail('MFA_SETUP_EXPIRED', 'انتهى الإعداد أو تغير. ابدأ التفعيل من جديد.');
    const { secret, recoveryCodes } = pending.data;
    const result = await mfa.confirmSetup(account, secret, String(token || '').trim(), recoveryCodes);
    session.webMfaEnrollment = {
        owner: ownerKey(account, type),
        stage: 'recovery',
        factor: fingerprint(account),
        expiresAt: Date.now() + RECOVERY_TTL,
        encrypted: encrypt(JSON.stringify({ recoveryCodes })),
    };
    return result;
};
const acknowledge = async (session, account, type) => {
    const pending = read(session, account, type);
    if (pending?.stage === 'recovery') delete session.webMfaEnrollment;
    return { completed: true };
};
const cancel = (session, account, type) => {
    if (read(session, account, type)?.stage === 'setup') delete session.webMfaEnrollment;
    return { cancelled: true };
};
module.exports = { start, resume, confirm, acknowledge, cancel };
