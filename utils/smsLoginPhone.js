'use strict';
const { hash } = require('./loginSecurityChallenge');

const normalizeSmsLoginPhone = (value) => {
    const phone = typeof value === 'string' ? value.trim().replace(/[\s-]+/g, '') : '';
    const match = /^(?:0|(?:\+|00)?218)(9[1-4][0-9]{7})$/.exec(phone);
    return match ? '218' + match[1] : '';
};

const phoneProof = (phone) => hash('sms-login-phone:' + phone);
const smsPhoneForAccount = (actor) => normalizeSmsLoginPhone(
    actor?.role === 'agent' ? (actor.contactPhone || actor.phone) : actor?.phone
);
const verifiedSmsPhone = (actor) => {
    const phone = smsPhoneForAccount(actor);
    if (!phone) return '';
    if (actor.smsOtpVerifiedPhoneHash === phoneProof(phone)) return phone;
    // Agents whose contact number was edited before this release still have
    // the proof for the old transaction phone. Route the next OTP to the
    // administrator-selected primary number without reviving the old one.
    const oldPhone = normalizeSmsLoginPhone(actor.role === 'agent' && actor.contactPhone ? actor.phone : '');
    return oldPhone && actor.smsOtpVerifiedPhoneHash === phoneProof(oldPhone) ? phone : '';
};
const maskSmsPhone = (phone) => phone ? '0' + phone.slice(3, 5) + '••••' + phone.slice(-3) : '';

module.exports = { normalizeSmsLoginPhone, smsPhoneForAccount, phoneProof, verifiedSmsPhone, maskSmsPhone };
