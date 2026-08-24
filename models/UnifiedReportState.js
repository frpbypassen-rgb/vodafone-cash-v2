'use strict';

const mongoose = require('mongoose');

const unifiedReportStateSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    status: {
        type: String,
        enum: ['pending', 'running', 'ready', 'failed'],
        default: 'pending'
    },
    scannedCount: { type: Number, default: 0 },
    indexedCount: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastSyncedAt: { type: Date, default: null },
    lastError: { type: String, default: null }
}, {
    collection: 'unified_report_states',
    timestamps: true
});

module.exports = mongoose.model('UnifiedReportState', unifiedReportStateSchema);
