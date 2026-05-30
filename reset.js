require('dotenv').config();
const mongoose = require('mongoose');

// 🟢 استدعاء نفس ملف الاتصال الخاص بمشروعك لضمان تطابق قاعدة البيانات
const connectDB = require('./config/database');

const Transaction = require('./models/Transaction');
const ExecutorBot = require('./models/ExecutorBot');
const ClientBot = require('./models/ClientBot');
const User = require('./models/User');

const resetSystem = async () => {
    try {
        // 1. الاتصال بقاعدة البيانات بنفس طريقتك المعتادة
        await connectDB();
        console.log('✅ تم الاتصال بقاعدة البيانات بنجاح...');

        // 2. مسح سجل العمليات والتحويلات نهائياً (ترجع زيرو)
        const deletedTxs = await Transaction.deleteMany({});
        console.log(`🗑️ تم مسح السجل بالكامل! (عدد العمليات المحذوفة: ${deletedTxs.deletedCount})`);

        // 3. تصفير أرصدة بوتات التنفيذ (الوكلاء والفرعيين)
        const execUpdate = await ExecutorBot.updateMany({}, { $set: { balance: 0 } });
        console.log(`🔄 تم تصفير أرصدة التنفيذ (تم تحديث ${execUpdate.modifiedCount} بوت).`);

        // 4. تصفير أرصدة شركات العملاء
        const clientUpdate = await ClientBot.updateMany({}, { $set: { balance: 0 } });
        console.log(`🔄 تم تصفير أرصدة شركات العملاء (تم تحديث ${clientUpdate.modifiedCount} شركة).`);

        // 5. تصفير أرصدة العملاء الفرديين
        const userUpdate = await User.updateMany({}, { $set: { balance: 0 } });
        console.log(`🔄 تم تصفير أرصدة العملاء الفرديين (تم تحديث ${userUpdate.modifiedCount} عميل).`);

        console.log('\n🎉 مبروك يا هندسة! تم تصفير كل شيء ليرجع النظام "زيرو" كأنه جديد تماماً.');
        process.exit(0); // إنهاء السكربت بنجاح
    } catch (error) {
        console.error('❌ حدث خطأ أثناء التصفير:', error);
        process.exit(1);
    }
};

resetSystem();