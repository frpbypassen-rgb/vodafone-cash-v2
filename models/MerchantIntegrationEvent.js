'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema(
    {
        tenantId: { type: mongoose.Schema.Types.ObjectId },
        ownerModel: {
            type: String,
            enum: ['ClientCompany', 'User'],
            required: true,
        },
        ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
        bucketKey: { type: String, required: true, unique: true },
        code: { type: String, required: true },
        operation: {
            type: String,
            enum: ['balance', 'transfer', 'status', 'webhook'],
            required: true,
        },
        httpStatus: { type: Number },
        sourceIp: { type: String, maxlength: 64 },
        count: { type: Number, default: 0 },
        firstSeenAt: { type: Date },
        lastSeenAt: { type: Date },
        expiresAt: { type: Date, required: true },
    },
    { bufferCommands: false },
);
schema.index({ tenantId: 1, ownerModel: 1, ownerId: 1, lastSeenAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports =
    mongoose.models.MerchantIntegrationEvent ||
    mongoose.model('MerchantIntegrationEvent', schema);
