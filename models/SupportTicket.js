// models/SupportTicket.js
const mongoose = require('mongoose');

const supportMessageSchema = new mongoose.Schema({
    sender: { type: String, enum: ['user', 'admin', 'ai', 'system'], required: true },
    senderName: { type: String, default: 'الإدارة' },
    text: { type: String },
    imageUrl: { type: String },
    channel: { type: String, enum: ['portal', 'whatsapp'], default: 'portal' },
    direction: { type: String, enum: ['inbound', 'outbound'], default: 'inbound' },
    providerMessageId: { type: String, trim: true, index: true, sparse: true },
    messageType: {
        type: String,
        enum: ['text', 'image', 'document', 'audio', 'video', 'unknown'],
        default: 'text'
    },
    deliveryStatus: { type: String, trim: true },
    createdAt: { type: Date, default: Date.now }
});

const supportTicketSchema = new mongoose.Schema({
    ticketId: { 
        type: String, 
        unique: true, 
        // 🟢 الحل السحري: التوليد المباشر بدلاً من دوال الحفظ التي تسبب التعليق
        default: function() {
            return 'TCK-' + Math.floor(100000 + Math.random() * 900000);
        }
    },
    entityType: { type: String, enum: ['client_user', 'client_company', 'executor', 'sub_client', 'whatsapp'], required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId },
    telegramId: { type: String },
    name: { type: String, required: true },
    phone: { type: String },
    phoneNormalized: { type: String, trim: true },
    channel: { type: String, enum: ['portal', 'whatsapp'], default: 'portal' },
    externalContactId: { type: String, trim: true },
    lastWhatsAppInboundAt: { type: Date },
    lastWhatsAppOutboundAt: { type: Date },
    whatsappWindowExpiresAt: { type: Date },
    botToken: { type: String }, 
    status: { type: String, enum: ['open', 'answered', 'closed'], default: 'open' },
    unreadUser: { type: Number, default: 0 }, 
    unreadAdmin: { type: Number, default: 1 }, 
    messages: [supportMessageSchema],
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

supportTicketSchema.index({ entityType: 1, entityId: 1, status: 1, updatedAt: -1 });
supportTicketSchema.index({ channel: 1, phoneNormalized: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
