'use strict';
const crypto = require('crypto');
const Subscription = require('../models/AgentReportEmail');
const mailer = require('./agentReportEmailMailer');
const { canReceiveAgencyStatement } = require('../utils/agentReportEmailAccess');
const { normalizeEmailAddress, isValidEmailAddress } = require('../utils/emailAddress');
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const ownerFilter = (workspace) => ({ actorModel: workspace.actorModel, actorId: workspace.actor._id, agentId: workspace.entity._id, tenantId: workspace.entity.tenantId || null });
const assertAccess = (workspace) => {
    if (!canReceiveAgencyStatement(workspace)) throw fail('FORBIDDEN', 'كشف الإدارة الشامل يتطلب صلاحية الاطلاع على حساب الوكالة بالكامل.', 403);
};
const hashCode = (challengeId, code) => {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32) throw fail('EMAIL_VERIFICATION_UNAVAILABLE', 'خدمة التأكيد غير مهيأة.', 503);
    return crypto.createHmac('sha256', secret).update(`${challengeId}:${code}`).digest('hex');
};
const publicStatus = (row) => ({
    email: row?.email || '', verified: Boolean(row?.verifiedAt), enabled: Boolean(row?.enabled),
    pendingEmail: row?.challengeExpiresAt > new Date() ? row.pendingEmail : '',
    challengeId: row?.challengeExpiresAt > new Date() ? row.challengeId : '',
    expiresAt: row?.challengeExpiresAt || null, resendAt: row?.requestAfter || null,
    lastSentAt: row?.lastSentAt || null, lastReportDay: row?.lastReportDay || '',
    lastDeliveryStatus: row?.lastDeliveryStatus || '', available: mailer.configured(),
    schedule: '00:05', timeZone: 'Africa/Tripoli',
});
const getStatus = async (workspace) => {
    assertAccess(workspace);
    return publicStatus(await Subscription.findOne(ownerFilter(workspace)).lean());
};
const requestCode = async (workspace, address, now = new Date()) => {
    assertAccess(workspace);
    const email = normalizeEmailAddress(address);
    if (!isValidEmailAddress(email)) throw fail('INVALID_EMAIL', 'أدخل بريداً إلكترونياً صالحاً.');
    if (!mailer.configured()) throw fail('SMTP_UNAVAILABLE', 'البريد غير مهيأ على الخادم حالياً.', 503);
    const filter = ownerFilter(workspace);
    try { await Subscription.updateOne(filter, { $setOnInsert: filter }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    const challengeId = crypto.randomBytes(24).toString('hex');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const challengeHash = hashCode(challengeId, code);
    const row = await Subscription.findOneAndUpdate({ ...filter, requestAfter: { $lte: now } }, { $set: {
        pendingEmail: email, challengeId, challengeHash, challengeAttempts: 0,
        challengeExpiresAt: new Date(now.getTime() + 600000), requestAfter: new Date(now.getTime() + 60000),
    } }, { returnDocument: 'after' });
    if (!row) throw fail('RESEND_COOLDOWN', 'انتظر دقيقة قبل طلب رمز آخر.', 429);
    try { await mailer.sendCode(email, code); }
    catch (_error) {
        await Subscription.updateOne({ ...filter, challengeId }, { $unset: { challengeHash: 1, challengeId: 1, challengeExpiresAt: 1, pendingEmail: 1 } });
        throw fail('EMAIL_SEND_FAILED', 'تعذر إرسال الرمز. حاول لاحقاً.', 503);
    }
    return publicStatus(row);
};
const verifyCode = async (workspace, challengeId, code, now = new Date()) => {
    assertAccess(workspace);
    if (!/^[a-f0-9]{48}$/.test(String(challengeId)) || !/^\d{6}$/.test(String(code))) throw fail('INVALID_CODE', 'أدخل رمز التأكيد المكوّن من 6 أرقام.');
    const filter = { ...ownerFilter(workspace), challengeId, challengeExpiresAt: { $gt: now }, challengeAttempts: { $lt: 5 } };
    const row = await Subscription.findOneAndUpdate(filter, { $inc: { challengeAttempts: 1 } }, { returnDocument: 'after' }).select('+challengeHash');
    if (!row?.challengeHash) throw fail('CODE_EXPIRED', 'انتهى الرمز أو استُنفدت المحاولات. اطلب رمزاً جديداً.');
    const actual = Buffer.from(hashCode(challengeId, String(code)), 'hex');
    const expected = Buffer.from(row.challengeHash, 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw fail('INVALID_CODE', 'رمز التأكيد غير صحيح.');
    const verified = await Subscription.findOneAndUpdate({ ...ownerFilter(workspace), challengeId, challengeHash: row.challengeHash, pendingEmail: row.pendingEmail, challengeExpiresAt: { $gt: now } }, {
        $set: { email: row.pendingEmail, verifiedAt: now, enabled: true },
        $unset: { challengeId: 1, challengeHash: 1, challengeExpiresAt: 1, pendingEmail: 1 },
    }, { returnDocument: 'after' });
    if (!verified) throw fail('CODE_EXPIRED', 'تم استبدال الرمز أو استخدامه بالفعل.');
    return publicStatus(verified);
};
const setEnabled = async (workspace, enabled) => {
    assertAccess(workspace);
    if (typeof enabled !== 'boolean') throw fail('INVALID_PREFERENCE', 'إعداد غير صالح.');
    const row = await Subscription.findOneAndUpdate({ ...ownerFilter(workspace), ...(enabled ? { verifiedAt: { $ne: null }, email: { $ne: '' } } : {}) }, { $set: { enabled } }, { returnDocument: 'after' });
    if (!row) throw fail('EMAIL_NOT_VERIFIED', 'أكّد البريد أولاً.');
    return publicStatus(row);
};
module.exports = { getStatus, requestCode, verifyCode, setEnabled, publicStatus, ownerFilter, hashCode, fail };
