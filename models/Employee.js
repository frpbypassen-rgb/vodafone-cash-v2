const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const employeeSchema = new mongoose.Schema({
    name: { type: String, required: true },
    phone: { type: String },
    // بريد رمز الدخول. يُستخدم فقط عندما تكون otpDeliveryChannel = email.
    email: { type: String, trim: true, lowercase: true, default: '' },
    otpDeliveryChannel: { type: String, enum: ['whatsapp', 'email'], default: 'whatsapp' },
    role: { type: String, enum: ['operator', 'manager', 'accountant', 'external'], default: 'operator' },
    status: { type: String, enum: ['pending', 'active', 'suspended', 'banned'], default: 'pending' },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', required: true },
    webUsername: { type: String, unique: true, required: true },
    webPassword: { type: String, required: true },
    mfaEnabled: { type: Boolean, default: false },
    mfaType: { type: String, enum: ['none', 'totp'], default: 'none' },
    totpSecretEncrypted: { type: String, select: false },
    mfaRecoveryCodeHashes: { type: [String], select: false, default: [] },
    mfaConfiguredAt: { type: Date, default: null },
    mfaLastUsedStep: { type: Number, default: null },
    refreshToken: { type: String }, // 🟢 مخصص لتطبيق الموبايل
    otpCode: { type: String },
    otpExpires: { type: Date },
    lastOtpDate: { type: String },
    telegramId: { type: String }, // معرف التليجرام للموظف
    otpChallengeId: { type: String },
    otpIssuedAt: { type: Date },
    otpAttempts: { type: Number, default: 0 },
    canViewAllReports: { type: Boolean, default: false }, // السماح برؤية جميع تقارير المجموعة
    balance: { type: Number, default: 0 }, // رصيد الموظف الخارجي الفردي (يُصفَّر عند الانضمام لمجموعة مشتركة)
    balancePoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorBalancePool', default: null },
    executionPolicyOverride: {
        proofRequired: { type: Boolean, default: undefined },
        allowedPhoneLengths: { type: [Number], default: undefined },
        maxConcurrentDevices: { type: Number, min: 1, max: 20, default: undefined },
        sessionTtlEnabled: { type: Boolean, default: undefined },
        sessionTtlSeconds: { type: Number, min: 0, default: undefined },
        quickExecuteEnabled: { type: Boolean, default: undefined }
    },
    ussdNetwork: { type: String, enum: ['vodafone', 'etisalat', 'orange', 'we'], default: 'vodafone' },
    ussdWalletPinEncrypted: { type: String, select: false },
    ussdWalletPinSetAt: { type: Date, default: null },
    sessionVersion: { type: Number, default: 0 },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: String, default: '' }
}, { timestamps: true });

employeeSchema.index({ webUsername: 1, groupId: 1 }, { unique: true });
employeeSchema.index({ tenantId: 1 });
employeeSchema.index({ groupId: 1, archivedAt: 1, role: 1 });
employeeSchema.index({ balancePoolId: 1, role: 1, archivedAt: 1 });

employeeSchema.pre('save', async function() {
    if (!this.isModified('webPassword') || !this.webPassword) return;
    if (this.webPassword.startsWith('$2')) return;
    this.webPassword = await bcrypt.hash(this.webPassword, 12);
    
});

module.exports = mongoose.model('Employee', employeeSchema);
