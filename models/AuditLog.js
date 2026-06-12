// models/AuditLog.js
// سجل التدقيق الشامل — يسجل كل العمليات الحساسة في النظام المالي
const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
    // ── نوع العملية ──────────────────────────────────────────
    action: {
        type: String,
        required: true,
        index: true
    },

    // ── درجة الخطورة ─────────────────────────────────────────
    severity: {
        type: String,
        enum: ['info', 'warning', 'critical'],
        default: 'info'
    },

    // ── من قام بالعملية ──────────────────────────────────────
    performedBy: {
        type: mongoose.Schema.Types.Mixed
    },
    performedByModel: {
        type: String,
        enum: ['Employee', 'ClientEmployee', 'User', 'SubAccount', 'Admin', 'System']
    },
    performedByName: { type: String }, // نسخة من الاسم لحماية السجل

    // ── الجهة المستهدفة بالعملية ─────────────────────────────
    targetId: {
        type: mongoose.Schema.Types.Mixed
    },
    targetModel: { type: String },

    // ── بيانات الطلب ─────────────────────────────────────────
    ipAddress: { type: String },
    userAgent: { type: String },
    endpoint: { type: String }, // المسار الذي تم استدعاؤه

    // 🆕 بصمة الجهاز ومعرف الجلسة
    deviceFingerprint: { type: String },
    sessionId: { type: String },

    // ── البيانات القديمة والجديدة (للتدقيق التفصيلي) ──────────
    oldData: { type: mongoose.Schema.Types.Mixed },
    newData: { type: mongoose.Schema.Types.Mixed },

    // ── بيانات إضافية متعلقة بالعملية ───────────────────────
    metadata: { type: mongoose.Schema.Types.Mixed },

    // ── نتيجة العملية ────────────────────────────────────────
    success: { type: Boolean, default: true },
    errorCode: { type: String }, // في حالة الفشل

    // 🆕 حقول التتبع والتدفق المخصصة
    result: { type: String, enum: ['ناجح', 'فاشل', 'معلق', 'محظور'], default: 'ناجح' },
    initiator: { type: String, enum: ['موقع', 'تطبيق'], default: 'موقع' },
    deviceType: { type: String, enum: ['هاتف', 'كمبيوتر'], default: 'كمبيوتر' },
    location: {
        latitude: { type: Number },
        longitude: { type: Number }
    },

    // 🆕 تشفير السلسلة المترابطة (Hash Chained Audit Trail)
    previousHash: { type: String, default: null },
    hash: { type: String, default: null }

}, {
    timestamps: true,
    // لا يُحذف ولا يُعدَّل هذا السجل — للحماية القانونية والتشغيلية
    versionKey: false
});

// فهارس لتسريع الاستعلامات الشائعة
auditLogSchema.index({ performedBy: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ targetId: 1, createdAt: -1 });
auditLogSchema.index({ ipAddress: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 }); // للتقارير اليومية

module.exports = mongoose.model('AuditLog', auditLogSchema);
