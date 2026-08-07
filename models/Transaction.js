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
    subAccountName: { type: String },
    isSubAccountTx: { type: Boolean, default: false },

    // 💸 بيانات التحويل
    transferType: { type: String, default: 'vodafone' }, // vodafone, post_account, post_card
    vodafoneNumber: { type: String },
    accountNumber: { type: String },
    accountName: { type: String }, 
    amount: { type: Number, required: true, min: 0 }, // ✅ تحقق: لا قيم سالبة
    serviceDetails: {
        subtype: { type: String, trim: true },
        city: { type: String, trim: true },
        bankName: { type: String, trim: true },
        nationalId: { type: String, trim: true },
        governorate: { type: String, trim: true },
        clientPhone: { type: String, trim: true },
        destinationLabel: { type: String, trim: true }
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
    // وقت وصول العملية إلى قائمة مهام المنفذ، مستقل عن وقت إنشائها لدى العميل.
    executorReceivedAt: { type: Date },
    executorGroupName: { type: String },
    operatorId: { type: String }, 
    executorName: { type: String, default: '---' },
    executorSenderPhone: { type: String },

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
    idCardImage: { type: String }, 
    oldReceiptImage: { type: String },
    resolutionImage: { type: String },

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
transactionSchema.index({ executorGroupId: 1, status: 1 });        // مهام المنفذ
transactionSchema.index({ status: 1, updatedAt: -1 });           // التقارير والإحصاءات
transactionSchema.index({ executorGroupId: 1, createdAt: -1 });    // رصيد المنفذ
transactionSchema.index({ executorGroupId: 1, executorReceivedAt: 1 }); // ترتيب قائمة مهام المنفذ
transactionSchema.index({ managerGroupId: 1, status: 1 });         // مهام المدير
transactionSchema.index({ tenantId: 1, createdAt: -1 });
transactionSchema.index({
    status: 1,
    'apiResultData.waitingApiAutoCompletion': 1,
    'apiResultData.autoCompleteAt': 1
});

module.exports = mongoose.model('Transaction', transactionSchema);
