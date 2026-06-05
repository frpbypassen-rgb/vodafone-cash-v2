// services/passwordService.js
// خدمة مركزية لإدارة كلمات المرور — تشفير، مقارنة، وترقية تلقائية

const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

/**
 * تشفير كلمة مرور جديدة
 * @param {string} plainPassword - كلمة المرور كنص عادي
 * @returns {Promise<string>} كلمة المرور المشفرة
 */
const hashPassword = async (plainPassword) => {
    if (!plainPassword) throw new Error('كلمة المرور مطلوبة');
    return await bcrypt.hash(plainPassword.trim(), SALT_ROUNDS);
};

/**
 * مقارنة كلمة مرور مع الهاش المخزّن
 * @param {string} plainPassword - كلمة المرور كنص عادي
 * @param {string} hashedPassword - الهاش المخزّن في قاعدة البيانات
 * @returns {Promise<boolean>}
 */
const verifyPassword = async (plainPassword, hashedPassword) => {
    if (!plainPassword || !hashedPassword) return false;
    // إذا كانت كلمة المرور مشفرة بـ bcrypt
    if (hashedPassword.startsWith('$2')) {
        return await bcrypt.compare(plainPassword.trim(), hashedPassword);
    }
    // كلمة مرور قديمة (نص عادي) — مقارنة مباشرة
    return plainPassword.trim() === hashedPassword;
};

/**
 * ترقية كلمة مرور من نص عادي إلى bcrypt إذا لزم الأمر
 * يُستخدم عند تسجيل الدخول الأول بعد الترحيل
 * @param {object} Model - نموذج Mongoose
 * @param {string} docId - معرف الوثيقة
 * @param {string} plainPassword - كلمة المرور كنص عادي
 * @param {string} currentHash - كلمة المرور الحالية في قاعدة البيانات
 * @returns {Promise<boolean>} هل تمت الترقية
 */
const upgradePasswordIfNeeded = async (Model, docId, plainPassword, currentHash) => {
    if (currentHash && currentHash.startsWith('$2')) return false; // مشفرة مسبقاً
    try {
        const newHash = await hashPassword(plainPassword);
        await Model.findByIdAndUpdate(docId, { webPassword: newHash });
        return true;
    } catch (err) {
        console.error('[passwordService] خطأ في ترقية كلمة المرور:', err.message);
        return false;
    }
};

module.exports = { hashPassword, verifyPassword, upgradePasswordIfNeeded, SALT_ROUNDS };
