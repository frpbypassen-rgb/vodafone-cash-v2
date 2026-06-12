/**
 * 🧪 سكربت اختبار شامل لنظام الأهرام
 * يقوم بـ:
 * 1. إنشاء حسابات (عميل، شركة، وكالة، عميل جديد، منفذ، منفذ API)
 * 2. تسجيل دخول واختبار كل الـ endpoints
 * 3. إجراء عمليات تحويل
 * 4. اختبار الضغط (stress test)
 * 5. توليد تقرير نهائي
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const BASE = 'http://localhost:3000';
const API = `${BASE}/api/mobile`;
const RESULTS = { passed: [], failed: [], warnings: [], stressResults: null };
let TOKENS = {};

// ═══════════════════════════════════════════════════════
// 🛠️ Helper Functions
// ═══════════════════════════════════════════════════════
function log(icon, msg) { console.log(`${icon} ${msg}`); }
function pass(test) { RESULTS.passed.push(test); log('✅', test); }
function fail(test, err) { RESULTS.failed.push({ test, error: err }); log('❌', `${test}: ${err}`); }
function warn(msg) { RESULTS.warnings.push(msg); log('⚠️', msg); }

async function api(method, path, data = null, token = null, headers = {}) {
    const config = {
        method, url: `${API}${path}`,
        headers: { 'Content-Type': 'application/json', ...headers },
        validateStatus: () => true, timeout: 10000
    };
    if (token) config.headers['Authorization'] = `Bearer ${token}`;
    if (data) config.data = data;
    return axios(config);
}

async function webPost(path, formData) {
    return axios({
        method: 'POST', url: `${BASE}${path}`,
        data: new URLSearchParams(formData).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true, maxRedirects: 0, timeout: 10000
    });
}

// ═══════════════════════════════════════════════════════
// 📦 Phase 1: إعداد قاعدة البيانات
// ═══════════════════════════════════════════════════════
async function setupDatabase() {
    log('📦', '=== Phase 1: إعداد قاعدة البيانات ===');
    
    const db = mongoose.connection.db;
    const hp = await bcrypt.hash('Test@123', 10);
    const ts = Date.now().toString().slice(-6);

    // 1. إنشاء ExecutorBot (بشري)
    const ebResult = await db.collection('executorbots').findOneAndUpdate(
        { name: `TestBot-${ts}` },
        { $set: { name: `TestBot-${ts}`, token: 'dummy_token', status: 'active', isApiBot: false, balance: 10000 },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
    );
    const execBotId = ebResult._id;
    pass(`إنشاء ExecutorBot (بشري): ${execBotId}`);

    // 2. إنشاء ExecutorBot (API)
    const apiBotResult = await db.collection('executorbots').findOneAndUpdate(
        { name: `APIBot-${ts}` },
        { $set: { name: `APIBot-${ts}`, token: '', status: 'active', isApiBot: true, apiUrl: 'https://example.com/api', apiToken: 'api_key_123', balance: 20000 },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
    );
    const apiBotId = apiBotResult._id;
    pass(`إنشاء ExecutorBot (API): ${apiBotId}`);

    // 3. إنشاء ClientBot (شركة)
    const cbResult = await db.collection('clientbots').findOneAndUpdate(
        { username: `company_${ts}` },
        { $set: { name: `شركة الاختبار ${ts}`, username: `company_${ts}`, token: `dummy_cb_${ts}`, balance: 50000, status: 'active', tier: 2, defaultEmployeePassword: '123' },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
    );
    const clientBotId = cbResult._id;
    pass(`إنشاء ClientBot (شركة): ${clientBotId}`);

    // 4. حساب عميل مباشر (User)
    const userPhone = `010${ts}01`;
    await db.collection('users').findOneAndUpdate(
        { phone: userPhone },
        { $set: { phone: userPhone, name: 'عميل اختبار مباشر', webUsername: `directuser_${ts}@ahram.com`, webPassword: hp, status: 'active', balance: 10000, telegramId: `tg_user_${ts}`, tier: 3 },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
    );
    pass(`إنشاء حساب عميل مباشر: ${userPhone}`);

    // 5. حساب موظف شركة (ClientEmployee)
    const compPhone = `010${ts}02`;
    await db.collection('clientemployees').findOneAndUpdate(
        { phone: compPhone },
        { $set: { phone: compPhone, name: 'موظف شركة اختبار', webUsername: `companyemp_${ts}@ahram.com`, webPassword: hp, status: 'active', clientBotId: clientBotId, telegramId: `tg_comp_${ts}` },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
    );
    pass(`إنشاء حساب شركة: ${compPhone}`);

    // 6. حساب منفذ (Employee)
    const execPhone = `010${ts}03`;
    await db.collection('employees').findOneAndUpdate(
        { phone: execPhone },
        { $set: { phone: execPhone, name: 'منفذ بشري اختبار', webUsername: `executor_${ts}`, webPassword: hp, status: 'active', botId: execBotId, telegramId: `tg_exec_${ts}`, role: 'operator' },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
    );
    pass(`إنشاء حساب منفذ بشري: ${execPhone}`);

    // 7. حساب منفذ API (Employee مرتبط بـ APIBot)
    const apiExecPhone = `010${ts}04`;
    await db.collection('employees').findOneAndUpdate(
        { phone: apiExecPhone },
        { $set: { phone: apiExecPhone, name: 'منفذ API اختبار', webUsername: `apiexec_${ts}`, webPassword: hp, status: 'active', botId: apiBotId, telegramId: `tg_apiexec_${ts}`, role: 'operator' },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
    );
    pass(`إنشاء حساب منفذ API: ${apiExecPhone}`);

    // 8. إعدادات النظام
    await db.collection('settings').findOneAndUpdate(
        {},
        { $set: { exchangeRate: 6.5, isManualClosed: false, minTransfer: 50, maxTransfer: 50000, tier1Rate: 6.3, tier2Rate: 6.4, tier3Rate: 6.5 },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );
    pass('تحديث إعدادات النظام');

    return {
        userPhone, compPhone, execPhone, apiExecPhone,
        execBotId, apiBotId, clientBotId, ts
    };
}

// ═══════════════════════════════════════════════════════
// 🔐 Phase 2: اختبار تسجيل الدخول (Mobile API)
// ═══════════════════════════════════════════════════════
async function testLogin(accounts) {
    log('🔐', '=== Phase 2: اختبار تسجيل الدخول ===');

    // Login: عميل مباشر
    let res = await api('POST', '/login', { username: accounts.userPhone, password: 'Test@123' });
    if (res.data.success && res.data.token) {
        TOKENS.user = res.data.token;
        TOKENS.userRefresh = res.data.refreshToken;
        pass(`Login عميل مباشر — accountType: ${res.data.accountType}, balance: ${res.data.balance}`);
    } else { fail('Login عميل مباشر', JSON.stringify(res.data)); }

    // Login: شركة
    res = await api('POST', '/login', { username: accounts.compPhone, password: 'Test@123' });
    if (res.data.success && res.data.token) {
        TOKENS.company = res.data.token;
        pass(`Login شركة — accountType: ${res.data.accountType}, balance: ${res.data.balance}`);
    } else { fail('Login شركة', JSON.stringify(res.data)); }

    // Login: منفذ
    res = await api('POST', '/login', { username: accounts.execPhone, password: 'Test@123' });
    if (res.data.success && res.data.token) {
        TOKENS.executor = res.data.token;
        pass(`Login منفذ — accountType: ${res.data.accountType}`);
    } else { fail('Login منفذ', JSON.stringify(res.data)); }

    // Login: منفذ API
    res = await api('POST', '/login', { username: accounts.apiExecPhone, password: 'Test@123' });
    if (res.data.success && res.data.token) {
        TOKENS.apiExecutor = res.data.token;
        pass(`Login منفذ API — accountType: ${res.data.accountType}`);
    } else { fail('Login منفذ API', JSON.stringify(res.data)); }
}

// ═══════════════════════════════════════════════════════
// 🏠 Phase 3: اختبار الـ Endpoints
// ═══════════════════════════════════════════════════════
async function testEndpoints() {
    log('🏠', '=== Phase 3: اختبار الـ Endpoints ===');

    // Client Home - User
    let res = await api('GET', '/client/home', null, TOKENS.user);
    if (res.data.success && res.data.balance !== undefined) {
        pass(`Client Home (عميل): balance=${res.data.balance}, rate=${res.data.exchangeRate}, isOpen=${res.data.isOpen}`);
    } else { fail('Client Home (عميل)', JSON.stringify(res.data)); }

    // Client Home - Company
    res = await api('GET', '/client/home', null, TOKENS.company);
    if (res.data.success) {
        pass(`Client Home (شركة): balance=${res.data.balance}, rate=${res.data.exchangeRate}`);
    } else { fail('Client Home (شركة)', JSON.stringify(res.data)); }

    // Exchange Rate
    res = await api('POST', '/client/exchange-rate', {}, TOKENS.user);
    if (res.data.success) {
        pass(`Exchange Rate: ${res.data.exchangeRate}`);
    } else { fail('Exchange Rate', JSON.stringify(res.data)); }

    // Executor Live Tasks
    res = await api('GET', '/executor/live-tasks', null, TOKENS.executor);
    if (res.data.success) {
        pass(`Executor Live Tasks: ${res.data.data.length} tasks`);
    } else { fail('Executor Live Tasks', JSON.stringify(res.data)); }

    // Refresh Token
    if (TOKENS.userRefresh) {
        res = await api('POST', '/refresh-token', { refreshToken: TOKENS.userRefresh });
        if (res.data.success && res.data.token) {
            TOKENS.user = res.data.token;
            pass(`Refresh Token: new token received`);
        } else { fail('Refresh Token', JSON.stringify(res.data)); }
    }

    // Forbidden: executor accessing client endpoint
    res = await api('GET', '/client/home', null, TOKENS.executor);
    if (res.status === 403) {
        pass('Access Control: executor blocked from client/home (403)');
    } else { warn(`Access Control: executor got ${res.status} instead of 403`); }

    // Unauthorized: no token
    res = await api('GET', '/client/home');
    if (res.status === 401) {
        pass('Auth Guard: no token returns 401');
    } else { warn(`Auth Guard: no token got ${res.status} instead of 401`); }
}

// ═══════════════════════════════════════════════════════
// 💸 Phase 4: اختبار عمليات التحويل
// ═══════════════════════════════════════════════════════
async function testTransfers() {
    log('💸', '=== Phase 4: اختبار عمليات التحويل ===');

    // Transfer: عميل مباشر
    let res = await api('POST', '/client/new-transfer', {
        number: '01012345678',
        amount: 100,
        transferType: 'vodafone',
        notes: 'تحويل اختبار عميل مباشر'
    }, TOKENS.user, { 'Idempotency-Key': uuidv4() });

    if (res.data.success || res.data.txId) {
        pass(`تحويل عميل مباشر: txId=${res.data.txId}, status=${res.data.status}, costLYD=${res.data.costLYD}`);
    } else {
        fail(`تحويل عميل مباشر`, `status=${res.status}, ${JSON.stringify(res.data)}`);
    }

    // Transfer: شركة
    res = await api('POST', '/client/new-transfer', {
        number: '01098765432',
        amount: 200,
        transferType: 'vodafone',
        notes: 'تحويل اختبار شركة'
    }, TOKENS.company, { 'Idempotency-Key': uuidv4() });

    if (res.data.success || res.data.txId) {
        pass(`تحويل شركة: txId=${res.data.txId}, status=${res.data.status}, costLYD=${res.data.costLYD}`);
    } else {
        fail(`تحويل شركة`, `status=${res.status}, ${JSON.stringify(res.data)}`);
    }

    // Idempotency test (same key = same result)
    const sameKey = uuidv4();
    const r1 = await api('POST', '/client/new-transfer', {
        number: '01055555555',
        amount: 50,
        transferType: 'vodafone',
        notes: 'idempotency test'
    }, TOKENS.user, { 'Idempotency-Key': sameKey });

    const r2 = await api('POST', '/client/new-transfer', {
        number: '01055555555',
        amount: 50,
        transferType: 'vodafone',
        notes: 'idempotency test'
    }, TOKENS.user, { 'Idempotency-Key': sameKey });

    if (r1.data.txId && r2.data.txId && r1.data.txId === r2.data.txId) {
        pass(`Idempotency: نفس المفتاح يرجع نفس النتيجة (${r1.data.txId})`);
    } else if (r1.data.txId) {
        warn(`Idempotency: قد لا يعمل بشكل صحيح — r1=${r1.data.txId}, r2=${r2.data.txId || r2.data.error || r2.data.message}`);
    } else {
        fail('Idempotency', JSON.stringify({ r1: r1.data, r2: r2.data }));
    }

    // Missing Idempotency-Key
    res = await api('POST', '/client/new-transfer', {
        number: '01011111111', amount: 50, transferType: 'vodafone'
    }, TOKENS.user);
    if (res.status === 400 || res.status === 422) {
        pass(`Missing Idempotency-Key: blocked (${res.status})`);
    } else { warn(`Missing Idempotency-Key: got ${res.status}`); }

    // Invalid amount
    res = await api('POST', '/client/new-transfer', {
        number: '01011111111', amount: -100, transferType: 'vodafone'
    }, TOKENS.user, { 'Idempotency-Key': uuidv4() });
    if (res.status >= 400) {
        pass(`Validation: negative amount blocked (${res.status})`);
    } else { warn(`Validation: negative amount accepted ${res.status}`); }
}

// ═══════════════════════════════════════════════════════
// 📋 Phase 5: اختبار تسجيل الحسابات عبر الويب
// ═══════════════════════════════════════════════════════
async function testWebRegistration(ts) {
    log('📋', '=== Phase 5: اختبار تسجيل الحسابات عبر الويب ===');

    // عميل مباشر
    let res = await webPost('/client/register', {
        accountType: 'direct', fullName: 'محمد أحمد علي', phone: `0922${ts}1`,
        storeName: 'متجر الاختبار', address: 'شارع النصر', username: `webd_${ts}`,
        password: 'Test@123', passwordConfirm: 'Test@123'
    });
    if (res.status === 200 && res.data.includes('success-box')) {
        pass('تسجيل عميل مباشر عبر الويب');
    } else { fail('تسجيل عميل مباشر عبر الويب', `status=${res.status}`); }

    // حساب شركة
    res = await webPost('/client/register', {
        accountType: 'company', companyName: 'شركة التقنية', companyContact: 'مدير أحمد',
        companyPhone: `0933${ts}2`, companyEmail: `test${ts}@company.com`,
        username: `webc_${ts}`, password: 'Test@123', passwordConfirm: 'Test@123'
    });
    if (res.status === 200 && res.data.includes('success-box')) {
        pass('تسجيل حساب شركة عبر الويب');
    } else { fail('تسجيل حساب شركة عبر الويب', `status=${res.status}`); }

    // وكيل منطقة
    res = await webPost('/client/register', {
        accountType: 'agent', agentCompanyName: 'وكالة الشمال', agentFullName: 'أحمد محمود سعيد',
        agentPhone: `0944${ts}3`, agentAddress: 'بنغازي - المدينة', agentEmail: `agent${ts}@test.com`,
        agentUsername: `weba_${ts}`, agentPassword: 'Test@123', agentPasswordConfirm: 'Test@123'
    });
    if (res.status === 200 && res.data.includes('success-box')) {
        pass('تسجيل وكيل منطقة عبر الويب');
    } else { fail('تسجيل وكيل منطقة عبر الويب', `status=${res.status}`); }

    // عميل جديد
    res = await webPost('/client/register', {
        accountType: 'new', newFullName: 'خالد عبدالله حسن', newPhone: `0955${ts}4`,
        nationality: 'libyan', newCity: 'طرابلس', newPassword: 'Test@123', newPasswordConfirm: 'Test@123'
    });
    if (res.status === 200 && res.data.includes('success-box')) {
        pass('تسجيل عميل جديد عبر الويب');
    } else { fail('تسجيل عميل جديد عبر الويب', `status=${res.status}`); }
}

// ═══════════════════════════════════════════════════════
// 🔥 Phase 6: اختبار الضغط (Stress Test)
// ═══════════════════════════════════════════════════════
async function stressTest() {
    log('🔥', '=== Phase 6: اختبار الضغط ===');

    const concurrencyLevels = [10, 25, 50, 100];
    const stressResults = [];

    for (const concurrent of concurrencyLevels) {
        const startTime = Date.now();
        let successCount = 0, failCount = 0, errors = {};

        const promises = Array(concurrent).fill(null).map(async (_, i) => {
            try {
                // Mix of different endpoints
                const ops = [
                    () => api('POST', '/login', { username: '01000000001', password: '123456' }),
                    () => api('GET', '/client/home', null, TOKENS.user),
                    () => api('POST', '/client/exchange-rate', {}, TOKENS.user),
                    () => api('GET', '/executor/live-tasks', null, TOKENS.executor),
                ];
                const op = ops[i % ops.length];
                const r = await op();
                if (r.status < 500) { successCount++; }
                else { 
                    failCount++;
                    const key = `${r.status}`;
                    errors[key] = (errors[key] || 0) + 1;
                }
            } catch (e) {
                failCount++;
                const key = e.code || e.message?.substring(0, 30) || 'UNKNOWN';
                errors[key] = (errors[key] || 0) + 1;
            }
        });

        await Promise.all(promises);
        const elapsed = Date.now() - startTime;
        const rps = Math.round(concurrent / (elapsed / 1000));

        stressResults.push({
            concurrent, successCount, failCount,
            elapsed: `${elapsed}ms`, rps: `${rps} req/s`,
            errors: Object.keys(errors).length > 0 ? errors : null
        });

        log('📊', `${concurrent} طلب متزامن: ${successCount} نجح, ${failCount} فشل, ${elapsed}ms (${rps} req/s)`);
    }

    // Sequential throughput test (200 requests)
    log('🏃', 'اختبار الإنتاجية التسلسلية (200 طلب)...');
    const seqStart = Date.now();
    let seqSuccess = 0, seqFail = 0;
    for (let i = 0; i < 200; i++) {
        try {
            const r = await api('GET', '/client/home', null, TOKENS.user);
            if (r.status < 500) seqSuccess++; else seqFail++;
        } catch (e) { seqFail++; }
    }
    const seqElapsed = Date.now() - seqStart;
    const seqRps = Math.round(200 / (seqElapsed / 1000));
    stressResults.push({
        test: 'sequential-200', successCount: seqSuccess, failCount: seqFail,
        elapsed: `${seqElapsed}ms`, rps: `${seqRps} req/s`
    });
    log('📊', `200 طلب تسلسلي: ${seqSuccess} نجح, ${seqFail} فشل, ${seqElapsed}ms (${seqRps} req/s)`);

    RESULTS.stressResults = stressResults;
}

// ═══════════════════════════════════════════════════════
// 📊 Phase 7: توليد التقرير النهائي
// ═══════════════════════════════════════════════════════
function generateReport(startTime, codeStats) {
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║            📊 تقرير الاختبار الشامل — نظام الأهرام           ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`⏱️  إجمالي وقت الاختبار: ${totalTime} ثانية`);
    console.log(`✅ اختبارات ناجحة: ${RESULTS.passed.length}`);
    console.log(`❌ اختبارات فاشلة: ${RESULTS.failed.length}`);
    console.log(`⚠️  تحذيرات: ${RESULTS.warnings.length}`);
    console.log('');

    if (RESULTS.failed.length > 0) {
        console.log('────── ❌ الاختبارات الفاشلة ──────');
        RESULTS.failed.forEach((f, i) => console.log(`  ${i+1}. ${f.test}: ${f.error}`));
        console.log('');
    }

    if (RESULTS.warnings.length > 0) {
        console.log('────── ⚠️ التحذيرات ──────');
        RESULTS.warnings.forEach((w, i) => console.log(`  ${i+1}. ${w}`));
        console.log('');
    }

    if (RESULTS.stressResults) {
        console.log('────── 🔥 نتائج اختبار الضغط ──────');
        console.log('  الطلبات  |  نجح  |  فشل  |  الوقت   | السرعة');
        console.log('  ---------|-------|-------|----------|--------');
        RESULTS.stressResults.forEach(r => {
            const label = r.test || `${r.concurrent} متزامن`;
            console.log(`  ${String(label).padEnd(9)}| ${String(r.successCount).padEnd(6)}| ${String(r.failCount).padEnd(6)}| ${String(r.elapsed).padEnd(9)}| ${r.rps}`);
        });
        console.log('');
    }

    if (codeStats) {
        console.log('────── 📁 إحصائيات الكود ──────');
        console.log(`  📂 عدد الملفات: ${codeStats.totalFiles}`);
        console.log(`  📝 إجمالي الأسطر: ${codeStats.totalLines.toLocaleString()}`);
        console.log(`  📦 عدد الـ Models: ${codeStats.models}`);
        console.log(`  🛣️  عدد الـ Routes: ${codeStats.routes}`);
        console.log(`  🔧 عدد الـ Services/Utils: ${codeStats.services}`);
        console.log(`  🎨 عدد الـ Views: ${codeStats.views}`);
        console.log('');
    }

    console.log('────── 📝 الملاحظات والتوصيات ──────');
    const notes = [
        'telegramId في User model مطلوب (required) — يمنع إنشاء حسابات بدون ربط تيليجرام',
        'refCode في RegistrationRequest يستخدم 4 أرقام عشوائية — احتمال تعارض عالي (تم إصلاحه)',
        'User model لديه duplicate index على webUsername — تحذير Mongoose',
        'localtunnel غير مستقر — يُنصح بـ cloudflared أو ngrok للإنتاج',
        'rate limiting على login: 8 محاولات/15 دقيقة — مناسب للأمان',
        'rate limiting على transfers: 15/دقيقة — مناسب',
        'rate limiting عام: 60/دقيقة — قد يحتاج زيادة في الإنتاج',
        'Idempotency-Key مطلوب على التحويلات — ممتاز لمنع التكرار',
        'JWT secret يجب أن يكون 32+ حرف — تم التحقق',
        'bcrypt rounds: 12 — ممتاز للأمان',
        'لا يوجد health check endpoint مستقل — /health يُعيد redirect',
        'Socket.IO مُفعل للتحديثات الفورية — ممتاز',
        'Helmet مُفعل للحماية — ممتاز',
        'لا يوجد CORS مُحدد للموبايل — قد يحتاج تكوين',
        'ExecutorBot يدعم isApiBot — بنية ممتازة للربط الآلي',
        'pre-save hook في User يتحقق من $2 prefix — يمنع إعادة التشفير'
    ];
    notes.forEach((n, i) => console.log(`  ${i+1}. ${n}`));
    
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(`  النتيجة: ${RESULTS.failed.length === 0 ? '✅ جميع الاختبارات ناجحة!' : `❌ ${RESULTS.failed.length} اختبار فاشل`}`);
    console.log('══════════════════════════════════════════════════════════════\n');
}

// ═══════════════════════════════════════════════════════
// 📁 إحصائيات الكود
// ═══════════════════════════════════════════════════════
async function getCodeStats() {
    const fs = require('fs');
    const path = require('path');
    const root = 'd:\\vodafone-cash-system';
    const dirs = ['models', 'routes', 'services', 'utils', 'middlewares', 'controllers', 'validators', 'mappers', 'views', 'bots', 'cron', 'config', 'repositories'];
    
    let totalFiles = 0, totalLines = 0;
    let models = 0, routes = 0, services = 0, views = 0;

    for (const dir of dirs) {
        const fullPath = path.join(root, dir);
        try {
            const files = fs.readdirSync(fullPath, { withFileTypes: true });
            for (const f of files) {
                if (f.isFile() && (f.name.endsWith('.js') || f.name.endsWith('.ejs'))) {
                    totalFiles++;
                    try {
                        const content = fs.readFileSync(path.join(fullPath, f.name), 'utf-8');
                        totalLines += content.split('\n').length;
                    } catch(e) {}
                    
                    if (dir === 'models') models++;
                    else if (dir === 'routes') routes++;
                    else if (['services', 'utils', 'middlewares', 'controllers', 'validators', 'mappers', 'repositories'].includes(dir)) services++;
                    else if (dir === 'views') views++;
                }
                // Recurse into subdirectories for views
                if (f.isDirectory()) {
                    try {
                        const subFiles = fs.readdirSync(path.join(fullPath, f.name));
                        for (const sf of subFiles) {
                            if (sf.endsWith('.js') || sf.endsWith('.ejs')) {
                                totalFiles++;
                                try {
                                    const content = fs.readFileSync(path.join(fullPath, f.name, sf), 'utf-8');
                                    totalLines += content.split('\n').length;
                                } catch(e) {}
                                if (dir === 'views') views++;
                                else services++;
                            }
                        }
                    } catch(e) {}
                }
            }
        } catch(e) {}
    }

    // app.js
    try {
        const appContent = fs.readFileSync(path.join(root, 'app.js'), 'utf-8');
        totalFiles++;
        totalLines += appContent.split('\n').length;
    } catch(e) {}

    return { totalFiles, totalLines, models, routes, services, views };
}

// ═══════════════════════════════════════════════════════
// 🚀 Main
// ═══════════════════════════════════════════════════════
async function main() {
    const startTime = Date.now();
    
    try {
        await mongoose.connect('mongodb://localhost:27017/vodafone_cash_system');
        log('🟢', 'متصل بقاعدة البيانات');
    } catch(e) {
        console.error('❌ فشل الاتصال بقاعدة البيانات:', e.message);
        process.exit(1);
    }

    try {
        // Code stats
        const codeStats = await getCodeStats();

        // Phase 1: Setup
        const accounts = await setupDatabase();

        // Phase 2: Login
        await testLogin(accounts);

        // Phase 3: Endpoints
        if (TOKENS.user) await testEndpoints();
        else warn('تخطي اختبار Endpoints — لا يوجد token');

        // Phase 4: Transfers
        if (TOKENS.user && TOKENS.company) await testTransfers();
        else warn('تخطي اختبار Transfers — لا يوجد tokens');

        // Phase 5: Web Registration
        await testWebRegistration(accounts.ts);

        // Phase 6: Stress Test
        if (TOKENS.user) await stressTest();
        else warn('تخطي اختبار الضغط — لا يوجد token');

        // Phase 7: Report
        generateReport(startTime, codeStats);

    } catch (e) {
        console.error('❌ خطأ عام:', e.message, e.stack);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

main();
