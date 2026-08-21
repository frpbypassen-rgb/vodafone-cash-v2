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

    businessProfile: {
        contactName: { type: String, trim: true, default: '' },
        email: { type: String, trim: true, lowercase: true, default: '' },
        city: { type: String, trim: true, default: '' },
        address: { type: String, trim: true, default: '' },
        registrationNumber: { type: String, trim: true, default: '' }
    },
    
    // الحد الائتماني للشركات (السماح بالنزول تحت الصفر)
    creditLimit: { type: Number, default: 0 }, 
    
    status: { type: String, default: 'active' }, // active, inactive
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    deletedAt: { type: Date },
    deletedBy: { type: String }
}, { timestamps: true });

clientCompanySchema.index({ tenantId: 1 });
clientCompanySchema.index({ 'sandboxSource.reference': 1, tenantId: 1 }, { sparse: true, unique: true });

module.exports = mongoose.model('ClientCompany', clientCompanySchema);
