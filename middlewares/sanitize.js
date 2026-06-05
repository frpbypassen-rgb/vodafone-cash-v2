// middlewares/sanitize.js
// دالات مساعدة لتعقيم المدخلات وحماية قاعدة البيانات

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

module.exports = { escapeRegex, buildSearchQuery, pickAllowed, isValidObjectId };
