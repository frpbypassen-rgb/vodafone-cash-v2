// middlewares/sanitize.js
// 🚀 Production-Ready Input Sanitization & Security Middleware
// دالات مساعدة لتعقيم المدخلات وحماية قاعدة البيانات

const { sanitizeInput, isSafeForMongo } = require('../utils/productionEnhancements');
const logger = require('../utils/logger');

/**
 * middleware لتعقيم جميع المدخلات في الطلب
 */
const sanitizeMiddleware = (req, res, next) => {
    try {
        // تعقيم body
        if (req.body && typeof req.body === 'object') {
            req.body = sanitizeInput(req.body);
        }
        
        // تعقيم query parameters
        if (req.query && typeof req.query === 'object') {
            req.query = sanitizeInput(req.query);
        }
        
        // تعقيم params
        if (req.params && typeof req.params === 'object') {
            req.params = sanitizeInput(req.params);
        }
        
        next();
    } catch (error) {
        logger.error('Sanitization failed', { error: error.message, url: req.originalUrl });
        next(error);
    }
};

/**
 * middleware للتحقق من أمان مدخلات MongoDB
 */
const mongoSecurityMiddleware = (req, res, next) => {
    try {
        // فحص body
        if (req.body && typeof req.body === 'object') {
            if (!isSafeForMongo(req.body)) {
                logger.warn('Potential NoSQL injection detected', {
                    url: req.originalUrl,
                    method: req.method,
                    ip: req.ip
                });
                return res.status(400).json({
                    success: false,
                    error: 'تم اكتشاف مدخلات غير آمنة'
                });
            }
        }
        
        // فحص query
        if (req.query && typeof req.query === 'object') {
            if (!isSafeForMongo(req.query)) {
                logger.warn('Potential NoSQL injection detected in query', {
                    url: req.originalUrl,
                    method: req.method,
                    ip: req.ip
                });
                return res.status(400).json({
                    success: false,
                    error: 'تم اكتشاف مدخلات غير آمنة في الاستعلام'
                });
            }
        }
        
        next();
    } catch (error) {
        logger.error('Mongo security check failed', { error: error.message, url: req.originalUrl });
        next(error);
    }
};

/**
 * تعقيم النصوص من الأحرف الخاصة في Regex لمنع ReDoS و NoSQL Injection
 * @param {string} str - النص المراد تعقيمه
 * @returns {string} النص المعقّم
 */
const escapeRegex = (str) => {
    if (!str || typeof str !== 'string') return '';
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * بناء شرط بحث آمن بـ Regex لـ MongoDB
 * @param {string} searchTerm - مصطلح البحث
 * @param {string[]} fields - الحقول المراد البحث فيها
 * @returns {object|null} شرط $or للاستعلام أو null إذا كان البحث فارغاً
 */
const buildSearchQuery = (searchTerm, fields = []) => {
    if (!searchTerm || !searchTerm.trim()) return null;
    const safe = escapeRegex(searchTerm.trim());
    const regex = { $regex: safe, $options: 'i' };
    return { $or: fields.map(field => ({ [field]: regex })) };
};

/**
 * تصفية الكائن بحيث يحتوي فقط على الحقول المسموحة (Whitelist)
 * @param {object} obj - الكائن المراد تصفيته
 * @param {string[]} allowedFields - الحقول المسموحة
 * @returns {object} الكائن المُصفّى
 */
const pickAllowed = (obj, allowedFields = []) => {
    if (!obj || typeof obj !== 'object') return {};
    const result = {};
    for (const field of allowedFields) {
        if (obj[field] !== undefined) {
            result[field] = obj[field];
        }
    }
    return result;
};

/**
 * التحقق من صحة MongoDB ObjectId
 * @param {string} id - المعرف المراد التحقق منه
 * @returns {boolean}
 */
const isValidObjectId = (id) => {
    if (!id) return false;
    return /^[0-9a-fA-F]{24}$/.test(id.toString());
};

module.exports = { 
    escapeRegex, 
    buildSearchQuery, 
    pickAllowed, 
    isValidObjectId,
    sanitizeMiddleware,
    mongoSecurityMiddleware
};
