'use strict';

const mongoose = require('mongoose');

// Short-lived mutual exclusion for admin bulk jobs. Expired rows can be
// taken over; the owner id stops a finisher from releasing someone else's lock.
const bulkJobLockSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    key: { type: String, required: true },
    ownerId: { type: String, required: true },
    expiresAt: { type: Date, required: true }
}, { timestamps: true, versionKey: false });

bulkJobLockSchema.index({ expiresAt: 1 });

module.exports = mongoose.model('BulkJobLock', bulkJobLockSchema);
