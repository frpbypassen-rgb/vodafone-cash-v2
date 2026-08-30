const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    name: { type: String },
    phone: { type: String, unique: true, sparse: true },
    balance: { type: Number, default: 0 },
    tier: { type: Number, default: 3 },
    status: { type: String, default: 'active' }, 
    creditLimit: { type: Number, default: 0 },
    accountCode: { type: String, trim: true, unique: true, sparse: true },
    agentCode: { type: String, trim: true, sparse: true },
    // مفتاح الربط الخارجي للوكيل. لا يعاد ضمن الاستعلامات العادية.
    apiToken: { type: String, trim: true, unique: true, sparse: true, select: false },
    webUsername: { type: String, unique: true, required: true },
    webPassword: { type: String, required: true },
    profilePhotoKey: { type: String, trim: true, default: '' },
    profilePhotoUpdatedAt: { type: Date },
    role: { type: String, default: 'user' }, // user | accountant
    businessProfile: {
        contactName: { type: String, trim: true, default: '' },
        email: { type: String, trim: true, lowercase: true, default: '' },
        city: { type: String, trim: true, default: '' },
        address: { type: String, trim: true, default: '' },
        registrationNumber: { type: String, trim: true, default: '' }
    },
    verificationDocuments: [{
        kind: { type: String, enum: ['identity', 'tax_card', 'business_license', 'profile_photo'], required: true },
        fileUrl: { type: String, required: true },
        originalName: { type: String, trim: true, default: '' },
        uploadedAt: { type: Date, default: Date.now }
    }],
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
    deletedCredentials: {
        phone: { type: String },
        webUsername: { type: String }
    },
    deletedAt: { type: Date },
    deletedBy: { type: String },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

userSchema.pre('save', async function() {
    if (!this.isModified('webPassword') || !this.webPassword) return;
    if (this.webPassword.startsWith('$2')) return;
    this.webPassword = await bcrypt.hash(this.webPassword, 12);
    
});

// ====================================================
// 📈 فهارس لتحسين أداء الاستعلامات المتكررة
// ====================================================
// Duplicate index on phone removed (unique already enforced)
// webUsername لديه unique بالفعل في الشيما
userSchema.index({ status: 1 });                        // فلتر الحسابات النشيطة
userSchema.index({ tenantId: 1 });

module.exports = mongoose.model('User', userSchema);
