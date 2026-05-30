const mongoose = require('mongoose');

const clientEmployeeSchema = new mongoose.Schema({
    telegramId: { type: String, required: true },
    clientBotId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientBot', required: true },
    name: { type: String, required: true },
    phone: { type: String },
    status: { type: String, default: 'active' }, // active, banned
    
    // بيانات موقع العملاء (جديد)
    webUsername: { type: String, sparse: true }, 
    webPassword: { type: String },
    otpCode: { type: String },
    otpExpires: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('ClientEmployee', clientEmployeeSchema);