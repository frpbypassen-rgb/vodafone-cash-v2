'use strict';

// مصدر واحد لخيارات منطقة الشركة. لا تُحفظ قيمة العرض وحدها في الواجهة
// حتى يبقى الربط صالحاً عند تعديل التصميم أو ترتيب الخيارات لاحقاً.
const LIBYA_REGIONS = Object.freeze([
    { code: 'butnan', name: 'البطنان' },
    { code: 'derna', name: 'درنة' },
    { code: 'jabal_al_akhdar', name: 'الجبل الأخضر' },
    { code: 'marj', name: 'المرج' },
    { code: 'benghazi', name: 'بنغازي' },
    { code: 'wahat', name: 'الواحات' },
    { code: 'sirte', name: 'سرت' },
    { code: 'jufra', name: 'الجفرة' },
    { code: 'misrata', name: 'مصراتة' },
    { code: 'murqub', name: 'المرقب' },
    { code: 'tripoli', name: 'طرابلس' },
    { code: 'jafara', name: 'الجفارة' },
    { code: 'zawiya', name: 'الزاوية' },
    { code: 'nuqat_al_khams', name: 'النقاط الخمس' },
    { code: 'jabal_al_gharbi', name: 'الجبل الغربي' },
    { code: 'nalut', name: 'نالوت' },
    { code: 'wadi_al_shatii', name: 'وادي الشاطئ' },
    { code: 'sabha', name: 'سبها' },
    { code: 'wadi_al_hayat', name: 'وادي الحياة' },
    { code: 'murzuq', name: 'مرزق' },
    { code: 'ghat', name: 'غات' },
    { code: 'kufra', name: 'الكفرة' }
]);

const isLibyaRegionCode = (value) => LIBYA_REGIONS.some((region) => region.code === String(value || '').trim());

module.exports = { LIBYA_REGIONS, isLibyaRegionCode };
