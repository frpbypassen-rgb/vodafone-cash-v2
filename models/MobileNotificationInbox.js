'use strict';

const mongoose = require('mongoose');

const mobileNotificationInboxSchema = new mongoose.Schema({
    eventKey: { type: String, required: true, trim: true, maxlength: 260 },
    accountType: { type: String, enum: ['executor'], default: 'executor', index: true },
    accountId: { type: String, required: true, trim: true, index: true },
    category: { type: String, required: true, trim: true, index: true },
    priority: { type: String, enum: ['silent', 'normal', 'high', 'urgent', 'critical'], default: 'normal' },
    title: { type: String, required: true, trim: true, maxlength: 180 },
    body: { type: String, trim: true, maxlength: 600, default: '' },
    route: { type: String, trim: true, maxlength: 40, default: '' },
    referenceId: { type: String, trim: true, maxlength: 120, default: '' },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    deliveryStatus: {
        type: String,
        enum: ['recorded', 'accepted', 'failed', 'skipped'],
        default: 'recorded',
        index: true
    },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null, index: true },
    openedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: () => new Date(Date.now() + (90 * 24 * 60 * 60 * 1000)) }
}, { timestamps: true });

mobileNotificationInboxSchema.index({ eventKey: 1, accountId: 1 }, { unique: true });
mobileNotificationInboxSchema.index({ accountId: 1, readAt: 1, createdAt: -1 });
mobileNotificationInboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('MobileNotificationInbox', mobileNotificationInboxSchema);
