const mongoose = require('mongoose');

const executorGroupSchema = new mongoose.Schema({
    name: { type: String, required: true },
    status: { type: String, default: 'active' }, // active, inactive, paused
    balance: { type: Number, default: 0 }, // العهدة المتاحة
    
    // نظام الوكلاء (البشريين)
    isManagerGroup: { type: Boolean, default: false }, 
    isManagerBot: { type: Boolean, default: false }, 
    parentGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', default: null },

    // 🚀 الحقول الجديدة الخاصة بالربط الآلي (API Integration)
    isApiGroup: { type: Boolean, default: false }, // هل هذه مجموعة ترتبط بـ API شركة أخرى؟
    isApiBot: { type: Boolean, default: false }, // هل هذه مجموعة ترتبط بـ API شركة أخرى؟
    apiUrl: { type: String, default: '' }, // رابط الـ API للشركة
    apiToken: { type: String, default: '' } // مفتاح المصادقة (API Key/Secret) للشركة
    
}, { timestamps: true });

module.exports = mongoose.model('ExecutorGroup', executorGroupSchema);