const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
    telegramId: { type: String, unique: true, sparse: true },
    name: { type: String, default: 'بدون اسم' },
    role: { type: String, default: 'admin' }, 
    webUsername: { type: String, unique: true, sparse: true },
    webPassword: { type: String }
}, { timestamps: true });

// 🛡️ دالة التشفير الآلي قبل الحفظ
adminSchema.pre('save', async function(next) {
    if (!this.isModified('webPassword') || !this.webPassword) return next();
    if (this.webPassword.startsWith('$2')) return next(); // لمنع التشفير المزدوج
    this.webPassword = await bcrypt.hash(this.webPassword, 12);
    next();
});

module.exports = mongoose.model('Admin', adminSchema);