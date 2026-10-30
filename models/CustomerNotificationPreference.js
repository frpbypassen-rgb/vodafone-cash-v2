'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema(
    {
        ...require('../utils/portalSettingsRevision').revisionFields,
        ownerModel: { type: String, enum: ['User', 'SubAccount'], required: true },
        ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
        tenantId: { type: mongoose.Schema.Types.ObjectId, default: null },
        ratesEnabled: { type: Boolean, default: true },
        testAfter: { type: Date, default: () => new Date(0) },
    },
    { timestamps: true }
);
schema.index({ ownerModel: 1, ownerId: 1, tenantId: 1 }, { unique: true });
module.exports =
    mongoose.models.CustomerNotificationPreference ||
    mongoose.model('CustomerNotificationPreference', schema);
