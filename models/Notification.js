// models/Notification.js
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    userId: { type: String, index: true },
    audience: { type: String, enum: ['admin', 'client', 'executor', 'all'], default: 'admin', index: true },
    targetModel: { type: String },
    targetId: { type: mongoose.Schema.Types.ObjectId },
    type: { type: String, default: 'system_alert', index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    txId: { type: String },
    metadata: { type: Object },
    isRead: { type: Boolean, default: false, index: true }
}, { timestamps: true });

notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ audience: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
