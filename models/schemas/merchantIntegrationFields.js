'use strict';
module.exports = {
    profileRevision: { type: Number, default: 0 },
    integrationAccess: {
        revision: { type: Number, default: 0 },
        updatedBy: { type: String },
        updatedAt: { type: Date },
        apiEnabled: { type: Boolean, default: false },
        webhooksEnabled: { type: Boolean, default: false },
        keyDisabled: { type: Boolean, default: false },
        keyHint: { type: String, default: '' },
        keyCreatedAt: { type: Date },
    },
    merchantApiKeyHash: { type: String, select: false, unique: true, sparse: true },
};
