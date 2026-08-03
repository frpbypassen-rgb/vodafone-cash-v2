// validators/mobileRegistrationValidators.js
// ===============================================
// 📋 Validation Rules for Mobile Registration Endpoints
// ===============================================
'use strict';

const { body, validationResult } = require('express-validator');
const { sendMobileError } = require('../mappers/mobileErrorMapper');

const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const first = errors.array()[0];
        return sendMobileError(res, 400, 'VALIDATION_ERROR', first.msg, req.correlationId);
    }
    next();
};

const LIBYAN_CITIES = [
    'طرابلس', 'بنغازي', 'مصراتة', 'الزاوية', 'زليتن', 'الخمس', 'سبها', 'سرت', 'درنة', 'طبرق',
    'البيضاء', 'اجدابيا', 'غريان', 'المرج', 'نالوت', 'زوارة', 'صبراتة', 'صرمان', 'يفرن', 'ترهونة',
    'بني وليد', 'غات', 'غدامس', 'أوباري', 'مرزق', 'هون', 'ودان', 'الجفرة', 'الكفرة', 'تاجوراء',
    'جنزور', 'قصر بن غشير', 'العجيلات', 'رقدالين', 'الجميل', 'زلطن', 'الأصابعة', 'مزدة', 'الشويرف', 'القبة'
];

const commonClientRules = [
    body('fullName')
        .trim()
        .notEmpty().withMessage('الاسم الثلاثي مطلوب'),
    body('fullName')
        .custom(value => {
            const parts = (value || '').split(/\s+/).filter(Boolean);
            if (parts.length < 3) {
                throw new Error('يرجى إدخال الاسم الثلاثي كاملاً (3 كلمات على الأقل)');
            }
            return true;
        }),
    body('phone')
        .trim()
        .notEmpty().withMessage('رقم الهاتف مطلوب')
        .isLength({ min: 10, max: 20 }).withMessage('رقم الهاتف يجب أن يكون بين 10 و 20 رقماً')
        .isNumeric().withMessage('رقم الهاتف يجب أن يحتوي على أرقام فقط'),
    body('storeName')
        .trim()
        .notEmpty().withMessage('اسم المحل مطلوب'),
    body('address')
        .trim()
        .notEmpty().withMessage('العنوان مطلوب'),
    body('username')
        .trim()
        .notEmpty().withMessage('اسم المستخدم مطلوب'),
    body('username')
        .custom(value => {
            let user = value;
            if (user && !user.includes('@')) {
                user += '@ahram.com';
            }
            if (!/^[a-zA-Z0-9_]{3,20}@ahram\.com$/.test(user)) {
                throw new Error('اسم المستخدم يجب أن يكون باللغة الإنجليزية وبدون مسافات (من 3 إلى 20 حرف)');
            }
            return true;
        }),
    body('password')
        .trim()
        .notEmpty().withMessage('كلمة المرور مطلوبة')
        .isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل')
];

const directRegisterValidator = [
    ...commonClientRules,
    validate
];

const newRegisterValidator = [
    body('fullName')
        .trim()
        .notEmpty().withMessage('الاسم الثلاثي مطلوب'),
    body('fullName')
        .custom(value => {
            const parts = (value || '').split(/\s+/).filter(Boolean);
            if (parts.length < 3) {
                throw new Error('يرجى إدخال الاسم الثلاثي كاملاً (3 كلمات على الأقل)');
            }
            return true;
        }),
    body('phone')
        .trim()
        .notEmpty().withMessage('رقم الهاتف مطلوب')
        .isLength({ min: 10, max: 20 }).withMessage('رقم الهاتف يجب أن يكون بين 10 و 20 رقماً')
        .isNumeric().withMessage('رقم الهاتف يجب أن يحتوي على أرقام فقط'),
    body('city')
        .trim()
        .notEmpty().withMessage('المدينة مطلوبة')
        .custom(value => {
            if (!LIBYAN_CITIES.includes(value)) {
                throw new Error('يرجى اختيار مدينة صحيحة من المدن الليبية');
            }
            return true;
        }),
    body('nationality')
        .trim()
        .notEmpty().withMessage('الجنسية مطلوبة')
        .isIn(['libyan', 'egyptian']).withMessage('الجنسية يجب أن تكون ليبي أو مصري'),
    body('username')
        .trim()
        .notEmpty().withMessage('اسم المستخدم مطلوب'),
    body('username')
        .custom(value => {
            let user = value;
            if (user && !user.includes('@')) {
                user += '@ahram.com';
            }
            if (!/^[a-zA-Z0-9_]{3,20}@ahram\.com$/.test(user)) {
                throw new Error('اسم المستخدم يجب أن يكون باللغة الإنجليزية وبدون مسافات (من 3 إلى 20 حرف)');
            }
            return true;
        }),
    body('password')
        .trim()
        .notEmpty().withMessage('كلمة المرور مطلوبة')
        .isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
    body('agentCode')
        .trim()
        .notEmpty().withMessage('كود الوكيل مطلوب للعميل الجديد')
        .isLength({ min: 4, max: 4 }).withMessage('كود الوكيل يجب أن يكون مكوناً من 4 أرقام')
        .isNumeric().withMessage('كود الوكيل يجب أن يحتوي على أرقام فقط'),
    validate
];

const companyRegisterValidator = [
    body('companyName')
        .trim()
        .notEmpty().withMessage('اسم الشركة القانوني مطلوب'),
    body('companyContact')
        .trim()
        .notEmpty().withMessage('اسم مدير الشركة مطلوب'),
    body('companyPhone')
        .trim()
        .notEmpty().withMessage('رقم هاتف الشركة مطلوب')
        .isLength({ min: 10, max: 20 }).withMessage('رقم الهاتف يجب أن يكون بين 10 و 20 رقماً')
        .isNumeric().withMessage('رقم الهاتف يجب أن يحتوي على أرقام فقط'),
    body('companyEmail')
        .trim()
        .notEmpty().withMessage('البريد الرسمي مطلوب')
        .isEmail().withMessage('البريد الإلكتروني غير صالح'),
    body('username')
        .trim()
        .notEmpty().withMessage('اسم المستخدم مطلوب'),
    body('username')
        .custom(value => {
            let user = value;
            if (user && !user.includes('@')) {
                user += '@ahram.com';
            }
            if (!/^[a-zA-Z0-9_]{3,20}@ahram\.com$/.test(user)) {
                throw new Error('اسم المستخدم يجب أن يكون باللغة الإنجليزية وبدون مسافات (من 3 إلى 20 حرف)');
            }
            return true;
        }),
    body('password')
        .trim()
        .notEmpty().withMessage('كلمة المرور مطلوبة')
        .isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
    validate
];

const agentRegisterValidator = [
    body('companyName')
        .trim()
        .notEmpty().withMessage('اسم الوكالة مطلوب'),
    body('fullName')
        .trim()
        .notEmpty().withMessage('اسم المدير مطلوب'),
    body('fullName')
        .custom(value => {
            const parts = (value || '').split(/\s+/).filter(Boolean);
            if (parts.length < 3) {
                throw new Error('يرجى إدخال الاسم المدير الثلاثي كاملاً (3 كلمات على الأقل)');
            }
            return true;
        }),
    body('phone')
        .trim()
        .notEmpty().withMessage('رقم الهاتف مطلوب')
        .isLength({ min: 10, max: 20 }).withMessage('رقم الهاتف يجب أن يكون بين 10 و 20 رقماً')
        .isNumeric().withMessage('رقم الهاتف يجب أن يحتوي على أرقام فقط'),
    body('address')
        .trim()
        .notEmpty().withMessage('العنوان مطلوب'),
    body('city')
        .trim()
        .notEmpty().withMessage('المحافظة مطلوبة'),
    body('companyEmail')
        .trim()
        .notEmpty().withMessage('البريد الإلكتروني مطلوب')
        .isEmail().withMessage('البريد الإلكتروني غير صالح'),
    body('username')
        .trim()
        .notEmpty().withMessage('اسم المستخدم مطلوب'),
    body('username')
        .custom(value => {
            let user = value;
            if (user && !user.includes('@')) {
                user += '@ahram.com';
            }
            if (!/^[a-zA-Z0-9_]{3,20}@ahram\.com$/.test(user)) {
                throw new Error('اسم المستخدم يجب أن يكون باللغة الإنجليزية وبدون مسافات (من 3 إلى 20 حرف)');
            }
            return true;
        }),
    body('password')
        .trim()
        .notEmpty().withMessage('كلمة المرور مطلوبة')
        .isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
    validate
];

module.exports = {
    directRegisterValidator,
    newRegisterValidator,
    companyRegisterValidator,
    agentRegisterValidator
};
