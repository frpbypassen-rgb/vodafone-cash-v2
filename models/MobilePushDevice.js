'use strict';

const mongoose = require('mongoose');

const mobilePushDeviceSchema = new mongoose.Schema({
    installationId: { type: String, required: true, trim: true, maxlength: 160 },
    token: { type: String, required: true, trim: true, maxlength: 4096 },
    accountType: {
        type: String,
        required: true,
        enum: ['executor', 'client_user', 'client_company', 'sub_client', 'agent_staff']
    },
    accountId: { type: String, required: true, trim: true, index: true },
    executorGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', default: null },
    executorRole: { type: String, enum: ['operator', 'manager', 'accountant', ''], default: '' },
    platform: { type: String, enum: ['android', 'ios'], default: 'android' },
    appVersion: { type: String, trim: true, maxlength: 40, default: '' },
    deviceName: { type: String, trim: true, maxlength: 120, default: '' },
    locale: { type: String, trim: true, maxlength: 20, default: '' },
    timeZone: { type: String, trim: true, maxlength: 80, default: '' },
    permissionStatus: {
        type: String,
        enum: ['authorized', 'provisional', 'denied', 'not_determined'],
        default: 'not_determined'
    },
    enabled: { type: Boolean, default: true, index: true },
    tokenUpdatedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    lastSuccessfulPushAt: { type: Date, default: null },
    lastFailureAt: { type: Date, default: null },
    lastErrorCode: { type: String, trim: true, maxlength: 160, default: '' },
    lastErrorMessage: { type: String, trim: true, maxlength: 500, default: '' },
    acknowledgedTasks: {
        type: [{
            _id: false,
            transactionId: { type: String, required: true, trim: true },
            acknowledgedAt: { type: Date, default: Date.now }
        }],
        default: []
    }
}, { timestamps: true });

mobilePushDeviceSchema.index({ installationId: 1 }, { unique: true });
mobilePushDeviceSchema.index({ token: 1 });
mobilePushDeviceSchema.index({ accountType: 1, accountId: 1, enabled: 1 });
mobilePushDeviceSchema.index({ executorGroupId: 1, executorRole: 1, enabled: 1 });
mobilePushDeviceSchema.index({ lastSeenAt: 1 });
mobilePushDeviceSchema.index({ 'acknowledgedTasks.transactionId': 1 });

module.exports = mongoose.model('MobilePushDevice', mobilePushDeviceSchema);
