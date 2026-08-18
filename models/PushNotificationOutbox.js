'use strict';

const mongoose = require('mongoose');

const pushNotificationOutboxSchema = new mongoose.Schema({
    eventKey: { type: String, required: true, trim: true, maxlength: 260, unique: true },
    category: {
        type: String,
        required: true,
        enum: [
            'executor_task_new',
            'executor_task_routed',
            'executor_task_reminder',
            'executor_task_claimed',
            'executor_task_closed',
            'executor_urgent_alert',
            'executor_task_accepted',
            'executor_task_completed',
            'executor_task_cancelled',
            'executor_support_reply',
            'executor_balance_warning',
            'executor_security_alert',
            'executor_report_ready'
        ]
    },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null, index: true },
    referenceId: { type: String, trim: true, maxlength: 120, default: '' },
    audience: { type: mongoose.Schema.Types.Mixed, required: true },
    title: { type: String, trim: true, maxlength: 180, default: '' },
    body: { type: String, trim: true, maxlength: 600, default: '' },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    visible: { type: Boolean, default: true },
    channelId: { type: String, trim: true, maxlength: 80, default: 'executor_tasks' },
    sound: { type: String, trim: true, maxlength: 80, default: 'default' },
    priority: { type: String, enum: ['silent', 'normal', 'high', 'urgent', 'critical'], default: 'normal' },
    route: { type: String, trim: true, maxlength: 40, default: '' },
    collapseKey: { type: String, trim: true, maxlength: 120, default: '' },
    reminderSequence: { type: Number, min: 0, default: 0 },
    status: {
        type: String,
        enum: ['pending', 'processing', 'sent', 'failed', 'cancelled', 'skipped'],
        default: 'pending',
        index: true
    },
    attempts: { type: Number, min: 0, default: 0 },
    maxAttempts: { type: Number, min: 1, default: 5 },
    availableAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    sentCount: { type: Number, min: 0, default: 0 },
    failedCount: { type: Number, min: 0, default: 0 },
    lastErrorCode: { type: String, trim: true, maxlength: 160, default: '' },
    lastErrorMessage: { type: String, trim: true, maxlength: 800, default: '' },
    expiresAt: { type: Date, default: () => new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)) }
}, { timestamps: true });

pushNotificationOutboxSchema.index({ status: 1, availableAt: 1, createdAt: 1 });
pushNotificationOutboxSchema.index({ transactionId: 1, status: 1 });
pushNotificationOutboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PushNotificationOutbox', pushNotificationOutboxSchema);
