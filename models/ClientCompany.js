const mongoose = require('mongoose');
const crypto = require('crypto');

const clientCompanySchema = new mongoose.Schema({
    name: { type: String, required: true },
    phone: { type: String },
    // 🟢 تم التعديل: جعل المستوى الافتراضي 3 للشركات الجديدة
    tier: { type: Number, default: 3 },
    balance: { type: Number, default: 0 },
    accountCode: { type: String, trim: true, unique: true, sparse: true },
    token: {
        type: String,
        trim: true,
        unique: true,
        sparse: true,
        default: () => crypto.randomBytes(24).toString('hex')
    },
    // Used only by the isolated sandbox database to map a test merchant to its production account.
    sandboxSource: {
        reference: { type: String, trim: true, sparse: true },
        productionAccountId: { type: String, trim: true },
        productionAccountType: { type: String, enum: ['company', 'agent'] }
    },
    
    // 🟢 تم التعديل: إضافة حقل سعر الصرف المخصص للشركة
    exchangeRate: { type: Number, default: 0 },
    rateMode: { type: String, enum: ['general', 'custom'] },
    rateOffsets: {
        vodafone: { type: Number, default: 0 },
        post_account: { type: Number, default: 0 },
        post_card: { type: Number, default: 0 },
        bank_account: { type: Number, default: 0 },
        sefa_niger: { type: Number, default: 0 },
        bankak_sudan: { type: Number, default: 0 }
    },
    rateUpdatedAt: { type: Date },
    rateUpdatedBy: { type: String, trim: true, default: '' },

    // سياسة تنفيذ مستقلة للشركة. عند تفعيلها لا يسمح للنظام بالرجوع
    // لمسار التوزيع العام؛ فالعمليات الأكبر من الحد تبقى للمراجعة اليدوية.
    autoRoutePolicy: {
        enabled: { type: Boolean, default: false },
        executorGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', default: null },
        maxAutoAmount: { type: Number, min: 0, default: 0 },
        updatedAt: { type: Date, default: null },
        updatedBy: { type: String, trim: true, default: '' }
    },

    businessProfile: {
        contactName: { type: String, trim: true, default: '' },
        managerName: { type: String, trim: true, default: '' },
        managerPhone: { type: String, trim: true, default: '' },
        email: { type: String, trim: true, lowercase: true, default: '' },
        city: { type: String, trim: true, default: '' },
        regionCode: { type: String, trim: true, default: '' },
        headquarters: { type: String, trim: true, default: '' },
        address: { type: String, trim: true, default: '' },
        registrationNumber: { type: String, trim: true, default: '' },
        notificationPhone: { type: String, trim: true, default: '' },
        receiptPhone: { type: String, trim: true, default: '' }
    },
    logoUrl: { type: String, trim: true, default: '' },
    logoUpdatedAt: { type: Date, default: null },
    verificationDocuments: [{
        kind: { type: String, enum: ['identity', 'tax_card', 'business_license', 'profile_photo'], required: true },
        fileUrl: { type: String, required: true },
        originalName: { type: String, trim: true, default: '' },
        uploadedAt: { type: Date, default: Date.now }
    }],
    
    // الحد الائتماني للشركات (السماح بالنزول تحت الصفر)
    creditLimit: { type: Number, default: 0 }, 
    
    status: { type: String, default: 'active' }, // active, inactive
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    deletedAt: { type: Date },
    deletedBy: { type: String }
}, { timestamps: true });

clientCompanySchema.index({ tenantId: 1 });
clientCompanySchema.index({ 'sandboxSource.reference': 1, tenantId: 1 }, { sparse: true, unique: true });
clientCompanySchema.index({ 'autoRoutePolicy.executorGroupId': 1, status: 1 });

module.exports = mongoose.model('ClientCompany', clientCompanySchema);
