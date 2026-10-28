'use strict';
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const secret = () => String(process.env.SESSION_SECRET || process.env.JWT_SECRET || '');
const hash = (value) => crypto.createHmac('sha256', secret()).update(String(value)).digest('hex');
const binding = (actor, sessionId) =>
    hash(`${actor._id}:${sessionId}:${actor.webPassword}:${actor.sessionVersion || 0}`);
const revision = (actor) => actor.emailOtpSettingsRevision || 0;
const guard = (actor) => ({
    _id: actor._id,
    status: 'active',
    webPassword: actor.webPassword,
    $or: [
        { emailOtpSettingsRevision: revision(actor) },
        ...(revision(actor) === 0 ? [{ emailOtpSettingsRevision: { $exists: false } }] : []),
    ],
});
const password = async (actor, value) => {
    if (
        typeof value !== 'string' ||
        value.length > 128 ||
        !(await bcrypt.compare(value, actor.webPassword || ''))
    )
        throw fail('PASSWORD', 'كلمة المرور الحالية غير صحيحة.', 403);
};
const code = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const matches = (stored, input) =>
    typeof stored === 'string' &&
    stored.length === 64 &&
    crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(hash(input)));
const pending = (actor, sessionId, extra = {}) => ({
    id: crypto.randomUUID(),
    binding: binding(actor, sessionId),
    revision: revision(actor),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 300000,
    attempts: 0,
    ...extra,
});
const valid = (item, actor, sessionId) =>
    Boolean(
        item &&
        item.expiresAt > Date.now() &&
        item.revision === revision(actor) &&
        item.binding === binding(actor, sessionId)
    );
const unsetLogin = { otpCode: 1, otpChallengeId: 1, otpExpires: 1, otpIssuedAt: 1, otpAttempts: 1 };
module.exports = {
    fail,
    secret,
    hash,
    binding,
    revision,
    guard,
    password,
    code,
    matches,
    pending,
    valid,
    unsetLogin,
};
