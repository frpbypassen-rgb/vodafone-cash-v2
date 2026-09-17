// utils/productionEnhancements.js
// ===============================================
// 🚀 Production Readiness Enhancements Module
// يجمع كل التحسينات المطلوبة للإنتاج في ملف واحد
// ===============================================

const moment = require('moment-timezone');
const { v4: validateUUID } = require('uuid'); // Fix for uuid v14 ESM compatibility
const mongoose = require('mongoose');
const winston = require('winston');
const { body, param, query, validationResult } = require('express-validator');
const path = require('path');
const fs = require('fs');

const { SYSTEM_TIME_ZONE } = require('../config/systemTime');

// ────────────────────────────────────────────────────────────
// 1️⃣ تحسين التحقق من صحة التاريخ (Date Validation)
// ────────────────────────────────────────────────────────────

/**
 * التحقق من صحة التاريخ بطريقة آمنة باستخدام moment
 * @param {number} year - السنة
 * @param {number} month - الشهر (1-12)
 * @param {number} day - اليوم (1-31)
 * @returns {object} { valid: boolean, date: Date|null, error: string|null }
 */
const validDateParts = (year, month, day) => {
    try {
        // التحقق من أن القيم أرقام صحيحة
        const y = parseInt(year, 10);
        const m = parseInt(month, 10);
        const d = parseInt(day, 10);

        if (isNaN(y) || isNaN(m) || isNaN(d)) {
            return { valid: false, date: null, error: 'القيم المدخلة ليست أرقاماً صحيحة' };
        }

        // التحقق من النطاقات المقبولة
        if (m < 1 || m > 12) {
            return { valid: false, date: null, error: 'الشهر يجب أن يكون بين 1 و 12' };
        }

        if (d < 1 || d > 31) {
            return { valid: false, date: null, error: 'اليوم يجب أن يكون بين 1 و 31' };
        }

        if (y < 1900 || y > 2100) {
            return { valid: false, date: null, error: 'السنة يجب أن تكون بين 1900 و 2100' };
        }

        // استخدام moment للتحقق من صلاحية التاريخ
        const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const mDate = moment.tz(dateStr, SYSTEM_TIME_ZONE);

        // التحقق من أن التاريخ صحيح (مثلاً 30 فبراير سيرفض)
        if (!mDate.isValid() || 
            mDate.year() !== y || 
            mDate.month() !== m - 1 || 
            mDate.date() !== d) {
            return { valid: false, date: null, error: 'التاريخ غير صالح' };
        }

        return { valid: true, date: mDate.toDate(), error: null };
    } catch (error) {
        return { valid: false, date: null, error: `خطأ في التحقق من التاريخ: ${error.message}` };
    }
};

/**
 * تنسيق التاريخ بتوقيت طرابلس
 * @param {Date|string} date - التاريخ
 * @param {string} format - صيغة التنسيق
 * @returns {string} التاريخ المنسق
 */
const formatDateLibya = (date, format = 'YYYY-MM-DD HH:mm:ss') => {
    return moment.tz(date, SYSTEM_TIME_ZONE).format(format);
};

/**
 * الحصول على بداية ونهاية اليوم بتوقيت طرابلس
 * @param {Date|string} date - التاريخ (اختياري، الافتراضي اليوم)
 * @returns {object} { start: Date, end: Date }
 */
const getDayRangeLibya = (date = new Date()) => {
    const mDate = moment.tz(date, SYSTEM_TIME_ZONE);
    return {
        start: mDate.clone().startOf('day').toDate(),
        end: mDate.clone().endOf('day').toDate()
    };
};

// ────────────────────────────────────────────────────────────
// 2️⃣ تحسين الأمان (Security Enhancements)
// ────────────────────────────────────────────────────────────

/**
 * تعقيم متقدم للمدخلات لمنع XSS و NoSQL Injection
 * @param {any} input - القيمة المراد تعقيمها
 * @returns {any} القيمة المعقمة
 */
const sanitizeInput = (input) => {
    if (input === null || input === undefined) return input;
    
    if (typeof input === 'string') {
        // إزالة سكريبتات XSS
        let sanitized = input
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, '')
            .trim();
        
        // منع أحخاص MongoDB الخاصة
        if (sanitized.startsWith('$') || sanitized.includes('.')) {
            sanitized = sanitized.replace(/[$.]/g, '_');
        }
        
        return sanitized;
    }
    
    if (Array.isArray(input)) {
        return input.map(item => sanitizeInput(item));
    }
    
    if (typeof input === 'object' && input.constructor === Object) {
        const sanitized = {};
        for (const [key, value] of Object.entries(input)) {
            // منع مفاتيح تبدأ بـ $ أو تحتوي على .
            const safeKey = key.replace(/[$.]/g, '_');
            sanitized[safeKey] = sanitizeInput(value);
        }
        return sanitized;
    }
    
    return input;
};

/**
 * التحقق من أن الكائن لا يحتوي على عمليات MongoDB خطرة
 * @param {object} obj - الكائن المراد فحصه
 * @returns {boolean} true إذا كان آمناً
 */
const isSafeForMongo = (obj) => {
    if (!obj || typeof obj !== 'object') return true;
    
    for (const key in obj) {
        if (key.startsWith('$') || key.includes('.')) {
            return false;
        }
        if (typeof obj[key] === 'object') {
            if (!isSafeForMongo(obj[key])) return false;
        }
    }
    return true;
};

// ────────────────────────────────────────────────────────────
// 3️⃣ تحسين الأداء (Performance Optimizations)
// ────────────────────────────────────────────────────────────

/**
 * إنشاء فهارس ذكية للاستعلامات الشائعة
 * @param {mongoose.Model} model - الموديل
 * @param {Array} indexes - مصفوفة الفهارس
 */
const createSmartIndexes = async (model, indexes) => {
    try {
        for (const index of indexes) {
            const [fields, options] = index;
            await model.createIndex(fields, options);
        }
        console.log(`✅ Smart indexes created for ${model.modelName}`);
    } catch (error) {
        console.error(`❌ Failed to create indexes for ${model.modelName}:`, error.message);
    }
};

/**
 * كاش بسيط في الذاكرة للاستعلامات المتكررة
 */
const memoryCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 دقائق

/**
 * جلب من الكاش أو تنفيذ الدالة
 * @param {string} key - مفتاح الكاش
 * @param {Function} fetchFn - دالة الجلب
 * @param {number} ttl - وقت الصلاحية بالميلي ثانية
 * @returns {Promise<any>}
 */
const cacheOrFetch = async (key, fetchFn, ttl = CACHE_TTL) => {
    const cached = memoryCache.get(key);
    if (cached && Date.now() - cached.timestamp < ttl) {
        return cached.data;
    }
    
    const data = await fetchFn();
    memoryCache.set(key, { data, timestamp: Date.now() });
    
    // تنظيف الكاش القديم كل ساعة
    if (memoryCache.size > 1000) {
        const now = Date.now();
        for (const [k, v] of memoryCache.entries()) {
            if (now - v.timestamp > ttl) {
                memoryCache.delete(k);
            }
        }
    }
    
    return data;
};

/**
 * مسح الكاش
 * @param {string} key - المفتاح (اختياري، إذا لم يُحدد يمسح الكل)
 */
const clearCache = (key) => {
    if (key) {
        memoryCache.delete(key);
    } else {
        memoryCache.clear();
    }
};

// ────────────────────────────────────────────────────────────
// 4️⃣ تسجيل الأخطاء المتقدم (Advanced Error Logging)
// ────────────────────────────────────────────────────────────

/**
 * إنشاء مسجل أخطاء مخصص
 * @param {string} serviceName - اسم الخدمة
 * @returns {winston.Logger}
 */
const createErrorLogger = (serviceName) => {
    const logDir = path.join(__dirname, '..', 'logs', 'errors');
    
    // إنشاء المجلد إذا لم يكن موجوداً
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    
    return winston.createLogger({
        level: 'error',
        format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            winston.format.json()
        ),
        defaultMeta: { service: serviceName },
        transports: [
            new winston.transports.File({
                filename: path.join(logDir, `${serviceName}-error.log`),
                maxsize: 10 * 1024 * 1024,
                maxFiles: 10,
                tailable: true
            }),
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.printf(({ timestamp, level, message, service, stack }) => {
                        return `${timestamp} [${service}] ${level}: ${message}${stack ? '\n' + stack : ''}`;
                    })
                )
            })
        ]
    });
};

/**
 * تسجيل خطأ مع سياق كامل
 * @param {winston.Logger} logger - المسجل
 * @param {Error} error - الخطأ
 * @param {object} context - السياق الإضافي
 */
const logErrorWithContext = (logger, error, context = {}) => {
    logger.error(error.message, {
        stack: error.stack,
        name: error.name,
        code: error.code,
        ...context
    });
};

// ────────────────────────────────────────────────────────────
// 5️⃣ اختبارات الوحدات الأساسية (Basic Unit Tests Helper)
// ────────────────────────────────────────────────────────────

/**
 * تشغيل اختبار بسيط
 * @param {string} name - اسم الاختبار
 * @param {Function} testFn - دالة الاختبار
 */
const runTest = async (name, testFn) => {
    try {
        await testFn();
        console.log(`✅ PASS: ${name}`);
        return true;
    } catch (error) {
        console.error(`❌ FAIL: ${name}`);
        console.error(`   Error: ${error.message}`);
        return false;
    }
};

/**
 * التأكيد من شرط
 * @param {boolean} condition - الشرط
 * @param {string} message - رسالة الخطأ
 */
const assert = (condition, message) => {
    if (!condition) {
        throw new Error(message || 'Assertion failed');
    }
};

/**
 * التأكيد من تساوي قيمتين
 * @param {any} actual - القيمة الفعلية
 * @param {any} expected - القيمة المتوقعة
 * @param {string} message - رسالة الخطأ
 */
const assertEquals = (actual, expected, message) => {
    if (actual !== expected) {
        throw new Error(message || `Expected ${expected}, got ${actual}`);
    }
};

// ────────────────────────────────────────────────────────────
// 6️⃣ توحيد تنسيق الرسائل (Unified Response Format)
// ────────────────────────────────────────────────────────────

/**
 * تنسيق رد API موحد
 * @param {boolean} success - هل نجحت العملية
 * @param {any} data - البيانات
 * @param {string} message - الرسالة
 * @param {object} meta - بيانات إضافية
 * @returns {object}
 */
const formatApiResponse = (success, data = null, message = '', meta = {}) => {
    const response = {
        success,
        timestamp: new Date().toISOString(),
        version: '2.0.0'
    };
    
    if (success) {
        response.data = data;
        response.message = message || 'تمت العملية بنجاح';
    } else {
        response.error = data || 'حدث خطأ غير متوقع';
        response.message = message || 'فشلت العملية';
    }
    
    if (Object.keys(meta).length > 0) {
        response.meta = meta;
    }
    
    return response;
};

/**
 * معالجة موحدة للأخطاء في Express
 * @param {Error} err - الخطأ
 * @param {object} req - الطلب
 * @param {object} res - الاستجابة
 * @param {Function} next - الدالة التالية
 */
const unifiedErrorHandler = (err, req, res, next) => {
    const isAPI = req.originalUrl.startsWith('/api') || 
                  req.originalUrl.startsWith('/client') || 
                  req.originalUrl.startsWith('/executor-portal') ||
                  req.xhr;
    
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    const errorResponse = formatApiResponse(
        false,
        process.env.NODE_ENV === 'production' ? 'حدث خطأ داخلي' : err.message,
        'يرجى المحاولة لاحقاً',
        { 
            code: err.code,
            name: err.name,
            path: req.originalUrl,
            method: req.method
        }
    );
    
    if (isAPI) {
        res.status(statusCode).json(errorResponse);
    } else {
        res.status(statusCode).send(`
            <div style="text-align:center;padding:50px;font-family:sans-serif;background:#f8fafc;min-height:100vh;">
                <div style="background:white;padding:40px;border-radius:20px;box-shadow:0 10px 25px rgba(0,0,0,0.05);max-width:500px;margin:0 auto;">
                    <h1 style="color:#ef4444;font-size:50px;margin-bottom:10px;">⚠️</h1>
                    <h2 style="color:#1e293b;">${errorResponse.message}</h2>
                    <p style="color:#64748b;margin-bottom:30px;">${errorResponse.error}</p>
                    <a href="/" style="padding:12px 25px;background:#3b82f6;color:white;text-decoration:none;border-radius:10px;font-weight:bold;">العودة للرئيسية</a>
                </div>
            </div>
        `);
    }
};

// ────────────────────────────────────────────────────────────
// 7️⃣ التوثيق المدمج (Built-in Documentation)
// ────────────────────────────────────────────────────────────

/**
 * إضافة توثيق مدمج للدوال
 * @param {Function} fn - الدالة
 * @param {object} doc - التوثيق
 * @returns {Function} الدالة مع التوثيق
 */
const documentFunction = (fn, doc) => {
    fn.__doc = doc;
    return fn;
};

/**
 * استخراج التوثيق من وحدة
 * @param {object} module - الوحدة
 * @returns {object} التوثيق
 */
const extractDocumentation = (module) => {
    const docs = {};
    for (const [key, value] of Object.entries(module)) {
        if (typeof value === 'function' && value.__doc) {
            docs[key] = value.__doc;
        }
    }
    return docs;
};

// ────────────────────────────────────────────────────────────
// 8️⃣ التحقق من التبعيات (Dependency Health Check)
// ────────────────────────────────────────────────────────────

/**
 * التحقق من صحة التبعيات الحرجة
 * @returns {object} حالة التبعيات
 */
const checkDependencies = async () => {
    const results = {
        mongoose: false,
        moment: false,
        winston: false,
        expressValidator: false
    };
    
    try {
        results.mongoose = mongoose.connection.readyState === 1;
    } catch (e) {
        results.mongoose = false;
    }
    
    try {
        results.moment = moment().isValid();
    } catch (e) {
        results.moment = false;
    }
    
    try {
        const logger = winston.createLogger({ transports: [] });
        results.winston = !!logger;
    } catch (e) {
        results.winston = false;
    }
    
    try {
        results.expressValidator = !!body && !!param && !!query;
    } catch (e) {
        results.expressValidator = false;
    }
    
    return results;
};

/**
 * تقرير جاهزية النظام
 * @returns {object} التقرير
 */
const getSystemReadinessReport = async () => {
    const deps = await checkDependencies();
    const allDepsOk = Object.values(deps).every(v => v);
    
    return {
        ready: allDepsOk,
        dependencies: deps,
        timestamp: new Date().toISOString(),
        version: '2.0.0',
        timezone: SYSTEM_TIME_ZONE
    };
};

// ────────────────────────────────────────────────────────────
// 9️⃣ معالجة شاملة للأخطاء (Comprehensive Error Handling)
// ────────────────────────────────────────────────────────────

/**
 * فئة خطأ مخصصة للعمليات المالية
 */
class FinancialError extends Error {
    constructor(message, code, amount = null) {
        super(message);
        this.name = 'FinancialError';
        this.code = code;
        this.amount = amount;
        this.timestamp = new Date().toISOString();
    }
}

/**
 * فئة خطأ مخصصة للأمان
 */
class SecurityError extends Error {
    constructor(message, code, userId = null) {
        super(message);
        this.name = 'SecurityError';
        this.code = code;
        this.userId = userId;
        this.timestamp = new Date().toISOString();
    }
}

/**
 * فئة خطأ مخصصة للتحقق من الصحة
 */
class ValidationError extends Error {
    constructor(message, field = null) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
        this.timestamp = new Date().toISOString();
    }
}

/**
 * معالجة خطأ مع إعادة المحاولة
 * @param {Function} fn - الدالة
 * @param {number} retries - عدد المحاولات
 * @param {number} delay - التأخير بالميلي ثانية
 * @returns {Promise<any>}
 */
const retryOnError = async (fn, retries = 3, delay = 1000) => {
    let lastError;
    
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (i < retries - 1) {
                console.warn(`⚠️ Attempt ${i + 1} failed, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
            }
        }
    }
    
    throw lastError;
};

// ────────────────────────────────────────────────────────────
// 🔟 تحسين التكوين (Configuration Enhancement)
// ────────────────────────────────────────────────────────────

/**
 * تحميل تكوين آمن
 * @param {string} key - المفتاح
 * @param {any} defaultValue - القيمة الافتراضية
 * @param {string} type - النوع (string, number, boolean, json)
 * @returns {any}
 */
const getConfig = (key, defaultValue = null, type = 'string') => {
    const value = process.env[key];
    
    if (value === undefined || value === null) {
        return defaultValue;
    }
    
    switch (type) {
        case 'number':
            const num = Number(value);
            return isNaN(num) ? defaultValue : num;
        
        case 'boolean':
            return value.toLowerCase() === 'true';
        
        case 'json':
            try {
                return JSON.parse(value);
            } catch (e) {
                return defaultValue;
            }
        
        default:
            return value;
    }
};

/**
 * التحقق من وجود متغيرات البيئة الحرجة
 * @param {Array<string>} requiredVars - المتغيرات المطلوبة
 * @returns {object} { valid: boolean, missing: Array<string> }
 */
const validateEnvVars = (requiredVars = []) => {
    const missing = [];
    
    for (const variable of requiredVars) {
        if (!process.env[variable]) {
            missing.push(variable);
        }
    }
    
    return {
        valid: missing.length === 0,
        missing,
        count: missing.length
    };
};

/**
 * قائمة المتغيرات الحرجة المطلوبة للإنتاج
 */
const CRITICAL_ENV_VARS = [
    'MONGO_URI',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'SESSION_SECRET',
    'NODE_ENV'
];

/**
 * التحقق من جاهزية البيئة للإنتاج
 * @returns {object} التقرير
 */
const validateProductionEnv = () => {
    const envCheck = validateEnvVars(CRITICAL_ENV_VARS);
    const isProd = process.env.NODE_ENV === 'production';
    
    const issues = [];
    
    if (!envCheck.valid) {
        issues.push(`Missing environment variables: ${envCheck.missing.join(', ')}`);
    }
    
    if (isProd) {
        if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32) {
            issues.push('SESSION_SECRET is too short for production (min 32 characters)');
        }
        
        if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
            issues.push('JWT_SECRET is too short for production (min 32 characters)');
        }
    }
    
    return {
        ready: issues.length === 0,
        isProduction: isProd,
        envValid: envCheck.valid,
        issues,
        timestamp: new Date().toISOString()
    };
};

// ────────────────────────────────────────────────────────────
// تصدير جميع الدوال
// ────────────────────────────────────────────────────────────

module.exports = {
    // Date & Time
    validDateParts,
    formatDateLibya,
    getDayRangeLibya,
    
    // Security
    sanitizeInput,
    isSafeForMongo,
    
    // Performance
    createSmartIndexes,
    cacheOrFetch,
    clearCache,
    
    // Logging
    createErrorLogger,
    logErrorWithContext,
    
    // Testing
    runTest,
    assert,
    assertEquals,
    
    // Response Formatting
    formatApiResponse,
    unifiedErrorHandler,
    
    // Documentation
    documentFunction,
    extractDocumentation,
    
    // Health Checks
    checkDependencies,
    getSystemReadinessReport,
    
    // Error Classes
    FinancialError,
    SecurityError,
    ValidationError,
    retryOnError,
    
    // Configuration
    getConfig,
    validateEnvVars,
    validateProductionEnv,
    CRITICAL_ENV_VARS
};
