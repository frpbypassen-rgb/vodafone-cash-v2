'use strict';

const mongoose = require('mongoose');

const apiCommunicationLogSchema = new mongoose.Schema({
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true, index: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientCompany', index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, index: true },
    accountType: { type: String, enum: ['company', 'agent', 'user'], default: 'user' },
    executorId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', index: true },
    referenceId: { type: String, trim: true, index: true },
    status: { type: String, enum: ['success', 'pending', 'failed'], required: true },
    entries: [{
        direction: { type: String, enum: ['outbound', 'inbound', 'system'], required: true },
        stage: { type: String, required: true },
        method: { type: String, trim: true },
        endpoint: { type: String, trim: true },
        payload: { type: mongoose.Schema.Types.Mixed },
        recordedAt: { type: Date, default: Date.now }
    }],
    processLog: { type: String, default: '' }
}, { timestamps: true });

apiCommunicationLogSchema.index({ transactionId: 1, createdAt: -1 });
apiCommunicationLogSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model('ApiCommunicationLog', apiCommunicationLogSchema);
