// scripts/factoryReset.js
// =====================================================
// ⚠️  ضبط المصنع الكامل — Factory Reset
// يحذف جميع البيانات ويعيد إنشاء الإعدادات الافتراضية
// =====================================================
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const { assertFinancialResetAllowed, extractDbName } = require('../utils/financialResetGuard');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vodafone_cash_system';

// ────────────────────────────────────────────────
// الجداول المطلوب حذفها (جميع الكولكشنات)
// ────────────────────────────────────────────────
const COLLECTIONS_TO_DROP = [
    'users',
    'admins',
    'clientcompanies',
    'clientemployees',
    'executorgroups',
    'employees',
    'transactions',
    'settlements',
    'reconciliations',
    'ledgers',
    'settings',
    'notifications',
    'supporttickets',
    'subaccounts',
    'counters',
    'cards',
    'storecategories',
    'storeproducts',
    'registrationrequests',
    'auditlogs',
    'tenants',
    'sessions'  // حذف جلسات تسجيل الدخول أيضاً
];

async function factoryReset() {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║     ⚠️  ضبط المصنع — Al-Ahram Pay System    ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');

    try {
        const dbName = extractDbName(MONGO_URI);
        const { dryRun } = assertFinancialResetAllowed({
            dbName,
            scriptName: 'scripts/factoryReset.js'
        });

        console.log(`🔗 الاتصال بـ: ${MONGO_URI}`);
        if (dryRun) {
            console.log('🧪 وضع التجربة — لن يتم حذف أي بيانات.');
        }
        await mongoose.connect(MONGO_URI);
        console.log('✅ تم الاتصال بقاعدة البيانات بنجاح\n');

        const db = mongoose.connection.db;
        const connectedName = db.databaseName;
        assertFinancialResetAllowed({
            dbName: connectedName,
            scriptName: 'scripts/factoryReset.js'
        });

        if (dryRun) {
            const collections = await db.listCollections().toArray();
            console.log(`Dry-run: would drop ${collections.length} collections in "${connectedName}".`);
            process.exit(0);
        }

        // 2️⃣ حذف جميع الكولكشنات
        console.log('🗑️  حذف جميع البيانات...');
        let dropped = 0;
        let skipped = 0;

        for (const name of COLLECTIONS_TO_DROP) {
            try {
                const exists = await db.listCollections({ name }).hasNext();
                if (exists) {
                    await db.dropCollection(name);
                    console.log(`   ✅ ${name}`);
                    dropped++;
                } else {
                    skipped++;
                }
            } catch (err) {
                console.log(`   ⚠️  ${name} — ${err.message}`);
            }
        }

        console.log(`\n📊 النتيجة: تم حذف ${dropped} جدول | تم تخطي ${skipped} (غير موجود)\n`);

        // 3️⃣ إنشاء حساب الأدمن الافتراضي
        console.log('👤 إنشاء حساب الأدمن الافتراضي...');
        const Admin = require('../models/Admin');
        const adminUsername = process.env.PANEL_USER || 'admin@localhost';
        const adminPassword = process.env.PANEL_PASS || `DemoAdmin-${crypto.randomBytes(9).toString('hex')}`;
        const defaultAdmin = await Admin.create({
            name: 'المدير العام',
            role: 'master',
            webUsername: adminUsername,
            webPassword: adminPassword
        });
        console.log(`   ✅ الأدمن: ${defaultAdmin.webUsername}`);
        console.log('   🔑 كلمة المرور طُبعت مرة واحدة محلياً — ليست سراً تشغيلياً.');
        console.log(`   🔑 كلمة المرور: ${adminPassword}`);
        console.log(`   👑 الدور: ${defaultAdmin.role}\n`);

        // 4️⃣ إنشاء الإعدادات الافتراضية
        console.log('⚙️  إنشاء الإعدادات الافتراضية...');
        const Settings = require('../models/Settings');
        const defaultSettings = await Settings.create({
            rateLevel1: 6.40,
            rateLevel2: 6.45,
            rateLevel3: 6.50,
            openingTime: '09:00',
            closingTime: '23:00',
            isManualClosed: false,
            welcomeMessage: 'مرحباً بك في منظومة الأهرام الرقمية للصرافة.',
            termsMessage: '⚠️ يرجى التأكد من الرقم قبل الإرسال.\nالتحويل يتم خلال دقائق.',
            closedMessage: 'نعتذر، المنظومة مغلقة حالياً. يرجى المحاولة في أوقات العمل الرسمية.',
            supportContact: '@AhramSupport',
            autoRouteEnabled: false,
            executorWelcomeMessage: 'أهلاً بك في لوحة تحكم التنفيذ الخاصة بشركة الأهرام.',
            executorPendingMessage: '⏳ حسابك لا يزال قيد المراجعة من قبل الإدارة.',
            executorBannedMessage: '⛔️ تم حظر حسابك. يرجى مراجعة الإدارة.'
        });
        console.log('   ✅ الإعدادات الافتراضية تم إنشاؤها');
        console.log(`   💱 أسعار الصرف: L1=${defaultSettings.rateLevel1} | L2=${defaultSettings.rateLevel2} | L3=${defaultSettings.rateLevel3}`);
        console.log(`   🕐 أوقات العمل: ${defaultSettings.openingTime} — ${defaultSettings.closingTime}\n`);

        // 5️⃣ إنشاء عداد الفواتير
        console.log('🔢 إنشاء عداد التسلسل...');
        const Counter = require('../models/Counter');
        await Counter.create({ _id: 'transactionId', seq: 0 });
        console.log('   ✅ عداد المعاملات يبدأ من 0\n');

        // ────────────────────────────────────────────────
        // ✅ تقرير الانتهاء
        // ────────────────────────────────────────────────
        console.log('╔══════════════════════════════════════════════╗');
        console.log('║    ✅ تم ضبط المصنع بنجاح!                   ║');
        console.log('╠══════════════════════════════════════════════╣');
        console.log('║  📌 بيانات الدخول للوحة التحكم:              ║');
        console.log(`║  👤 المستخدم: ${adminUsername.padEnd(30)}║`);
        console.log(`║  🔑 كلمة المرور: ${adminPassword.padEnd(27)}║`);
        console.log('║  🌐 الرابط: http://localhost:3000             ║');
        console.log('╚══════════════════════════════════════════════╝');
        console.log('');

    } catch (error) {
        console.error('❌ خطأ أثناء ضبط المصنع:', error.message);
        console.error(error.stack);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

factoryReset();
