'use strict';
module.exports = {
    integrationAccess: {
        apiEnabled: { type: Boolean, default: false },
        webhooksEnabled: { type: Boolean, default: false },
        keyDisabled: { type: Boolean, default: false },
        keyHint: { type: String, default: '' },
        keyCreatedAt: { type: Date },
    },
    merchantApiKeyHash: { type: String, select: false, unique: true, sparse: true },
};
