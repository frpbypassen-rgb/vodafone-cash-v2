const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const serviceMarginPiastersSchema = new mongoose.Schema({
    vodafone: { type: Number, min: 0, max: 500 },
    post_account: { type: Number, min: 0, max: 500 },
    post_card: { type: Number, min: 0, max: 500 },
    bank_account: { type: Number, min: 0, max: 500 },
    sefa_niger: { type: Number, min: 0, max: 500 },
    bankak_sudan: { type: Number, min: 0, max: 500 }
}, { _id: false });

const subAccountSchema = new mongoose.Schema({
    masterType: { type: String, enum: ['user', 'company'], required: true },
    masterId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    phone: { type: String },
    webUsername: { type: String, required: true, unique: true },
    webPassword: { type: String, required: true },
    address: { type: String, trim: true, default: '' },
    profilePhotoKey: { type: String, trim: true, default: '' },
    profilePhotoUpdatedAt: { type: Date },
    creationIdempotencyKey: { type: String, unique: true, sparse: true },
    creationIdempotencyFingerprint: { type: String },
    refreshToken: { type: String }, // 🟢 مخصص لتطبيق الموبايل
    // يرفع عند تغيير كلمة المرور أو تسجيل الخروج من جميع الأجهزة.
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
    lastOtpDate: { type: String },
    customMargin: { type: Number, default: 0 },
    marginPiasters: { type: Number, min: 0, max: 500 },
    serviceMarginPiasters: { type: serviceMarginPiastersSchema, default: undefined },
    pricingVersion: { type: Number, default: 2 },
    marginUpdatedAt: { type: Date },
    marginUpdatedBy: { type: String, trim: true },
    cardMargin: { type: Number, default: 0 }, 
    balance: { type: Number, default: 0 }, 
    accountCode: { type: String, trim: true, unique: true, sparse: true },
    creditLimit: { type: Number, default: 0 }, 
    creditLimitUpdatedAt: { type: Date },
    creditLimitUpdatedBy: { type: String, trim: true },
    creditLimitUpdatedByModel: { type: String, trim: true },
    creditLimitUpdatedById: { type: mongoose.Schema.Types.ObjectId },
    status: { type: String, default: 'active' },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    deletedCredentials: {
        phone: { type: String },
        webUsername: { type: String }
    },
    deletedAt: { type: Date },
    deletedBy: { type: String }
}, { timestamps: true });

subAccountSchema.index({ tenantId: 1, masterType: 1, masterId: 1 });

subAccountSchema.pre('save', async function() {
    if (!this.isModified('webPassword') || !this.webPassword) return;
    if (this.webPassword.startsWith('$2')) return;
    this.webPassword = await bcrypt.hash(this.webPassword, 12);
});

module.exports = mongoose.model('SubAccount', subAccountSchema);
