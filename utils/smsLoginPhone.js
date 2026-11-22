'use strict';
const { hash } = require('./loginSecurityChallenge');

const normalizeSmsLoginPhone = (value) => {
    const phone = typeof value === 'string' ? value.trim().replace(/[\s-]+/g, '') : '';
    const match = /^(?:0|(?:\+|00)?218)(9[1-4][0-9]{7})$/.exec(phone);
    return match ? '218' + match[1] : '';
};

const phoneProof = (phone) => hash('sms-login-phone:' + phone);
const verifiedSmsPhone = (actor) => {
    const phone = normalizeSmsLoginPhone(actor.phone);
    return phone && actor.smsOtpVerifiedPhoneHash === phoneProof(phone) ? phone : '';
};
const maskSmsPhone = (phone) => phone ? '0' + phone.slice(3, 5) + '••••' + phone.slice(-3) : '';

module.exports = { normalizeSmsLoginPhone, phoneProof, verifiedSmsPhone, maskSmsPhone };
