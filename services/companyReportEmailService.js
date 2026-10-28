'use strict';
const crypto = require('crypto');
const { withRevision, conflict, revisionOf, actorLabel } = require('../utils/portalSettingsRevision');
const Subscription = require('../models/CompanyReportEmail');
const mailer = require('./companyReportEmailMailer');
const { canReceiveCompanyStatement } = require('../utils/companyReportEmailAccess');
const { normalizeEmailAddress, isValidEmailAddress } = require('../utils/emailAddress');
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const ownerFilter = (workspace) => ({ actorModel: workspace.actorModel, actorId: workspace.actor._id, companyId: workspace.entity._id, tenantId: workspace.entity.tenantId || null });
const assertAccess = (workspace) => {
    if (!canReceiveCompanyStatement(workspace)) throw fail('FORBIDDEN', 'كشف الإدارة الشامل يتطلب صلاحية الاطلاع على حساب الشركة بالكامل.', 403);
};
const hashCode = (challengeId, code) => {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32) throw fail('EMAIL_VERIFICATION_UNAVAILABLE', 'خدمة التأكيد غير مهيأة.', 503);
    return crypto.createHmac('sha256', secret).update(`${challengeId}:${code}`).digest('hex');
};
const publicStatus = (row) => ({
    revision: revisionOf(row), updatedBy: row?.settingsUpdatedBy || '', updatedAt: row?.updatedAt || null,
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
const requestCode = async (workspace, address, now = new Date(), revision) => {
    assertAccess(workspace);
    const email = normalizeEmailAddress(address);
    if (!isValidEmailAddress(email)) throw fail('INVALID_EMAIL', 'أدخل بريداً إلكترونياً صالحاً.');
    if (!mailer.configured()) throw fail('SMTP_UNAVAILABLE', 'البريد غير مهيأ على الخادم حالياً.', 503);
    const filter = ownerFilter(workspace);
    try { await Subscription.updateOne(filter, { $setOnInsert: filter }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    const current = await Subscription.findOne(filter).lean();
    const expected = revision === undefined ? revisionOf(current) : revision;
    const challengeId = crypto.randomBytes(24).toString('hex');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const challengeHash = hashCode(challengeId, code);
    const row = await Subscription.findOneAndUpdate(withRevision({ ...filter, requestAfter: { $lte: now } }, expected), { $inc: { settingsRevision: 1 }, $set: {
        settingsUpdatedBy: actorLabel(workspace),
        pendingEmail: email, challengeId, challengeHash, challengeAttempts: 0,
        challengeExpiresAt: new Date(now.getTime() + 600000), requestAfter: new Date(now.getTime() + 60000),
    } }, { returnDocument: 'after' });
    if (!row && revision !== undefined && revisionOf(await Subscription.findOne(filter).lean()) !== revision) throw conflict();
    if (!row) throw fail('RESEND_COOLDOWN', 'انتظر دقيقة قبل طلب رمز آخر.', 429);
    try { await mailer.sendCode(email, code, {accountName:workspace.entity.name}); }
    catch (_error) {
        await Subscription.updateOne({ ...filter, challengeId }, { $unset: { challengeHash: 1, challengeId: 1, challengeExpiresAt: 1, pendingEmail: 1 } });
        throw fail('EMAIL_SEND_FAILED', 'تعذر إرسال الرمز. حاول لاحقاً.', 503);
    }
    return publicStatus(row);
};
const verifyCode = async (workspace, challengeId, code, now = new Date(), revision) => {
    assertAccess(workspace);
    if (!/^[a-f0-9]{48}$/.test(String(challengeId)) || !/^\d{6}$/.test(String(code))) throw fail('INVALID_CODE', 'أدخل رمز التأكيد المكوّن من 6 أرقام.');
    const filter = { ...ownerFilter(workspace), challengeId, challengeExpiresAt: { $gt: now }, challengeAttempts: { $lt: 5 } };
    const expected = revision === undefined ? revisionOf(await Subscription.findOne(ownerFilter(workspace)).lean()) : revision;
    const row = await Subscription.findOneAndUpdate(withRevision(filter, expected), { $inc: { challengeAttempts: 1 } }, { returnDocument: 'after' }).select('+challengeHash');
    if (!row?.challengeHash && revision !== undefined && revisionOf(await Subscription.findOne(ownerFilter(workspace)).lean()) !== revision) throw conflict();
    if (!row?.challengeHash) throw fail('CODE_EXPIRED', 'انتهى الرمز أو استُنفدت المحاولات. اطلب رمزاً جديداً.');
    const actual = Buffer.from(hashCode(challengeId, String(code)), 'hex');
    const expectedHash = Buffer.from(row.challengeHash, 'hex');
    if (expectedHash.length !== actual.length || !crypto.timingSafeEqual(expectedHash, actual)) throw fail('INVALID_CODE', 'رمز التأكيد غير صحيح.');
    const verified = await Subscription.findOneAndUpdate(withRevision({ ...ownerFilter(workspace), challengeId, challengeHash: row.challengeHash, pendingEmail: row.pendingEmail, challengeExpiresAt: { $gt: now } }, expected), {
        $inc: { settingsRevision: 1 },
        $set: { email: row.pendingEmail, verifiedAt: now, enabled: true, settingsUpdatedBy: actorLabel(workspace) },
        $unset: { challengeId: 1, challengeHash: 1, challengeExpiresAt: 1, pendingEmail: 1 },
    }, { returnDocument: 'after' });
    if (!verified) throw fail('CODE_EXPIRED', 'تم استبدال الرمز أو استخدامه بالفعل.');
    return publicStatus(verified);
};
const setEnabled = async (workspace, enabled, revision) => {
    assertAccess(workspace);
    if (typeof enabled !== 'boolean') throw fail('INVALID_PREFERENCE', 'إعداد غير صالح.');
    const current = await Subscription.findOne(ownerFilter(workspace)).lean();
    if (!current || (enabled && (!current.verifiedAt || !current.email))) throw fail('EMAIL_NOT_VERIFIED', 'أكّد البريد أولاً.');
    const row = await Subscription.findOneAndUpdate(withRevision({ ...ownerFilter(workspace), ...(enabled ? { verifiedAt: { $ne: null }, email: { $ne: '' } } : {}) }, revision === undefined ? revisionOf(current) : revision), { $inc: { settingsRevision: 1 }, $set: { enabled, settingsUpdatedBy: actorLabel(workspace) } }, { returnDocument: 'after' });
    if (!row) throw conflict();
    return publicStatus(row);
};
module.exports = { getStatus, requestCode, verifyCode, setEnabled, publicStatus, ownerFilter, hashCode, fail };
