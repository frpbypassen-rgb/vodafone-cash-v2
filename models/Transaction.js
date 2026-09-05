// models/Transaction.js
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    // 🔑 المعرفات الأساسية لمنع التكرار
    customId: { type: String, unique: true, required: true },
    idempotencyKey: { type: String, unique: true, sparse: true }, 
    idempotencyFingerprint: { type: String },
    idempotencyResponse: { type: Object },

    editIdempotencyKey: { type: String, unique: true, sparse: true }, 
    editIdempotencyFingerprint: { type: String },
    editIdempotencyResponse: { type: Object },

    zaynpayIdempotencyKey: { type: String, unique: true, sparse: true }, 
    zaynpayIdempotencyFingerprint: { type: String },
    zaynpayIdempotencyResponse: { type: Object },

    // 👤 بيانات الجهة الطالبة 
    userId: { type: String }, // معرف العميل الفردي أو الموظف
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientCompany' }, 
    subAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubAccount' }, 
    companyName: { type: String },
    employeeName: { type: String },
    // هوية الحساب الذي أنشأ الطلب من بوابة العملاء. لا تُعرض للعملاء، لكنها
    // تمنع موظف الشركة من قراءة عمليات زميله حتى ضمن نفس الشركة.
    clientActorId: { type: String, select: false },
    clientActorModel: { type: String, select: false },
    subAccountName: { type: String },
    isSubAccountTx: { type: Boolean, default: false },

    // 💸 بيانات التحويل
    transferType: { type: String, default: 'vodafone' }, // vodafone, post_account, post_card
    vodafoneNumber: { type: String },
    accountNumber: { type: String },
    accountName: { type: String }, 
    amount: { type: Number, required: true, min: 0 }, // ✅ تحقق: لا قيم سالبة
    requestOwnerKey: { type: String, trim: true },
    canonicalServiceKey: { type: String, trim: true },
    canonicalRecipient: { type: String, trim: true },
    serviceDetails: {
        subtype: { type: String, trim: true },
        city: { type: String, trim: true },
        bankName: { type: String, trim: true },
        nationalId: { type: String, trim: true },
        governorate: { type: String, trim: true },
        clientPhone: { type: String, trim: true },
        destinationLabel: { type: String, trim: true },
        amountCurrency: { type: String, trim: true },
        rateDirection: { type: String, trim: true },
        dataEntryAcknowledged: { type: Boolean, default: false },
        dataEntryAcknowledgedAt: { type: Date }
    },
    balanceAdjustment: {
        entityModel: { type: String, trim: true },
        entityId: { type: mongoose.Schema.Types.ObjectId },
        delta: { type: Number },
        reversible: { type: Boolean, default: false },
        originalStatus: { type: String, trim: true },
        voidedAt: { type: Date },
        voidedBy: { type: String, trim: true },
        voidReason: { type: String, trim: true },
        voidToken: { type: String, trim: true },
        voidStartedAt: { type: Date }
    },
    // طلب إيداع شركة التنفيذ: لا يتحول إلى رصيد فعلي إلا بعد اعتماد الدعم.
    depositRequest: {
        note: { type: String, trim: true, maxlength: 1000 },
        receiptImages: [{ type: String }],
        supportTicketId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportTicket' },
        submittedById: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
        submittedByName: { type: String, trim: true },
        submittedByRole: { type: String, enum: ['admin', 'executor', 'client'], default: 'executor' },
        reviewedById: { type: String, trim: true },
        reviewedByName: { type: String, trim: true },
        reviewedAt: { type: Date },
        rejectionReason: { type: String, trim: true, maxlength: 1000 }
    },

    // 📊 البيانات المالية والمحاسبية 
    costLYD: { type: Number, default: 0, min: 0 }, // ✅ تحقق: لا قيم سالبة
    subAccountCostLYD: { type: Number, default: 0 },
    commission: { type: Number, default: 0 },
    masterProfit: { type: Number, default: 0 }, 
    exchangeRate: { type: Number, default: 0 }, 
    subClientRate: { type: Number, default: 0 },
    agencyPricing: {
        serviceKey: { type: String, trim: true },
        pricingVersion: { type: Number },
        amountEGP: { type: Number },
        amountCurrency: { type: String, trim: true },
        agentRate: { type: Number },
        customerRate: { type: Number },
        marginPiasters: { type: Number },
        rateDelta: { type: Number },
        agentCostLYD: { type: Number },
        customerChargeLYD: { type: Number },
        profitLYD: { type: Number }
    },
    settlementDetails: {
        category: { type: String, trim: true },
        paymentMethod: { type: String, trim: true },
        externalReference: { type: String, trim: true },
        statement: { type: String, trim: true },
        settledBy: { type: String, trim: true }
    },

    // ⚙️ حالة الطلب والتنفيذ
    status: { 
        type: String, 
        enum: [
            'pending',           
            'processing',        
            'accepted',          
            'completed',         
            'rejected',          
            'deposit_pending',   
            'deposit',           
            'deduction',         
            'cancelled_by_admin' 
        ], 
        default: 'pending' 
    },

    // 👨‍💻 بيانات الموظف المنفذ
    executorGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup' },
    managerGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup' },
    // A task can be directed to one employee before that employee accepts it.
    assignedExecutorId: { type: String, default: undefined },
    assignedExecutorName: { type: String, default: undefined },
    assignedExecutorAt: { type: Date, default: undefined },
    // وقت وصول العملية إلى قائمة مهام المنفذ، مستقل عن وقت إنشائها لدى العميل.
    executorReceivedAt: { type: Date },
    // وقت تأكيد المنفذ لإتمام العملية، ويستخدم لحساب مدة التنفيذ في تقاريره.
    completedAt: { type: Date },
    executorGroupName: { type: String },
    operatorId: { type: String }, 
    executorName: { type: String, default: '---' },
    executorSenderPhone: { type: String },
    // Full sender data is restricted to manager reports. Customer-facing
    // mappers never expose these fields.
    executorSenderEntries: [{
        phone: { type: String, trim: true },
        amount: { type: Number, min: 0 },
        proofImage: { type: String, default: null }
    }],
    // القيمة الأصلية التي أدخلها المنفذ. مخفية افتراضياً ولا تُقرأ إلا في تفاصيل الإدارة.
    executorExecutionNumber: { type: String, trim: true, maxlength: 64, select: false },
    executorExecutionNumberMasked: { type: String },
    manualExecutorReceiptReference: { type: String, unique: true, sparse: true },

    // 🤖 متغيرات نظام الربط الآلي (API)
    isApiReview: { type: Boolean }, 
    apiResultData: { type: Object }, 
    originalApiGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup' }, 

    // 📝 الملاحظات والتنبيهات
    notes: { type: String },
    customerNotes: { type: String },
    adminNotes: { type: String },
    complaintText: { type: String },
    emergencyAlert: { type: String }, 
    executorWebAlert: { type: Object }, 
    cancellationNumber: { type: String, unique: true, sparse: true },
    cancellationReason: { type: String },
    cancelledBy: { type: String },
    cancelledAt: { type: Date },

    // 🖼️ الصور وإثباتات التنفيذ
    proofImage: { type: String }, 
    proofImages: [{ type: String }], 
    // مرفقات المنفذ الداخلية: لا تظهر في بوابات العملاء أو روابط الإيصالات العامة.
    executorProofImages: [{ type: String }],
    idCardImage: { type: String }, 
    oldReceiptImage: { type: String },
    resolutionImage: { type: String },

    // ⭐ تقييم أداء المنفذ بعد إتمام العملية (1-5 نجوم)
    executorRating: { type: Number, min: 1, max: 5, default: null },
    executorRatingNote: { type: String, trim: true, default: null },
    executorRatedAt: { type: Date, default: null },

    // 🎙️ ملاحظة صوتية مرفقة بالعملية
    voiceNote: { type: String, default: null },

    // Multi-tenant
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' }
}, { 
    timestamps: true 
});

// ====================================================
// 📈 فهارس مركبة لتحسين الأداء — حرجة للاستعلامات المتكررة
// ====================================================
transactionSchema.index({ status: 1, createdAt: -1 });          // فلتر الحالة + الترتيب
transactionSchema.index({ userId: 1, createdAt: -1 });           // معاملات المستخدم الفردي
transactionSchema.index({ companyId: 1, createdAt: -1 });      // معاملات الشركة
transactionSchema.index({ companyId: 1, clientActorId: 1, createdAt: -1 });
transactionSchema.index({ userId: 1, clientActorId: 1, createdAt: -1 });
transactionSchema.index({ executorGroupId: 1, status: 1 });        // مهام المنفذ
transactionSchema.index({ status: 1, updatedAt: -1 });           // التقارير والإحصاءات
transactionSchema.index({ executorGroupId: 1, createdAt: -1 });    // رصيد المنفذ
transactionSchema.index({ executorGroupId: 1, executorReceivedAt: 1 }); // ترتيب قائمة مهام المنفذ
transactionSchema.index({ managerGroupId: 1, status: 1 });         // مهام المدير
transactionSchema.index({ assignedExecutorId: 1, status: 1 });
transactionSchema.index({ executorGroupId: 1, status: 1, executorReceivedAt: 1 });
transactionSchema.index({ managerGroupId: 1, status: 1, executorReceivedAt: 1 });
transactionSchema.index({ executorGroupId: 1, status: 1, updatedAt: -1 });
transactionSchema.index({ managerGroupId: 1, status: 1, updatedAt: -1 });
transactionSchema.index({ tenantId: 1, createdAt: -1 });
transactionSchema.index({
    requestOwnerKey: 1,
    canonicalServiceKey: 1,
    canonicalRecipient: 1,
    amount: 1,
    status: 1,
    createdAt: -1
}, {
    name: 'transferCooldownExact_v1',
    partialFilterExpression: {
        requestOwnerKey: { $exists: true },
        canonicalServiceKey: { $exists: true },
        canonicalRecipient: { $exists: true }
    }
});
transactionSchema.index({
    requestOwnerKey: 1,
    canonicalServiceKey: 1,
    canonicalRecipient: 1,
    status: 1,
    createdAt: -1
}, {
    name: 'transferCooldownRecipient_v1',
    partialFilterExpression: {
        requestOwnerKey: { $exists: true },
        canonicalServiceKey: { $exists: true },
        canonicalRecipient: { $exists: true }
    }
});
transactionSchema.index({
    status: 1,
    'apiResultData.waitingApiAutoCompletion': 1,
    'apiResultData.autoCompleteAt': 1
});

module.exports = mongoose.model('Transaction', transactionSchema);
