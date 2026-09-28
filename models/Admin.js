const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
    name: { type: String, default: 'بدون اسم' },
    role: { type: String, enum: ['master', 'admin', 'accountant'], default: 'admin', index: true }, 
    webUsername: { type: String, unique: true, required: true },
    webPassword: { type: String, required: true },
    // بريد رمز الدخول. عند وجود بريد صالح يُرسل الرمز عبر البريد.
    email: { type: String, trim: true, lowercase: true, default: '' },
    otpDeliveryChannel: { type: String, enum: ['whatsapp', 'email'], default: 'whatsapp' },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
    permissions: { type: [String], default: [] },
    mustEnrollSecurity: { type: Boolean, default: true },
    sessionVersion: { type: Number, default: 0 },
    mfaEnabled: { type: Boolean, default: false },
    mfaType: { type: String, enum: ['none', 'totp'], default: 'none' },
    totpSecretEncrypted: { type: String, select: false },
    mfaRecoveryCodeHashes: { type: [String], select: false, default: [] },
    mfaConfiguredAt: { type: Date, default: null },
    mfaLastUsedStep: { type: Number, default: null },
    otpCode: { type: String },
    otpExpires: { type: Date },
    otpChallengeId: { type: String },
    otpIssuedAt: { type: Date },
    otpAttempts: { type: Number, default: 0 },
    lastOtpDate: { type: String }
}, { timestamps: true });

// 🛡️ دالة التشفير الآلي قبل الحفظ
adminSchema.pre('save', async function() {
    if (!this.isModified('webPassword') || !this.webPassword) return;
    if (this.webPassword.startsWith('$2')) return; // لمنع التشفير المزدوج
    this.webPassword = await bcrypt.hash(this.webPassword, 12);
});

module.exports = mongoose.model('Admin', adminSchema);
