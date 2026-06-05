// repositories/settingsRepository.js
// ===============================================
// 📦 طبقة الوصول للبيانات — إعدادات النظام
// ===============================================
'use strict';

const Settings = require('../models/Settings');

// كاش محلي (in-memory) لتقليل استعلامات قاعدة البيانات
let _cachedSettings = null;
let _cacheTimestamp = 0;
const CACHE_TTL = 30 * 1000; // 30 ثانية

/**
 * جلب الإعدادات (مع كاش)
 * @param {boolean} [forceRefresh=false]
 */
const getSettings = async (forceRefresh = false) => {
    const now = Date.now();
    if (!forceRefresh && _cachedSettings && (now - _cacheTimestamp) < CACHE_TTL) {
        return _cachedSettings;
    }

    _cachedSettings = await Settings.findOne({}).lean();
    _cacheTimestamp = now;
    return _cachedSettings;
};

/**
 * تحديث الإعدادات وإبطال الكاش
 * @param {Object} updates
 */
const updateSettings = async (updates) => {
    const result = await Settings.findOneAndUpdate({}, { $set: updates }, { new: true });
    _cachedSettings = null; // إبطال الكاش
    return result;
};

/**
 * إبطال الكاش يدوياً
 */
const invalidateCache = () => {
    _cachedSettings = null;
    _cacheTimestamp = 0;
};

/**
 * التحقق إذا كان النظام مغلق
 */
const isSystemClosed = async () => {
    const settings = await getSettings();
    return settings ? settings.isManualClosed === true : false;
};

module.exports = {
    getSettings,
    updateSettings,
    invalidateCache,
    isSystemClosed
};
