'use strict';

const ClientBot = require('../models/ClientBot');
const User = require('../models/User');
const {
    allowLegacyPlaintextApiKeys,
    apiKeyHint,
    generateApiKey,
    hashApiKey
} = require('../utils/apiKeyCrypto');

const HASH_FIELDS = Object.freeze({
    token: 'tokenHash',
    apiToken: 'apiTokenHash'
});

const HINT_FIELDS = Object.freeze({
    token: 'tokenHint',
    apiToken: 'apiTokenHint'
});

const assignHashedApiKey = (account, field, plaintext = generateApiKey()) => {
    const hashField = HASH_FIELDS[field];
    const hintField = HINT_FIELDS[field];
    if (!hashField) throw new Error(`Unsupported API key field: ${field}`);
    account[hashField] = hashApiKey(plaintext);
    account[hintField] = apiKeyHint(plaintext);
    account[field] = undefined;
    if (typeof account.set === 'function') {
        account.set(field, undefined);
    }
    if (typeof account.markModified === 'function') {
        account.markModified(hashField);
        account.markModified(hintField);
        account.markModified(field);
    }
    return {
        apiKey: plaintext,
        fingerprint: account[hashField].slice(0, 12),
        hint: account[hintField]
    };
};

const hashedLookup = async (presentedKey) => {
    const keyHash = hashApiKey(presentedKey);
    const company = await ClientBot.findOne({ tokenHash: keyHash, status: 'active' }).lean();
    if (company) {
        return {
            merchant: company,
            merchantType: 'company',
            entityModel: 'ClientCompany'
        };
    }

    const agent = await User.findOne({
        apiTokenHash: keyHash,
        role: 'agent',
        status: 'active'
    }).lean();
    if (agent) {
        return {
            merchant: agent,
            merchantType: 'agent',
            entityModel: 'User'
        };
    }

    return null;
};

const legacyLookup = async (presentedKey) => {
    if (!allowLegacyPlaintextApiKeys()) return null;

    const company = await ClientBot.findOne({ token: presentedKey, status: 'active' })
        .select('+token')
        .lean();
    if (company) {
        return {
            merchant: company,
            merchantType: 'company',
            entityModel: 'ClientCompany'
        };
    }

    const agent = await User.findOne({
        apiToken: presentedKey,
        role: 'agent',
        status: 'active'
    }).select('+apiToken').lean();
    if (agent) {
        return {
            merchant: agent,
            merchantType: 'agent',
            entityModel: 'User'
        };
    }

    return null;
};

const findMerchantByApiKey = async (presentedKey) => {
    const hashed = await hashedLookup(presentedKey);
    if (hashed) return hashed;
    return legacyLookup(presentedKey);
};

module.exports = {
    assignHashedApiKey,
    findMerchantByApiKey,
    generateApiKey
};
