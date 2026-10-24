'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;
const alertSchema = new Schema({
    _id: String, transactionId: { type: Schema.Types.ObjectId, required: true }, tenantId: Schema.Types.ObjectId,
    kind: { type: String, enum: ['new_operation', 'api_pending'], required: true },
    reference: String, service: String, occurredAt: Date,
    acknowledgedBy: { type: String, default: null }, acknowledgedName: String, acknowledgedAt: Date,
    resolvedAt: { type: Date, default: null }, pushQueuedAt: { type: Date, default: null }
}, { timestamps: true });
alertSchema.index({ tenantId: 1, createdAt: -1 });
alertSchema.index({ kind: 1, resolvedAt: 1, _id: 1 });
alertSchema.index({ pushQueuedAt: 1, createdAt: 1 });

const stateSchema = new Schema({
    _id: String, since: Date, windowStart: Date, windowEnd: Date, cursorAt: Date, cursorId: Schema.Types.ObjectId,
    pendingCursor: Schema.Types.ObjectId, leaseUntil: Date, leaseToken: String
}, { versionKey: false });

const deviceSchema = new Schema({
    _id: String, adminId: String, sessionVersion: Number, sessionBinding: String, tenantId: Schema.Types.ObjectId,
    allTenants: Boolean, subscription: Object, active: { type: Boolean, default: true },
    lastError: String, lastSuccessAt: Date
}, { timestamps: true });
deviceSchema.index({ active: 1, adminId: 1 });

const deliverySchema = new Schema({
    _id: String, alertId: String, deviceId: String, adminId: String, attempts: { type: Number, default: 0 },
    status: { type: String, default: 'pending' }, nextAttemptAt: Date, leaseUntil: Date,
    expiresAt: Date, lastError: String
}, { timestamps: true });
deliverySchema.index({ status: 1, nextAttemptAt: 1 });
deliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = {
    AdminOperationAlert: mongoose.model('AdminOperationAlert', alertSchema),
    AdminAlertState: mongoose.model('AdminAlertState', stateSchema),
    AdminPushDevice: mongoose.model('AdminPushDevice', deviceSchema),
    AdminPushDelivery: mongoose.model('AdminPushDelivery', deliverySchema)
};
