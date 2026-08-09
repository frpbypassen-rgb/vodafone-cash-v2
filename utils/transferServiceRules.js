'use strict';

const TRANSFER_SERVICE_RULES = Object.freeze({
    vodafone: Object.freeze({
        destinationRequired: true,
        destinationInputMode: 'numeric',
        destinationPattern: '^(010|011|012|015)\\d{8}$',
        destinationMinLength: 11,
        destinationMaxLength: 11,
        destinationError: 'رقم المحفظة يجب أن يكون 11 رقمًا ويبدأ بـ 010 أو 011 أو 012 أو 015.',
        beneficiaryRequired: false,
        amountStep: '0.01'
    }),
    post_account: Object.freeze({
        destinationRequired: true,
        destinationInputMode: 'numeric',
        destinationPattern: '^\\d{16}$',
        destinationMinLength: 16,
        destinationMaxLength: 16,
        destinationError: 'رقم الحساب البريدي يجب أن يكون 16 رقمًا.',
        beneficiaryRequired: true,
        beneficiaryMinWords: 4,
        beneficiaryLabel: 'اسم المستفيد (رباعي)',
        beneficiaryPlaceholder: 'اكتب الاسم رباعي',
        amountStep: '0.01'
    }),
    post_card: Object.freeze({
        destinationRequired: false,
        beneficiaryRequired: true,
        beneficiaryMinWords: 4,
        beneficiaryLabel: 'اسم المستفيد (رباعي)',
        beneficiaryPlaceholder: 'اكتب الاسم رباعي',
        requiresNationalId: true,
        nationalIdLength: 14,
        requiresGovernorate: true,
        requiresIdentityImage: true,
        amountStep: '0.01'
    }),
    bank_account: Object.freeze({
        destinationRequired: true,
        destinationInputMode: 'text',
        destinationError: 'أدخل رقم الحساب البنكي أو IBAN.',
        beneficiaryRequired: true,
        beneficiaryLabel: 'اسم المستفيد',
        beneficiaryPlaceholder: 'أدخل اسم المستفيد',
        amountStep: '0.01'
    }),
    sefa_niger: Object.freeze({
        destinationRequired: true,
        destinationInputMode: 'numeric',
        destinationPattern: '^\\d{8,10}$',
        destinationMinLength: 8,
        destinationMaxLength: 10,
        destinationError: 'رقم حساب سيفا يجب أن يتكون من 8 إلى 10 أرقام.',
        beneficiaryRequired: true,
        beneficiaryLabel: 'الاسم',
        beneficiaryPlaceholder: 'أدخل الاسم',
        requiresSubtype: true,
        allowedSubtypes: Object.freeze(['nita', 'nita_account']),
        cityRequiredForSubtypes: Object.freeze(['nita']),
        requiresDataEntryAcknowledgement: true,
        integerAmount: true,
        amountStep: '1'
    }),
    bankak_sudan: Object.freeze({
        destinationRequired: true,
        destinationInputMode: 'text',
        destinationError: 'أدخل رقم حساب بنكك.',
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
    dataEntryAcknowledged
}) => {
    const rules = getTransferServiceRules(serviceKey);
    if (!rules) return 'نوع خدمة التحويل غير صحيح.';

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) return 'أدخل مبلغ تحويل صحيحًا.';
    if (rules.integerAmount && !Number.isInteger(numericAmount)) return 'خدمة سيفا لا تقبل كسورًا في قيمة السيفا.';

    const normalizedDestination = String(destination || '').trim();
    if (rules.destinationRequired && !normalizedDestination) return rules.destinationError || 'أدخل بيانات المستلم.';
    if (rules.destinationPattern && !new RegExp(rules.destinationPattern).test(normalizedDestination)) {
        return rules.destinationError || 'بيانات المستلم غير صحيحة.';
    }

    const normalizedName = String(beneficiaryName || '').trim();
    if (rules.beneficiaryRequired && !normalizedName) return 'اسم المستفيد مطلوب.';
    if (rules.beneficiaryMinWords && countWords(normalizedName) < rules.beneficiaryMinWords) {
        return 'اسم المستفيد الرباعي مطلوب لهذه الخدمة.';
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
        return 'يجب تأكيد مسؤوليتك عن صحة بيانات تحويل سيفا قبل الإرسال.';
    }

    if (rules.requiresNationalId && !new RegExp(`^\\d{${rules.nationalIdLength || 14}}$`).test(String(nationalId || '').trim())) {
        return `الرقم القومي يجب أن يكون ${rules.nationalIdLength || 14} رقمًا.`;
    }
    if (rules.requiresGovernorate && !String(governorate || '').trim()) return 'اختر المحافظة.';
    if (rules.requiresIdentityImage && !hasIdentityImage) return 'أرفق صورة البطاقة من الأمام.';

    return null;
};

module.exports = {
    TRANSFER_SERVICE_RULES,
    getTransferServiceRules,
    validateTransferInput
};
