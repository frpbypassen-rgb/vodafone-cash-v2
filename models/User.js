const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    name: { type: String },
    phone: { type: String },
    balance: { type: Number, default: 0 },
    tier: { type: Number, default: 3 },
    status: { type: String, default: 'active' }, 
    creditLimit: { type: Number, default: 0 },
    webUsername: { type: String, sparse: true },
    webPassword: { type: String },
    refreshToken: { type: String }, // 🟢 مخصص لتطبيق الموبايل
    otpCode: { type: String },
    otpExpires: { type: Date },
    lastOtpDate: { type: String }
}, { timestamps: true });

userSchema.pre('save', async function(next) {
    if (!this.isModified('webPassword') || !this.webPassword) return next();
    if (this.webPassword.startsWith('$2')) return next();
    this.webPassword = await bcrypt.hash(this.webPassword, 12);
    next();
});

module.exports = mongoose.model('User', userSchema);