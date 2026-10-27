'use strict';
const crypto = require('crypto');
const hashKey = (value) => crypto.createHash('sha256').update(value).digest('hex');
const apiKeyQuery = (key, legacyField) => ({
    status: 'active',
    'integrationAccess.apiEnabled': true,
    'integrationAccess.keyDisabled': { $ne: true },
    $or: [
        { merchantApiKeyHash: hashKey(key) },
        { [legacyField]: key, merchantApiKeyHash: { $exists: false } },
    ],
});
module.exports = { hashKey, apiKeyQuery };
