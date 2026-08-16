'use strict';

const mongoose = require('mongoose');

const webPushSubscriptionSchema = new mongoose.Schema({
    endpoint: { type: String, required: true, unique: true, index: true },
    subscription: { type: Object, required: true },
    userId: { type: String, required: true, index: true },
    accountType: { type: String, default: 'client' },
    active: { type: Boolean, default: true, index: true },
    lastSuccessAt: { type: Date, default: null },
    lastError: { type: String, default: '' }
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('WebPushSubscription', webPushSubscriptionSchema);
