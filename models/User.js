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
    webUsername: { type: String, unique: true, required: true },
    webPassword: { type: String, required: true },
    role: { type: String, default: 'user' }, // user | accountant
    refreshToken: { type: String }, // 🟢 مخصص لتطبيق الموبايل
    otpCode: { type: String },
    otpExpires: { type: Date },
    lastOtpDate: { type: String },
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
