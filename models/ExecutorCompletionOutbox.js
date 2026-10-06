'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true, unique: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    employeeName: { type: String, required: true, maxlength: 160 },
    auditContext: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['pending', 'processing', 'completed'], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    availableAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastError: { type: String, default: '', maxlength: 500 }
}, { timestamps: true });

schema.index({ status: 1, availableAt: 1, createdAt: 1 });

module.exports = mongoose.model('ExecutorCompletionOutbox', schema);
