const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const employeeSchema = new mongoose.Schema({
    telegramId: { type: String, required: true },
    name: { type: String, required: true },
    phone: { type: String },
    role: { type: String, enum: ['operator', 'manager'], default: 'operator' },
    status: { type: String, enum: ['pending', 'active', 'suspended', 'banned'], default: 'pending' },
    botId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorBot', required: true },
    adminMessages: [{ telegramId: String, messageId: Number }],
    webUsername: { type: String },
    webPassword: { type: String },
    refreshToken: { type: String }, // 🟢 مخصص لتطبيق الموبايل
    otpCode: { type: String },
    otpExpires: { type: Date },
    lastOtpDate: { type: String }
}, { timestamps: true });

employeeSchema.index({ telegramId: 1, botId: 1 }, { unique: true });

employeeSchema.pre('save', async function(next) {
    if (!this.isModified('webPassword') || !this.webPassword) return next();
    if (this.webPassword.startsWith('$2')) return next();
    this.webPassword = await bcrypt.hash(this.webPassword, 12);
    next();
});

module.exports = mongoose.model('Employee', employeeSchema);