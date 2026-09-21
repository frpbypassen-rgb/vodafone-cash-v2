'use strict';

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

const USSD_NETWORKS = Object.freeze({
    vodafone: {
        id: 'vodafone',
        labelAr: 'فودافون',
        labelEn: 'Vodafone',
        pinRequired: false
    },
    etisalat: {
        id: 'etisalat',
        labelAr: 'اتصالات',
        labelEn: 'Etisalat',
        pinRequired: true
    },
    orange: {
        id: 'orange',
        labelAr: 'أورنج',
        labelEn: 'Orange',
        pinRequired: true
    },
    we: {
        id: 'we',
        labelAr: 'وي',
        labelEn: 'WE',
        pinRequired: true
    }
});

const DEFAULT_USSD_NETWORK = 'vodafone';
const MIN_WALLET_PIN_LENGTH = 4;
const MAX_WALLET_PIN_LENGTH = 8;
const PIN_REDACTION_TOKEN = '[PIN]';
const PIN_SECURITY_NOTE_AR = 'تنبيه أمني: لشبكات اتصالات وأورنج ووي يظهر رقم سر المحفظة في شاشة الاتصال. لا تشارك الشاشة ولا تترك الهاتف دون مراقبة أثناء الاتصال.';

const listUssdNetworks = () => Object.values(USSD_NETWORKS);

const normalizeUssdNetwork = (value) => {
    const key = String(value || '').trim().toLowerCase();
    return USSD_NETWORKS[key] ? key : DEFAULT_USSD_NETWORK;
};

const networkRequiresPin = (network) => Boolean(USSD_NETWORKS[normalizeUssdNetwork(network)]?.pinRequired);

const sanitizeDigits = (value) => String(value ?? '').replace(/[0-9٠-٩۰-۹]/g, (character) => {
    const indic = ARABIC_INDIC_DIGITS.indexOf(character);
    if (indic >= 0) return String(indic);
    const eastern = EASTERN_ARABIC_DIGITS.indexOf(character);
    if (eastern >= 0) return String(eastern);
    return character;
}).replace(/\D/g, '');

const sanitizePhoneDigits = (value) => sanitizeDigits(value);

const sanitizeAmountDigits = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(Math.round(Math.abs(value)));
    }
    const mapped = String(value ?? '').replace(/[0-9٠-٩۰-۹]/g, (character) => {
        const indic = ARABIC_INDIC_DIGITS.indexOf(character);
        if (indic >= 0) return String(indic);
        const eastern = EASTERN_ARABIC_DIGITS.indexOf(character);
        if (eastern >= 0) return String(eastern);
        return character;
    }).replace(/,/g, '');
    const parsed = Number(mapped.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(parsed) || parsed <= 0) return '';
    return String(Math.round(parsed));
};

const sanitizeWalletPin = (value) => sanitizeDigits(value);

const validateWalletPin = (value, { required = true } = {}) => {
    const pin = sanitizeWalletPin(value);
    if (!pin) {
        return required
            ? { ok: false, code: 'PIN_REQUIRED', message: 'رقم سر المحفظة مطلوب لهذه الشبكة.' }
            : { ok: true, pin: '' };
    }
    if (pin.length < MIN_WALLET_PIN_LENGTH || pin.length > MAX_WALLET_PIN_LENGTH) {
        return {
            ok: false,
            code: 'INVALID_PIN',
            message: `رقم سر المحفظة يجب أن يكون بين ${MIN_WALLET_PIN_LENGTH} و ${MAX_WALLET_PIN_LENGTH} أرقام.`
        };
    }
    return { ok: true, pin };
};

const validateDialInputs = ({ network, phone, amount, pin } = {}) => {
    const normalizedNetwork = USSD_NETWORKS[String(network || '').trim().toLowerCase()]
        ? String(network).trim().toLowerCase()
        : '';
    if (!normalizedNetwork) {
        return { ok: false, code: 'INVALID_NETWORK', message: 'اختر شبكة صحيحة: فودافون أو اتصالات أو أورنج أو وي.' };
    }

    const phoneDigits = sanitizePhoneDigits(phone);
    if (!phoneDigits) {
        return { ok: false, code: 'INVALID_PHONE', message: 'رقم الهاتف غير صالح للتنفيذ السريع.' };
    }

    const amountDigits = sanitizeAmountDigits(amount);
    if (!amountDigits) {
        return { ok: false, code: 'INVALID_AMOUNT', message: 'المبلغ غير صالح للتنفيذ السريع.' };
    }

    const pinRequired = networkRequiresPin(normalizedNetwork);
    const pinResult = validateWalletPin(pin, { required: pinRequired });
    if (!pinResult.ok) return pinResult;

    return {
        ok: true,
        network: normalizedNetwork,
        phone: phoneDigits,
        amount: amountDigits,
        pin: pinRequired ? pinResult.pin : ''
    };
};

const buildUssdString = ({ network, phone, amount, pin } = {}) => {
    const validated = validateDialInputs({ network, phone, amount, pin });
    if (!validated.ok) {
        const error = new Error(validated.message);
        error.code = validated.code;
        throw error;
    }

    const { network: carrier, phone: phoneDigits, amount: amountDigits, pin: pinDigits } = validated;
    if (carrier === 'vodafone') return `*9*7*${phoneDigits}*${amountDigits}#`;
    if (carrier === 'etisalat') return `*777*1*${pinDigits}*${amountDigits}*${phoneDigits}*${phoneDigits}#`;
    if (carrier === 'orange') return `*7115*7*${phoneDigits}*${amountDigits}*${pinDigits}#`;
    return `*7*2*${phoneDigits}*${amountDigits}*${pinDigits}#`;
};

const encodeUssdForTel = (ussd) => String(ussd || '')
    .replace(/\*/g, '%2A')
    .replace(/#/g, '%23');

const decodeUssdFromTel = (value) => String(value || '')
    .replace(/^tel:/i, '')
    .replace(/%2a/gi, '*')
    .replace(/%23/g, '#');

const toTelUri = (ussd) => `tel:${encodeUssdForTel(decodeUssdFromTel(ussd))}`;

const redactUssdForLog = (ussd, pin) => {
    const preview = String(ussd || '');
    const pinDigits = sanitizeWalletPin(pin);
    if (!pinDigits) return preview;
    return preview.split(pinDigits).join(PIN_REDACTION_TOKEN);
};

const describeUssdForDebug = ({ network, phone, amount, pin, ussd } = {}) => {
    const normalizedNetwork = normalizeUssdNetwork(network);
    const built = ussd || (network && phone && amount
        ? buildUssdString({ network, phone, amount, pin })
        : '');
    return {
        network: normalizedNetwork,
        pinRequired: networkRequiresPin(normalizedNetwork),
        pinIncluded: networkRequiresPin(normalizedNetwork),
        phone: sanitizePhoneDigits(phone),
        amount: sanitizeAmountDigits(amount),
        ussd: redactUssdForLog(built, pin),
        telUri: built ? redactUssdForLog(toTelUri(built), pin) : ''
    };
};

const toPublicQuickExecuteState = (policy, employee = {}) => {
    const network = normalizeUssdNetwork(employee.ussdNetwork);
    return {
        enabled: Boolean(policy?.quickExecuteEnabled),
        network,
        networkLabel: USSD_NETWORKS[network]?.labelAr || USSD_NETWORKS[DEFAULT_USSD_NETWORK].labelAr,
        pinRequired: networkRequiresPin(network),
        pinSet: Boolean(employee.ussdWalletPinSetAt),
        securityNote: PIN_SECURITY_NOTE_AR,
        networks: listUssdNetworks()
    };
};

module.exports = {
    DEFAULT_USSD_NETWORK,
    MAX_WALLET_PIN_LENGTH,
    MIN_WALLET_PIN_LENGTH,
    PIN_REDACTION_TOKEN,
    PIN_SECURITY_NOTE_AR,
    USSD_NETWORKS,
    buildUssdString,
    decodeUssdFromTel,
    describeUssdForDebug,
    encodeUssdForTel,
    listUssdNetworks,
    networkRequiresPin,
    normalizeUssdNetwork,
    redactUssdForLog,
    sanitizeAmountDigits,
    sanitizeDigits,
    sanitizePhoneDigits,
    sanitizeWalletPin,
    toPublicQuickExecuteState,
    toTelUri,
    validateDialInputs,
    validateWalletPin
};
