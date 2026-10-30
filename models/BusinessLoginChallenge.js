'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema(
    {
        actorId: { type: mongoose.Schema.Types.ObjectId, required: true },
        actorModel: { type: String, enum: ['User', 'ClientEmployee', 'AgentEmployee', 'SubAccount'], required: true },
        accountType: { type: String, enum: ['user', 'company', 'agent_staff', 'sub_client'], required: true },
        binding: { type: String, required: true, select: false },
        fingerprint: { type: String, required: true, select: false },
        state: { type: String, enum: ['choose', 'sending', 'sent', 'used', 'locked'], default: 'choose' },
        generation: { type: Number, default: 0 },
        channel: { type: String, enum: ['email', 'telegram'] },
        codeHash: { type: String, select: false },
        codeExpiresAt: Date,
        resendAt: Date,
        attempts: { type: Number, default: 0 },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: true }
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.models.BusinessLoginChallenge || mongoose.model('BusinessLoginChallenge', schema);
