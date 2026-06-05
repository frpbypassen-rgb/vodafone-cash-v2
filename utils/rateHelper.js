// utils/rateHelper.js
// دالة مركزية لحساب سعر الصرف بناءً على مستوى العميل (tier) وإعدادات النظام
'use strict';

/**
 * حساب سعر الصرف بناءً على درجة العميل
 * @param {number} tier - مستوى العميل (1, 2, أو 3)
 * @param {Object|null} settings - كائن الإعدادات من MongoDB
 * @returns {number} سعر الصرف المناسب
 */
const getRateForTier = (tier, settings) => {
    const DEFAULT_RATE = 6.40;

    if (!settings) return DEFAULT_RATE;

    if (tier === 3 && settings.rateLevel3) return settings.rateLevel3;
    if (tier === 2 && settings.rateLevel2) return settings.rateLevel2;

    return settings.rateLevel1 || DEFAULT_RATE;
};

module.exports = { getRateForTier };
