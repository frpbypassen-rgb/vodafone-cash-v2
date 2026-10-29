'use strict';
const crypto = require('node:crypto');
const { resolveAccountOtpEmail } = require('./otpDeliveryChannel');
const telegramIdentity = (actor) =>
    actor.telegramLoginChatId && actor.telegramLoginBotId
        ? crypto
              .createHash('sha256')
              .update(`${actor.telegramLoginBotId}:${actor.telegramLoginChatId}`)
              .digest('hex')
        : '';
const emailAllowed = (actor) =>
    actor.otpDeliveryChannel === 'email' ||
    Boolean(actor.emailOtpVerifiedAt && actor.emailOtpLoginApprovedFor === resolveAccountOtpEmail(actor));
const telegramAllowed = (actor) =>
    actor.otpDeliveryChannel === 'telegram' ||
    Boolean(telegramIdentity(actor) && actor.telegramLoginApprovedFor === telegramIdentity(actor));
const grant = (actor, target) => {
    const fields = {};
    for (const channel of [actor.otpDeliveryChannel, target]) {
        if (channel === 'email' && resolveAccountOtpEmail(actor))
            fields.emailOtpLoginApprovedFor = resolveAccountOtpEmail(actor);
        if (channel === 'telegram' && telegramIdentity(actor))
            fields.telegramLoginApprovedFor = telegramIdentity(actor);
    }
    return fields;
};
module.exports = { telegramIdentity, emailAllowed, telegramAllowed, grant };
