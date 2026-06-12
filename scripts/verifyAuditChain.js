// scripts/verifyAuditChain.js
// =====================================================
// 🔗 أداة التحقق من سلسلة سجلات التدقيق المشفرة
// يتحقق من صحة هاشات السجلات المترابطة بالكامل واكتشاف أي تلاعب.
// =====================================================
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const { calculateHash } = require('../services/auditService');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vodafone_cash_system';

async function verifyAuditChain() {
    console.log('\n🔍 بدء فحص وتدقيق سلسلة السجلات المشفرة (Hash Chain Verification)...');
    console.log(`🔗 الاتصال بـ: ${MONGO_URI}\n`);

    try {
        await mongoose.connect(MONGO_URI);
        
        // جلب جميع السجلات مرتبة ترتيباً تصاعدياً
        const logs = await AuditLog.find().sort({ createdAt: 1 });
        
        if (logs.length === 0) {
            console.log('✅ السلسلة فارغة — لا توجد أي سجلات تدقيق للتحقق منها حالياً.');
            return;
        }

        console.log(`📊 عدد السجلات المكتشفة للفحص: ${logs.length} سجل.`);
        console.log('----------------------------------------------------');

        let isValid = true;
        let expectedPreviousHash = 'GENESIS';

        for (let i = 0; i < logs.length; i++) {
            const entry = logs[i];
            
            // 1. التحقق من الـ previousHash
            if (entry.previousHash !== expectedPreviousHash) {
                console.error(`🚨 تلاعب بالبنية! السجل رقم [${i + 1}] (ID: ${entry._id})`);
                console.error(`   - الهاش السابق المخزن: ${entry.previousHash}`);
                console.error(`   - الهاش المتوقع:       ${expectedPreviousHash}`);
                isValid = false;
                break;
            }

            // 2. إعادة حساب الهاش للسجل الحالي
            const computedHash = calculateHash(entry, entry.previousHash);

            // 3. التحقق من تطابق الهاش
            if (entry.hash !== computedHash) {
                console.error(`🚨 تلاعب بالمحتوى! السجل رقم [${i + 1}] (ID: ${entry._id}) تم تعديل بياناته يدوياً!`);
                console.error(`   - الهاش المخزن: ${entry.hash}`);
                console.error(`   - الهاش الفعلي: ${computedHash}`);
                isValid = false;
                break;
            }

            // تحديث الهاش المتوقع للسجل التالي
            expectedPreviousHash = entry.hash;
        }

        console.log('----------------------------------------------------');
        if (isValid) {
            console.log('✅ نجاح الفحص: سلسلة سجلات التدقيق سليمة تماماً وغير متلاعب بها (Unbroken Cryptographic Chain).');
        } else {
            console.error('❌ فشل الفحص: تم اكتشاف خرق أمني أو تلاعب في سجلات التدقيق بالكامل!');
        }

    } catch (error) {
        console.error('❌ خطأ أثناء التحقق من السلسلة:', error.message);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

verifyAuditChain();
