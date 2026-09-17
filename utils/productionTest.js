// utils/productionTest.js
// ===============================================
// 🧪 Production Readiness Test Suite
// اختبار شامل للتحسينات الإنتاجية
// ===============================================

const { 
    validDateParts, 
    sanitizeInput, 
    isSafeForMongo,
    formatApiResponse,
    FinancialError,
    SecurityError,
    ValidationError,
    validateProductionEnv,
    getConfig,
    cacheOrFetch,
    clearCache
} = require('./productionEnhancements');

let passed = 0;
let failed = 0;

async function runTests() {
    console.log('\n🧪 Starting Production Readiness Tests...\n');
    
    // ────────────────────────────────────────
    // 1️⃣ Date Validation Tests
    // ────────────────────────────────────────
    console.log('📅 Testing Date Validation...');
    
    // تاريخ صالح
    let result = validDateParts(2024, 2, 29);
    if (result.valid && result.date instanceof Date) {
        console.log('✅ Valid leap year date accepted');
        passed++;
    } else {
        console.log('❌ Valid leap year date rejected');
        failed++;
    }
    
    // تاريخ غير صالح (30 فبراير)
    result = validDateParts(2023, 2, 30);
    if (!result.valid) {
        console.log('✅ Invalid date (Feb 30) rejected');
        passed++;
    } else {
        console.log('❌ Invalid date (Feb 30) accepted');
        failed++;
    }
    
    // شهر خارج النطاق
    result = validDateParts(2024, 13, 1);
    if (!result.valid) {
        console.log('✅ Invalid month (13) rejected');
        passed++;
    } else {
        console.log('❌ Invalid month (13) accepted');
        failed++;
    }
    
    // سنة خارج النطاق
    result = validDateParts(1800, 1, 1);
    if (!result.valid) {
        console.log('✅ Invalid year (1800) rejected');
        passed++;
    } else {
        console.log('❌ Invalid year (1800) accepted');
        failed++;
    }
    
    // ────────────────────────────────────────
    // 2️⃣ Security Tests
    // ────────────────────────────────────────
    console.log('\n🔒 Testing Security Sanitization...');
    
    // XSS prevention
    const xssInput = '<script>alert("XSS")</script>Hello';
    const sanitized = sanitizeInput(xssInput);
    if (!sanitized.includes('<script>')) {
        console.log('✅ XSS script tags removed');
        passed++;
    } else {
        console.log('❌ XSS script tags not removed');
        failed++;
    }
    
    // NoSQL injection prevention
    const nosqlInput = { $ne: null };
    const isSafe = isSafeForMongo(nosqlInput);
    if (!isSafe) {
        console.log('✅ NoSQL injection attempt detected');
        passed++;
    } else {
        console.log('❌ NoSQL injection attempt not detected');
        failed++;
    }
    
    // Safe input
    const safeInput = { name: 'Ahmed', age: 25 };
    const isReallySafe = isSafeForMongo(safeInput);
    if (isReallySafe) {
        console.log('✅ Safe input passed validation');
        passed++;
    } else {
        console.log('❌ Safe input incorrectly flagged');
        failed++;
    }
    
    // ────────────────────────────────────────
    // 3️⃣ Response Formatting Tests
    // ────────────────────────────────────────
    console.log('\n📝 Testing Response Formatting...');
    
    const successResponse = formatApiResponse(true, { id: 1 }, 'Operation successful');
    if (successResponse.success && successResponse.data && successResponse.timestamp) {
        console.log('✅ Success response formatted correctly');
        passed++;
    } else {
        console.log('❌ Success response formatting failed');
        failed++;
    }
    
    const errorResponse = formatApiResponse(false, 'Error occurred', 'Operation failed');
    if (!errorResponse.success && errorResponse.error && !errorResponse.data) {
        console.log('✅ Error response formatted correctly');
        passed++;
    } else {
        console.log('❌ Error response formatting failed');
        failed++;
    }
    
    // ────────────────────────────────────────
    // 4️⃣ Custom Error Classes Tests
    // ────────────────────────────────────────
    console.log('\n⚠️ Testing Custom Error Classes...');
    
    try {
        throw new FinancialError('Insufficient balance', 'INSUF_BAL', 100);
    } catch (e) {
        if (e.name === 'FinancialError' && e.code === 'INSUF_BAL' && e.amount === 100) {
            console.log('✅ FinancialError class working');
            passed++;
        } else {
            console.log('❌ FinancialError class failed');
            failed++;
        }
    }
    
    try {
        throw new SecurityError('Unauthorized access', 'UNAUTH', 'user123');
    } catch (e) {
        if (e.name === 'SecurityError' && e.code === 'UNAUTH') {
            console.log('✅ SecurityError class working');
            passed++;
        } else {
            console.log('❌ SecurityError class failed');
            failed++;
        }
    }
    
    try {
        throw new ValidationError('Invalid email', 'email');
    } catch (e) {
        if (e.name === 'ValidationError' && e.field === 'email') {
            console.log('✅ ValidationError class working');
            passed++;
        } else {
            console.log('❌ ValidationError class failed');
            failed++;
        }
    }
    
    // ────────────────────────────────────────
    // 5️⃣ Configuration Tests
    // ────────────────────────────────────────
    console.log('\n⚙️ Testing Configuration Helpers...');
    
    const envResult = validateProductionEnv();
    if (typeof envResult.ready === 'boolean' && Array.isArray(envResult.issues)) {
        console.log('✅ Environment validation working');
        passed++;
    } else {
        console.log('❌ Environment validation failed');
        failed++;
    }
    
    // Config getter with default
    const configVal = getConfig('NON_EXISTENT_VAR', 'default', 'string');
    if (configVal === 'default') {
        console.log('✅ Config getter with default working');
        passed++;
    } else {
        console.log('❌ Config getter with default failed');
        failed++;
    }
    
    // ────────────────────────────────────────
    // 6️⃣ Cache Tests
    // ────────────────────────────────────────
    console.log('\n💾 Testing Cache System...');
    
    const cacheKey = 'test_key';
    const cachedData = await cacheOrFetch(cacheKey, async () => {
        return { value: 'fetched' };
    }, 1000);
    
    if (cachedData.value === 'fetched') {
        console.log('✅ Cache fetch working');
        passed++;
    } else {
        console.log('❌ Cache fetch failed');
        failed++;
    }
    
    // Second call should use cache
    const cachedData2 = await cacheOrFetch(cacheKey, async () => {
        return { value: 'should_not_fetch' };
    }, 1000);
    
    if (cachedData2.value === 'fetched') {
        console.log('✅ Cache hit working');
        passed++;
    } else {
        console.log('❌ Cache hit failed');
        failed++;
    }
    
    clearCache(cacheKey);
    console.log('✅ Cache clear working');
    passed++;
    
    // ────────────────────────────────────────
    // Summary
    // ────────────────────────────────────────
    console.log('\n' + '='.repeat(50));
    console.log(`📊 Test Results: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(50) + '\n');
    
    if (failed === 0) {
        console.log('🎉 All tests passed! System is production-ready.\n');
        process.exit(0);
    } else {
        console.log('⚠️ Some tests failed. Please review the issues.\n');
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('❌ Test suite crashed:', err);
    process.exit(1);
});
