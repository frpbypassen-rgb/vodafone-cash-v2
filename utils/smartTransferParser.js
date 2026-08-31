'use strict';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_NOTE_LENGTH = 500;

const SERVICE_PATTERNS = Object.freeze([
    { key: 'sefa_niger', pattern: /(?:سيفا|النيجر|nita(?:\s+account)?)/iu },
    { key: 'bankak_sudan', pattern: /(?:بنكك|السودان)/iu },
    { key: 'post_card', pattern: /(?:بريد\s*بطاق(?:ة|ه)|بطاق(?:ة|ه)\s*بريد)/iu },
    { key: 'post_account', pattern: /(?:بريد\s*حساب|حساب\s*بريد(?:ي)?)/iu },
    { key: 'bank_account', pattern: /(?:حساب\s*بنكي|تحويل\s*بنكي|\biban\b)/iu },
    { key: 'vodafone', pattern: /(?:محفظ(?:ة|ه)|فودافون|اتصالات|اورنج|أورنج|وي|كاش)/iu }
]);

const normalizeDigits = (value) => String(value || '')
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/\u066B/g, '.')
    .replace(/\u066C/g, ',');

const normalizeAmountToken = (rawToken) => {
    let token = normalizeDigits(rawToken).replace(/[ \t]/g, '').replace(/[^0-9.,]/g, '');
    if (!token) return null;

    const commaIndex = token.lastIndexOf(',');
    const dotIndex = token.lastIndexOf('.');
    const decimalIndex = Math.max(commaIndex, dotIndex);
    if (decimalIndex >= 0) {
        const decimalLength = token.length - decimalIndex - 1;
        if (decimalLength === 1 || decimalLength === 2) {
            const integerPart = token.slice(0, decimalIndex).replace(/[.,]/g, '');
            const decimalPart = token.slice(decimalIndex + 1).replace(/[.,]/g, '');
            token = `${integerPart}.${decimalPart}`;
        } else {
            token = token.replace(/[.,]/g, '');
        }
    }

    const value = Number(token);
    if (!Number.isFinite(value) || value <= 0 || value > 100000000) return null;
    return Number(value.toFixed(2));
};

const findPhones = (text) => {
    const candidates = text.match(/(?<!\d)(?:\+?20|0020)?[\s().-]*0?1[0125](?:[\s().-]*\d){8}(?!\d)/g) || [];
    const found = [];
    for (const candidate of candidates) {
        let digits = candidate.replace(/\D/g, '');
        if (digits.startsWith('0020')) digits = digits.slice(4);
        else if (digits.startsWith('20')) digits = digits.slice(2);
        if (/^1[0125]\d{8}$/.test(digits)) digits = `0${digits}`;
        if (/^01[0125]\d{8}$/.test(digits) && !found.some((item) => item.value === digits)) {
            found.push({ value: digits, source: candidate });
        }
    }
    return found;
};

const amountPatterns = Object.freeze([
    /(?:المبلغ|مبلغ|القيمة|قيمة)\s*(?:هو|:|=|-)?\s*([0-9]+(?:[ \t.,][0-9]+)*)/iu,
    /([0-9]+(?:[ \t.,][0-9]+)*)\s*(?:جنيه(?:ات)?|جنية|جنيه\s*مصري|ج\.?\s*م\.?|ج|egp)/iu,
    /(?:egp|جنيه(?:ات)?|جنية|ج\.?\s*م\.?|ج)\s*(?:هو|:|=|-)?\s*([0-9]+(?:[ \t.,][0-9]+)*)/iu
]);

const findAmount = (text, phones) => {
    const labelledCandidates = [];
    for (const pattern of amountPatterns) {
        const match = text.match(pattern);
        const value = match ? normalizeAmountToken(match[1]) : null;
        if (value && !labelledCandidates.some((item) => item.value === value)) {
            labelledCandidates.push({ value, source: match[0] });
        }
        const globalPattern = new RegExp(pattern.source, 'giu');
        for (const additional of text.matchAll(globalPattern)) {
            const additionalValue = normalizeAmountToken(additional[1]);
            if (additionalValue && !labelledCandidates.some((item) => item.value === additionalValue)) {
                labelledCandidates.push({ value: additionalValue, source: additional[0] });
            }
        }
    }
    if (labelledCandidates.length) return { ...labelledCandidates[0], candidates: labelledCandidates.map((item) => item.value) };

    let fallbackText = text;
    phones.forEach((phone) => { fallbackText = fallbackText.replace(phone.source, ' '); });
    fallbackText = fallbackText.replace(/(?:ملاحظ(?:ة|ه|ات)|ملحوظ(?:ة|ه|ات)|note)\s*[:：=\-]?\s*[^\r\n]+/giu, ' ');
    const numericTokens = [...fallbackText.matchAll(/\d+(?:[.,]\d+)*/g)]
        .map((match) => ({ raw: match[0], value: normalizeAmountToken(match[0]) }))
        .filter((candidate) => candidate.value);
    const likelyAmounts = numericTokens
        .filter((candidate) => candidate.value >= 10 && candidate.raw.replace(/\D/g, '').length <= 9)
        .filter((candidate, index, all) => all.findIndex((item) => item.value === candidate.value) === index);
    const likelyAmount = likelyAmounts[0];
    return likelyAmount
        ? { value: likelyAmount.value, source: likelyAmount.raw, candidates: likelyAmounts.map((item) => item.value) }
        : { value: null, source: '', candidates: [] };
};

const detectService = (text) => SERVICE_PATTERNS.find((service) => service.pattern.test(text))?.key || null;

const cleanNote = (value) => String(value || '')
    .replace(/^[\s:：=\-–—|،,.;]+|[\s:：=\-–—|،,.;]+$/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, MAX_NOTE_LENGTH);

const findNote = (text, phoneSource, amountSource) => {
    const explicit = text.match(/(?:ملاحظ(?:ة|ه|ات)|ملحوظ(?:ة|ه|ات)|note)\s*[:：=\-]?\s*([^\r\n]+)/iu);
    if (explicit) return cleanNote(explicit[1]);

    let remainder = text;
    const phoneSources = Array.isArray(phoneSource) ? phoneSource : [phoneSource];
    phoneSources.filter(Boolean).forEach((source) => { remainder = remainder.replace(source, ' '); });
    if (amountSource) remainder = remainder.replace(amountSource, ' ');
    remainder = remainder
        .replace(/(?:المبلغ|مبلغ|القيمة|قيمة|رقم\s*(?:الهاتف|الموبايل|المحفظة)|هاتف|موبايل)/giu, ' ')
        .replace(/(?:جنيه(?:ات)?|جنية|جنيه\s*مصري|ج\.?\s*م\.?|ج|egp)/giu, ' ')
        .replace(/(?:حول|حوّل|تحويل|ارسال|إرسال|الى|إلى|على|من\s*فضلك|لو\s*سمحت)/giu, ' ')
        .replace(/(?:محفظ(?:ة|ه)|فودافون|اتصالات|اورنج|أورنج|وي|كاش|بريد\s*حساب|بريد\s*بطاق(?:ة|ه)|حساب\s*بنكي|سيفا|النيجر|nita|بنكك|السودان)/giu, ' ')
        .replace(/[\r\n]+/g, ' ');
    return cleanNote(remainder);
};

const findBeneficiaryName = (text) => {
    const explicit = text.match(/(?:اسم\s*(?:المستفيد|العميل)|المستفيد|recipient|name)\s*[:：=\-]\s*([^\r\n|،]+)/iu);
    if (!explicit) return '';
    return cleanNote(explicit[1]
        .replace(/(?:ملاحظ(?:ة|ه)|ملحوظ(?:ة|ه)|note)\s*[:：=\-]?.*$/iu, '')
        .replace(/(?:المبلغ|مبلغ|القيمة|قيمة)\s*[:：=\-]?.*$/iu, ''));
};

const parseTransferMessage = (rawMessage) => {
    const message = normalizeDigits(rawMessage).replace(/\r\n/g, '\n').trim().slice(0, MAX_MESSAGE_LENGTH);
    const phones = findPhones(message);
    const phone = phones[0] || { value: '', source: '' };
    const amount = findAmount(message, phones);
    const note = findNote(message, phones.map((item) => item.source), amount.source);
    const beneficiaryName = findBeneficiaryName(message);
    const serviceKey = detectService(message);
    const missing = [];
    if (!phone.value) missing.push('رقم الهاتف');
    if (!amount.value) missing.push('المبلغ بالجنيه');
    const warnings = [];
    if (phones.length > 1) warnings.push('توجد أكثر من رقم هاتف؛ تم اختيار الرقم الأول. راجعه قبل الإرسال.');
    if ((amount.candidates || []).length > 1) warnings.push('توجد أكثر من قيمة مالية؛ تم اختيار أول مبلغ. راجعه قبل الإرسال.');
    if (!serviceKey) warnings.push('لم يتم تحديد خدمة التحويل؛ تم اختيار محافظ كاش ويمكنك تغييرها.');
    if (!note) warnings.push('لم يتم العثور على ملاحظة؛ يمكنك إضافة ملاحظة اختيارية قبل الإرسال.');
    const confidence = missing.length
        ? 'low'
        : (phones.length > 1 || (amount.candidates || []).length > 1 ? 'review' : 'high');

    return {
        phone: phone.value,
        amountEGP: amount.value,
        note,
        beneficiaryName,
        serviceKey,
        ready: missing.length === 0 && phones.length <= 1 && (amount.candidates || []).length <= 1,
        missing,
        warnings,
        confidence,
        candidates: { phones: phones.map((item) => item.value), amounts: amount.candidates || [] }
    };
};

module.exports = {
    parseTransferMessage,
    normalizeDigits,
    normalizeAmountToken
};
