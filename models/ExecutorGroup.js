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
    apiUrl: { type: String, default: '' },
    apiToken: { type: String, default: '' },
    apiUsername: { type: String, default: '' },
    apiPassword: { type: String, default: '' },
    apiServiceId: { type: Number, default: 307 },
    apiProviderId: { type: Number, default: 29 },
    apiFieldId: { type: Number, default: 3488 },
    apiMachineSerial: { type: String, default: 'XP1' }
}, { timestamps: true });

module.exports = mongoose.model('ExecutorGroup', executorGroupSchema);
