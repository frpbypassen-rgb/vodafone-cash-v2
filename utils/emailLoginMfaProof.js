'use strict';
const crypto = require('node:crypto');
const fingerprint = (account) =>
    crypto
        .createHash('sha256')
        .update(
            JSON.stringify([
                String(account._id),
                account.webPassword,
                account.sessionVersion || 0,
                account.mfaEnabled,
                account.mfaType,
                account.mfaConfiguredAt || null,
            ])
        )
        .digest('hex');
const create = (account, accountType) => ({
    accountType,
    fingerprint: fingerprint(account),
    expiresAt: Date.now() + 600000,
});
const valid = (proof, account, accountType) =>
    Boolean(
        proof &&
        proof.accountType === accountType &&
        proof.expiresAt > Date.now() &&
        proof.fingerprint === fingerprint(account)
    );
module.exports = { create, valid };
