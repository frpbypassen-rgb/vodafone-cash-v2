const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const employeeSchema = new mongoose.Schema({
    name: { type: String, required: true },
    phone: { type: String },
    role: { type: String, enum: ['operator', 'manager'], default: 'operator' },
    status: { type: String, enum: ['pending', 'active', 'suspended', 'banned'], default: 'pending' },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', required: true },
    webUsername: { type: String, unique: true, required: true },
    webPassword: { type: String, required: true },
    refreshToken: { type: String }, // 🟢 مخصص لتطبيق الموبايل
    otpCode: { type: String },
    otpExpires: { type: Date },
    lastOtpDate: { type: String },
    telegramId: { type: String }, // معرف التليجرام للموظف
    canViewAllReports: { type: Boolean, default: false }, // السماح برؤية جميع تقارير المجموعة
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

employeeSchema.index({ webUsername: 1, groupId: 1 }, { unique: true });
employeeSchema.index({ tenantId: 1 });

employeeSchema.pre('save', async function() {
    if (!this.isModified('webPassword') || !this.webPassword) return;
    if (this.webPassword.startsWith('$2')) return;
    this.webPassword = await bcrypt.hash(this.webPassword, 12);
    
});

module.exports = mongoose.model('Employee', employeeSchema);