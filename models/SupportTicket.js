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
    status: {
        type: String,
        enum: ['open', 'answered', 'pending_internal', 'resolved', 'closed'],
        default: 'open'
    },
    priority: {
        type: String,
        enum: ['low', 'normal', 'high', 'urgent'],
        default: 'normal'
    },
    category: { type: String, trim: true, default: 'general' },
    tags: [{ type: String, trim: true }],
    assignedToId: { type: String, trim: true },
    assignedToName: { type: String, trim: true },
    assignedAt: { type: Date },
    firstResponseAt: { type: Date },
    resolvedAt: { type: Date },
    closedAt: { type: Date },
    waitingSince: { type: Date },
    lastMessageAt: { type: Date },
    lastMessagePreview: { type: String, trim: true },
    lastMessageSender: { type: String, enum: ['user', 'admin', 'ai', 'system'] },
    lastCustomerMessageAt: { type: Date },
    lastAdminMessageAt: { type: Date },
    activeHandlerId: { type: String, trim: true },
    activeHandlerName: { type: String, trim: true },
    activeHandlerExpiresAt: { type: Date },
    unreadUser: { type: Number, default: 0 }, 
    unreadAdmin: { type: Number, default: 1 }, 
    messages: [supportMessageSchema],
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

supportTicketSchema.pre('save', function() {
    if (!this.isModified('messages') || !this.messages?.length) return;

    const lastMessage = this.messages[this.messages.length - 1];
    const createdAt = lastMessage.createdAt || new Date();
    const text = String(lastMessage.text || (lastMessage.imageUrl ? 'مرفق صورة' : 'رسالة جديدة'))
        .replace(/\s+/g, ' ')
        .trim();

    this.lastMessageAt = createdAt;
    this.lastMessagePreview = text.slice(0, 180);
    this.lastMessageSender = lastMessage.sender;

    if (lastMessage.sender === 'user' || lastMessage.direction === 'inbound') {
        this.lastCustomerMessageAt = createdAt;
        this.waitingSince = createdAt;
    } else {
        this.lastAdminMessageAt = createdAt;
    }
});

supportTicketSchema.index({ entityType: 1, entityId: 1, status: 1, updatedAt: -1 });
supportTicketSchema.index({ channel: 1, phoneNormalized: 1, status: 1, updatedAt: -1 });
supportTicketSchema.index({ status: 1, priority: 1, lastMessageAt: -1 });
supportTicketSchema.index({ assignedToId: 1, status: 1, lastMessageAt: -1 });
supportTicketSchema.index({ activeHandlerExpiresAt: 1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
