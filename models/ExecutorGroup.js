const mongoose = require('mongoose');
const { EXECUTOR_SERVICE_KEYS } = require('../utils/executorServiceCatalog');

const executorGroupSchema = new mongoose.Schema({
    name: { type: String, required: true },
    status: { type: String, default: 'active' }, // active, inactive, paused, archived
    balance: { type: Number, default: 0 },
    serviceKey: { type: String, enum: EXECUTOR_SERVICE_KEYS, default: 'vodafone' },
    manualReceiptPrefix: { type: String, trim: true, match: /^\d{3}$/ },

    archivedAt: { type: Date, default: null },
    archivedBy: { type: String, default: '' },
    archiveReason: { type: String, default: '' },
    archiveBalance: { type: Number, default: null },
    archiveTransactionCount: { type: Number, default: null },
    archiveEmployeeCount: { type: Number, default: null },

    isManagerGroup: { type: Boolean, default: false },
    isManagerBot: { type: Boolean, default: false },
    parentGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', default: null },
    parentBotId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', default: null },

    isApiGroup: { type: Boolean, default: false },
    isApiBot: { type: Boolean, default: false },
    apiProviderKey: { type: String, default: 'zayn_external_aggregator' },
    apiUrl: { type: String, default: '' },
    apiToken: { type: String, default: '' },
    apiUsername: { type: String, default: '' },
    apiPassword: { type: String, default: '' },
    apiServiceId: { type: Number, default: 85 },
    apiProviderId: { type: Number, default: 16 },
    apiFieldId: { type: Number, default: 5488 },
    apiMachineSerial: { type: String, default: 'XP1' },
    lastApiTestAt: { type: Date },
    lastApiTestStatus: { type: String, enum: ['success', 'failed', 'pending'], default: undefined },
    lastApiTestMessage: { type: String, default: '' },
    lastApiServiceCredit: { type: Number, default: null },
    lastApiCashCredit: { type: Number, default: null },
    lastApiAvailableBalance: { type: Number, default: null },
    lastApiTransferTestAt: { type: Date, default: null },
    lastApiTransferTestStatus: { type: String, enum: ['success', 'failed', 'pending'], default: undefined },
    lastApiTransferTestMessage: { type: String, default: '' },
    lastApiBalanceCheckAt: { type: Date, default: null },
    lastApiBalanceCheckStatus: {
        type: String,
        enum: ['pending', 'matched', 'discrepancy', 'check_failed'],
        default: undefined
    },
    lastApiReturnSyncAt: { type: Date, default: null },
    lastApiReturnSyncStatus: {
        type: String,
        enum: ['success', 'failed'],
        default: undefined
    },
    lastApiReturnSyncMessage: { type: String, default: '' }
}, { timestamps: true });

executorGroupSchema.index({ status: 1, archivedAt: -1 });
executorGroupSchema.index({ manualReceiptPrefix: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('ExecutorGroup', executorGroupSchema);
