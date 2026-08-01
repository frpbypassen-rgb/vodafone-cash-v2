const mongoose = require('mongoose');

const executorGroupSchema = new mongoose.Schema({
    name: { type: String, required: true },
    status: { type: String, default: 'active' }, // active, inactive, paused
    balance: { type: Number, default: 0 },

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
    lastApiAvailableBalance: { type: Number, default: null }
}, { timestamps: true });

module.exports = mongoose.model('ExecutorGroup', executorGroupSchema);
