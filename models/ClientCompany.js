const mongoose = require('mongoose');

const clientCompanySchema = new mongoose.Schema({
    name: { type: String, required: true },
    phone: { type: String },
    // 🟢 تم التعديل: جعل المستوى الافتراضي 3 للشركات الجديدة
    tier: { type: Number, default: 3 },
    balance: { type: Number, default: 0 },
    accountCode: { type: String, trim: true, unique: true, sparse: true },
    
    // 🟢 تم التعديل: إضافة حقل سعر الصرف المخصص للشركة
    exchangeRate: { type: Number, default: 0 },
    
    // الحد الائتماني للشركات (السماح بالنزول تحت الصفر)
    creditLimit: { type: Number, default: 0 }, 
    
    status: { type: String, default: 'active' } // active, inactive
}, { timestamps: true });

module.exports = mongoose.model('ClientCompany', clientCompanySchema);
