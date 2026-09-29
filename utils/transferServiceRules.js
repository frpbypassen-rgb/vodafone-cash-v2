'use strict';

const { normalizeStoredBank } = require('./egyptianBanks');

const TRANSFER_SERVICE_RULES = Object.freeze({
    vodafone: Object.freeze({
        destinationRequired: true,
        destinationInputMode: 'numeric',
        destinationPattern: '^(010|011|012|015)\\d{8}$',
        destinationMinLength: 11,
        destinationMaxLength: 11,
        destinationError: 'رقم المحفظة يجب أن يكون 11 رقمًا ويبدأ بـ 010 أو 011 أو 012 أو 015.',
        beneficiaryRequired: false,
        minAmount: 100,
        maxAmount: 50000,
        amountStep: '0.01'
    }),
    post_account: Object.freeze({
        destinationRequired: true,
        destinationInputMode: 'numeric',
        destinationPattern: '^\\d{15}$',
        destinationMinLength: 15,
        destinationMaxLength: 15,
        destinationError: 'رقم الحساب البريدي يجب أن يكون 15 رقمًا.',
        beneficiaryRequired: true,
        beneficiaryMinWords: 3,
        beneficiaryLabel: 'اسم المستفيد (ثلاثي)',
        beneficiaryPlaceholder: 'اكتب الاسم ثلاثي',
        minAmount: 500,
        amountStep: '0.01'
    }),
    post_card: Object.freeze({
        destinationRequired: false,
        beneficiaryRequired: true,
        beneficiaryMinWords: 3,
        beneficiaryLabel: 'اسم المستفيد (ثلاثي)',
        beneficiaryPlaceholder: 'اكتب الاسم ثلاثي',
        requiresNationalId: true,
        nationalIdLength: 14,
        requiresGovernorate: true,
        requiresIdentityImage: true,
        minAmount: 500,
        amountStep: '0.01'
    }),
    bank_account: Object.freeze({
        destinationRequired: true,
        destinationInputMode: 'text',
        destinationError: 'أدخل بيانات المستلم وفق طريقة التحويل المختارة.',
        beneficiaryRequired: true,
        beneficiaryMinWords: 2,
        beneficiaryLabel: 'اسم المستفيد',
        beneficiaryPlaceholder: 'الاسم الأول والثاني على الأقل',
        requiresBank: true,
        requiresDataEntryAcknowledgement: true,
        minAmount: 500,
        amountStep: '0.01'
    }),
    sefa_niger: Object.freeze({
        destinationRequired: true,
        destinationInputMode: 'numeric',
        destinationPattern: '^\\d{8,11}$',
        destinationMinLength: 8,
        destinationMaxLength: 11,
        destinationError: 'رقم حساب سيفا يجب أن يتكون من 8 إلى 11 رقمًا.',
        beneficiaryRequired: true,
        beneficiaryLabel: 'الاسم',
        beneficiaryPlaceholder: 'أدخل الاسم',
        requiresSubtype: true,
        allowedSubtypes: Object.freeze(['nita', 'nita_account']),
        cityRequiredForSubtypes: Object.freeze(['nita']),
        requiresDataEntryAcknowledgement: true,
        minAmount: 10,
        integerAmount: true,
        amountStep: '1'
    }),
    bankak_sudan: Object.freeze({
        destinationRequired: true,
        destinationInputMode: 'numeric',
        destinationPattern: '^\\d{14}$',
        destinationMinLength: 14,
        destinationMaxLength: 14,
        destinationError: 'رقم حساب بنكك يجب أن يتكون من 14 رقماً.',
        beneficiaryRequired: true,
        beneficiaryLabel: 'اسم المستفيد',
        beneficiaryPlaceholder: 'أدخل اسم المستفيد',
        amountStep: '0.01'
    })
});

const getTransferServiceRules = (serviceKey) => TRANSFER_SERVICE_RULES[serviceKey] || null;

const countWords = (value) => String(value || '').trim().split(/\s+/).filter(Boolean).length;

const validateTransferInput = ({
    serviceKey,
    amount,
    destination,
    beneficiaryName,
    subtype,
    city,
    nationalId,
    governorate,
    hasIdentityImage,
    enforceDataEntryAcknowledgement = false,
    dataEntryAcknowledged,
    bankMethod,
    bank,
    bankCode,
    bankName
}) => {
    const canonicalKey = serviceKey === 'bank_transfer' ? 'bank_account' : serviceKey;
    const rules = getTransferServiceRules(canonicalKey);
    if (!rules) return 'نوع خدمة التحويل غير صحيح.';

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) return 'أدخل مبلغ تحويل صحيحًا.';
    if (rules.minAmount && numericAmount < rules.minAmount) {
        return `الحد الأدنى لهذه الخدمة هو ${rules.minAmount} جنيه مصري.`;
    }
    if (rules.maxAmount && numericAmount > rules.maxAmount) {
        return `الحد الأقصى لهذه الخدمة هو ${rules.maxAmount.toLocaleString('en-US')} جنيه مصري للعملية الواحدة.`;
    }
    if (rules.integerAmount && !Number.isInteger(numericAmount)) return 'خدمة سيفا لا تقبل كسورًا في قيمة السيفا.';

    let normalizedDestination = String(destination || '').trim();
    if (canonicalKey === 'bank_account') {
        normalizedDestination = normalizedDestination.replace(/\s+/g, '');
        if (!['mobile', 'ipa', 'account', 'iban', 'card'].includes(bankMethod)) return 'اختر طريقة التحويل البنكي.';
        if (bankMethod === 'card') return 'التحويل بالبطاقة البنكية غير متاح حالياً.';
        if (bankMethod === 'mobile' && !/^\d{11}$/.test(normalizedDestination)) return 'رقم الهاتف يجب أن يتكون من 11 رقماً.';
        if (bankMethod === 'ipa' && !/^[A-Za-z0-9._-]{3,64}(?:@[A-Za-z0-9.-]{2,253})?$/.test(normalizedDestination)) return 'عنوان الدفع IPA غير صحيح.';
        if (bankMethod === 'account' && !/^\d{5,34}$/.test(normalizedDestination)) return 'رقم الحساب البنكي يجب أن يتكون من 5 إلى 34 رقماً.';
        if (bankMethod === 'iban' && !/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{5,34}$/.test(normalizedDestination)) return 'الحساب المصرفي الدولي يجب أن يتكون من 5 إلى 34 حرفاً إنجليزياً ورقماً.';
    }
    if (rules.destinationRequired && !normalizedDestination) return rules.destinationError || 'أدخل بيانات المستلم.';
    if (rules.destinationPattern && !new RegExp(rules.destinationPattern).test(normalizedDestination)) {
        return rules.destinationError || 'بيانات المستلم غير صحيحة.';
    }

    const normalizedName = String(beneficiaryName || '').trim();
    if (rules.beneficiaryRequired && !normalizedName) return 'اسم المستفيد مطلوب.';
    if (rules.beneficiaryMinWords && countWords(normalizedName) < rules.beneficiaryMinWords) {
        const wordCountLabel = { 2: 'ثنائيًا', 3: 'ثلاثيًا', 4: 'رباعيًا' }[rules.beneficiaryMinWords] || `${rules.beneficiaryMinWords} كلمات`;
        return `اسم المستفيد يجب أن يكون ${wordCountLabel} لهذه الخدمة.`;
    }

    const normalizedSubtype = String(subtype || '').trim();
    if (rules.requiresSubtype && !normalizedSubtype) return 'اختر نوع خدمة سيفا.';
    if (rules.allowedSubtypes && !rules.allowedSubtypes.includes(normalizedSubtype)) return 'نوع خدمة سيفا غير صحيح.';
    if (rules.cityRequiredForSubtypes?.includes(normalizedSubtype) && !String(city || '').trim()) {
        return 'اسم المدينة مطلوب لخدمة NITA.';
    }
    const acknowledged = dataEntryAcknowledged === true
        || ['true', '1', 'on', 'yes'].includes(String(dataEntryAcknowledged || '').trim().toLowerCase());
    if (enforceDataEntryAcknowledgement && rules.requiresDataEntryAcknowledgement && !acknowledged) {
        return canonicalKey === 'bank_account'
            ? 'يجب الإقرار بصحة بيانات التحويل البنكي قبل الإرسال.'
            : 'يجب تأكيد مسؤوليتك عن صحة بيانات تحويل سيفا قبل الإرسال.';
    }

    if (rules.requiresNationalId && !new RegExp(`^\\d{${rules.nationalIdLength || 14}}$`).test(String(nationalId || '').trim())) {
        return `الرقم القومي يجب أن يكون ${rules.nationalIdLength || 14} رقمًا.`;
    }
    if (rules.requiresGovernorate && !String(governorate || '').trim()) return 'اختر المحافظة.';
    if (rules.requiresIdentityImage && !hasIdentityImage) return 'أرفق صورة البطاقة من الأمام.';

    if (canonicalKey === 'bank_account' && ['account', 'iban'].includes(bankMethod)) {
        const bankError = normalizeStoredBank({
            transferType: canonicalKey,
            bank,
            bankCode,
            bankName
        }).error;
        if (bankError) return bankError;
    }

    return null;
};

module.exports = {
    TRANSFER_SERVICE_RULES,
    getTransferServiceRules,
    validateTransferInput
};
