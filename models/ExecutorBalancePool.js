'use strict';

const mongoose = require('mongoose');

const executorBalancePoolSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', required: true, index: true },
    balance: { type: Number, default: 0 },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: String, default: '' }
}, { timestamps: true });

executorBalancePoolSchema.index({ groupId: 1, archivedAt: 1, name: 1 });
executorBalancePoolSchema.index({ groupId: 1, archivedAt: 1 });

module.exports = mongoose.model('ExecutorBalancePool', executorBalancePoolSchema);
