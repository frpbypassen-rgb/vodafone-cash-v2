// models/GlobalSettings.js
const mongoose = require('mongoose');

const GlobalSettingsSchema = new mongoose.Schema({
    exchangeRate: { type: Number, default: 1 }, // سعر الصرف الحالي
    vodafoneNumbers: { type: [String], default: ['01000000000'] }, // قائمة الأرقام المتاحة
    systemStatus: { type: String, enum: ['online', 'offline'], default: 'online' },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('GlobalSettings', GlobalSettingsSchema);