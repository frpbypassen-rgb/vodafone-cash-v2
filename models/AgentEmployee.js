const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const agentEmployeeSchema = new mongoose.Schema({
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    phone: { type: String },
    status: { type: String, default: 'active' },
    webUsername: { type: String, unique: true, required: true },
    webPassword: { type: String, required: true },
    otpCode: { type: String },
    otpExpires: { type: Date },
    lastOtpDate: { type: String },
    role: { type: String, enum: ['employee', 'accountant'], default: 'employee' },
    canViewAllReports: { type: Boolean, default: false },
    canManageAgent: { type: Boolean, default: false },
    canCreateAgentStaff: { type: Boolean, default: false },
    refreshToken: { type: String },
    deletedCredentials: {
        phone: { type: String },
        webUsername: { type: String }
    },
    deletedAt: { type: Date },
    deletedBy: { type: String }
}, { timestamps: true });

agentEmployeeSchema.pre('save', async function() {
    if (!this.isModified('webPassword') || !this.webPassword) return;
    if (this.webPassword.startsWith('$2')) return;
    this.webPassword = await bcrypt.hash(this.webPassword, 12);
});

module.exports = mongoose.model('AgentEmployee', agentEmployeeSchema);
