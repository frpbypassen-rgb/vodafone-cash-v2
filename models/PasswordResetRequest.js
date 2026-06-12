const mongoose = require('mongoose');

const passwordResetRequestSchema = new mongoose.Schema({
    requestId: {
        type: String,
        unique: true,
        default: function() {
            return 'PWR-' + Math.floor(100000 + Math.random() * 900000);
        }
    },
    accountType: { type: String, enum: ['user', 'sub_client'], required: true },
    accountModel: { type: String, enum: ['User', 'SubAccount'], required: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true },
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportTicket' },
    username: { type: String, required: true },
    phone: { type: String, required: true },
    name: { type: String, required: true },
    masterName: { type: String },
    status: {
        type: String,
        enum: ['otp_sent', 'otp_verified', 'pending_admin', 'approved', 'rejected', 'expired'],
        default: 'otp_sent'
    },
    otpCode: { type: String },
    otpExpires: { type: Date },
    otpVerifiedAt: { type: Date },
    pendingPasswordHash: { type: String },
    accountSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    reviewedBy: { type: String },
    reviewedAt: { type: Date }
}, { timestamps: true });

passwordResetRequestSchema.index({ accountId: 1, accountType: 1, status: 1 });
passwordResetRequestSchema.index({ ticketId: 1 });
passwordResetRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model('PasswordResetRequest', passwordResetRequestSchema);
