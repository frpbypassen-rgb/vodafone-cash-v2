'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    _id: { type: String },
    executorGroupId: { type: mongoose.Schema.Types.ObjectId, required: true },
    digest: { type: String, required: true },
    reference: { type: String, required: true },
    order: { type: Object, required: true },
    receivedAt: { type: Date, default: Date.now }
});
module.exports = mongoose.models.KenanWebhookEvent || mongoose.model('KenanWebhookEvent', schema);
