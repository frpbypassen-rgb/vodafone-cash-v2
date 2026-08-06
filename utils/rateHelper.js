// utils/rateHelper.js
// Centralized exchange-rate contract builder for web and mobile clients.
'use strict';

const {
    getEnabledMobileTransferServices,
    buildMobileServiceCatalogDto
} = require('./mobileTransferServiceCatalog');

const DEFAULT_RATE = 6.40;

const LEGACY_SERVICE_RATE_DELTAS = Object.freeze({
    vodafone: 0,
    post_account: -0.05,
    post_card: -0.15,
    bank_account: 0,
    sefa_niger: 0.10,
    bankak_sudan: 0.20
});

const SERVICE_RATE_CONFIG = Object.freeze({
    vodafone: Object.freeze({
        key: 'vodafone',
        label: 'تحويل كاش',
        fieldPrefix: 'cashRate',
        defaults: Object.freeze({ level1: 6.40, level2: 6.45, level3: 6.50 })
    }),
    post_account: Object.freeze({
        key: 'post_account',
        label: 'بريد حساب',
        fieldPrefix: 'postAccountRate',
        defaults: Object.freeze({ level1: 6.35, level2: 6.40, level3: 6.45 })
    }),
    post_card: Object.freeze({
        key: 'post_card',
        label: 'بريد بطاقة',
        fieldPrefix: 'postCardRate',
        defaults: Object.freeze({ level1: 6.25, level2: 6.30, level3: 6.35 })
    }),
    bank_account: Object.freeze({
        key: 'bank_account',
        label: 'تحويل بنكي',
        fieldPrefix: 'bankAccountRate',
        defaults: Object.freeze({ level1: 6.40, level2: 6.45, level3: 6.50 })
    }),
    sefa_niger: Object.freeze({
        key: 'sefa_niger',
        label: 'سيفا النيجر',
        fieldPrefix: 'sefaNigerRate',
        defaults: Object.freeze({ level1: 6.50, level2: 6.55, level3: 6.60 })
    }),
    bankak_sudan: Object.freeze({
        key: 'bankak_sudan',
        label: 'بنكك السودان',
        fieldPrefix: 'bankakSudanRate',
        defaults: Object.freeze({ level1: 6.60, level2: 6.65, level3: 6.70 })
    })
});

const SERVICE_RATE_KEYS = Object.freeze(Object.keys(SERVICE_RATE_CONFIG));

const COMPANY_RATE_MODES = Object.freeze({
    GENERAL: 'general',
    CUSTOM: 'custom'
});

const COMPANY_RATE_INPUT_FIELDS = Object.freeze(
    SERVICE_RATE_KEYS.reduce((fields, serviceKey) => {
        fields[serviceKey] = `companyRate_${serviceKey}`;
        return fields;
    }, {})
);

const SERVICE_RATE_ADMIN_FIELDS = Object.freeze(
    SERVICE_RATE_KEYS.flatMap((key) => {
        const prefix = SERVICE_RATE_CONFIG[key].fieldPrefix;
        return [`${prefix}Level1`, `${prefix}Level2`, `${prefix}Level3`];
    })
);

const WEB_TRANSFER_TYPE_TO_SERVICE_KEY = Object.freeze({
    vodafone: 'vodafone',
    cash: 'vodafone',
    'كاش': 'vodafone',
    'تحويل كاش': 'vodafone',
    post_account: 'post_account',
    'بريد حساب': 'post_account',
    'تحويل بريد حساب': 'post_account',
    post_card: 'post_card',
    'بريد بطاقة': 'post_card',
    'تحويل بريد بطاقة': 'post_card',
    bank_account: 'bank_account',
    bank: 'bank_account',
    'حساب بنكي': 'bank_account',
    'تحويل بنكي': 'bank_account',
    'تحويل حساب بنكي': 'bank_account',
    sefa_niger: 'sefa_niger',
    'سيفا النيجر': 'sefa_niger',
    'تحويل سيفا النيجر': 'sefa_niger',
    bankak_sudan: 'bankak_sudan',
    'بنكك السودان': 'bankak_sudan',
    'تحويل بنكك السودان': 'bankak_sudan'
});

const normalizeRate = (rate) => {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_RATE;
    return Number(value.toFixed(2));
};

const normalizeBaseRate = (rate) => {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= Math.abs(LEGACY_SERVICE_RATE_DELTAS.post_card)) return DEFAULT_RATE;
    return Number(value.toFixed(2));
};

const normalizeTier = (tier) => {
    const parsed = Number(tier);
    if (parsed === 2 || parsed === 3) return parsed;
    return 1;
};

const getRateForTier = (tier, settings) => {
    if (!settings) return DEFAULT_RATE;
    const normalizedTier = normalizeTier(tier);

    let rate;
    if (normalizedTier === 3) {
        rate = settings.rateLevel3;
    } else if (normalizedTier === 2) {
        rate = settings.rateLevel2;
    } else {
        rate = settings.rateLevel1;
    }

    return normalizeBaseRate(rate);
};

const getRateFieldName = (serviceKey, tier) => {
    const config = SERVICE_RATE_CONFIG[serviceKey] || SERVICE_RATE_CONFIG.vodafone;
    return `${config.fieldPrefix}Level${normalizeTier(tier)}`;
};

const getLegacyServiceRateForTier = (serviceKey, tier, settings) => {
    const base = getRateForTier(tier, settings);
    const delta = LEGACY_SERVICE_RATE_DELTAS[serviceKey] || 0;
    return normalizeRate(base + delta);
};

const getServiceRateForTier = (serviceKey, tier, settings) => {
    const normalizedKey = SERVICE_RATE_CONFIG[serviceKey] ? serviceKey : 'vodafone';
    const normalizedTier = normalizeTier(tier);
    const fieldName = getRateFieldName(normalizedKey, normalizedTier);
    const directRate = settings ? Number(settings[fieldName]) : NaN;

    if (Number.isFinite(directRate) && directRate > 0) {
        return normalizeRate(directRate);
    }

    return getLegacyServiceRateForTier(normalizedKey, normalizedTier, settings);
};

const getServiceRatesForTier = (tier, settings) =>
    SERVICE_RATE_KEYS.reduce((rates, serviceKey) => {
        rates[serviceKey] = getServiceRateForTier(serviceKey, tier, settings);
        return rates;
    }, {});

const getCompanyRateMode = (company) => {
    const explicitMode = String(company?.rateMode || '').trim().toLowerCase();
    if (explicitMode === COMPANY_RATE_MODES.CUSTOM) return COMPANY_RATE_MODES.CUSTOM;
    if (explicitMode === COMPANY_RATE_MODES.GENERAL) return COMPANY_RATE_MODES.GENERAL;

    const legacyRate = Number(company?.exchangeRate);
    return Number.isFinite(legacyRate) && legacyRate > 0
        ? COMPANY_RATE_MODES.CUSTOM
        : COMPANY_RATE_MODES.GENERAL;
};

const getCompanyRateOffsets = (company, settings) => {
    const baseRates = getServiceRatesForTier(company?.tier || 1, settings);
    const explicitMode = String(company?.rateMode || '').trim().toLowerCase();

    if (explicitMode === COMPANY_RATE_MODES.GENERAL) {
        return SERVICE_RATE_KEYS.reduce((offsets, serviceKey) => {
            offsets[serviceKey] = 0;
            return offsets;
        }, {});
    }

    if (explicitMode === COMPANY_RATE_MODES.CUSTOM) {
        return SERVICE_RATE_KEYS.reduce((offsets, serviceKey) => {
            const value = Number(company?.rateOffsets?.[serviceKey]);
            offsets[serviceKey] = Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
            return offsets;
        }, {});
    }

    const legacyRate = Number(company?.exchangeRate);
    // Legacy API companies used one absolute rate for every service.
    return SERVICE_RATE_KEYS.reduce((offsets, serviceKey) => {
        offsets[serviceKey] = Number.isFinite(legacyRate) && legacyRate > 0
            ? Number((legacyRate - baseRates[serviceKey]).toFixed(2))
            : 0;
        return offsets;
    }, {});
};

const getCompanyServiceRates = (company, settings) => {
    const baseRates = getServiceRatesForTier(company?.tier || 1, settings);
    if (getCompanyRateMode(company) === COMPANY_RATE_MODES.GENERAL) return baseRates;

    const offsets = getCompanyRateOffsets(company, settings);
    return SERVICE_RATE_KEYS.reduce((rates, serviceKey) => {
        const adjusted = Number((baseRates[serviceKey] + offsets[serviceKey]).toFixed(2));
        rates[serviceKey] = adjusted > 0 ? adjusted : baseRates[serviceKey];
        return rates;
    }, {});
};

const buildCompanyRateOffsets = (company, settings, desiredRates = {}) => {
    const baseRates = getServiceRatesForTier(company?.tier || 1, settings);
    return SERVICE_RATE_KEYS.reduce((offsets, serviceKey) => {
        const desiredRate = Number(desiredRates[serviceKey]);
        const effectiveRate = Number.isFinite(desiredRate) && desiredRate > 0
            ? desiredRate
            : baseRates[serviceKey];
        offsets[serviceKey] = Number((effectiveRate - baseRates[serviceKey]).toFixed(2));
        return offsets;
    }, {});
};

const getCompanyRateConfig = (company, settings) => ({
    mode: getCompanyRateMode(company),
    generalRates: getServiceRatesForTier(company?.tier || 1, settings),
    effectiveRates: getCompanyServiceRates(company, settings),
    offsets: getCompanyRateOffsets(company, settings)
});

const getServiceRatesForBaseRate = (baseExchangeRate) => {
    const base = normalizeBaseRate(baseExchangeRate);
    return getEnabledMobileTransferServices().reduce((rates, service) => {
        const delta = LEGACY_SERVICE_RATE_DELTAS[service.key] || 0;
        rates[service.key] = normalizeRate(base + delta);
        return rates;
    }, {});
};

const applyRateMargin = (serviceRates, margin = 0) => {
    const parsedMargin = Number(margin);
    const safeMargin = Number.isFinite(parsedMargin) ? parsedMargin : 0;
    return SERVICE_RATE_KEYS.reduce((rates, serviceKey) => {
        const baseRate = normalizeRate(serviceRates && serviceRates[serviceKey]);
        const adjusted = Number((baseRate - safeMargin).toFixed(2));
        rates[serviceKey] = adjusted > 0 ? adjusted : baseRate;
        return rates;
    }, {});
};

const resolveTransferServiceKey = (transferType) => {
    const raw = String(transferType || '').trim();
    if (!raw) return 'vodafone';
    return WEB_TRANSFER_TYPE_TO_SERVICE_KEY[raw] || WEB_TRANSFER_TYPE_TO_SERVICE_KEY[raw.toLowerCase()] || null;
};

const getAdminRateServices = () =>
    SERVICE_RATE_KEYS.map((serviceKey) => {
        const config = SERVICE_RATE_CONFIG[serviceKey];
        return {
            key: serviceKey,
            label: config.label,
            fields: {
                level1: `${config.fieldPrefix}Level1`,
                level2: `${config.fieldPrefix}Level2`,
                level3: `${config.fieldPrefix}Level3`
            },
            defaults: config.defaults
        };
    });

const buildMobileRateContract = (tier, settings) => {
    const normalizedTier = normalizeTier(tier);
    const baseExchangeRate = getServiceRateForTier('vodafone', normalizedTier, settings);

    return {
        tier: normalizedTier,
        tierLabel: `مستوى ${normalizedTier}`,
        baseExchangeRate,
        exchangeRate: baseExchangeRate,
        serviceRates: getServiceRatesForTier(normalizedTier, settings),
        serviceCatalog: buildMobileServiceCatalogDto()
    };
};

const buildCompanyRateContract = (company, settings) => {
    const tier = normalizeTier(company?.tier || 1);
    const serviceRates = getCompanyServiceRates(company, settings);
    const exchangeRate = serviceRates.vodafone || getServiceRateForTier('vodafone', tier, settings);

    return {
        tier,
        tierLabel: `مستوى ${tier}`,
        baseExchangeRate: exchangeRate,
        exchangeRate,
        serviceRates,
        serviceCatalog: buildMobileServiceCatalogDto()
    };
};

module.exports = {
    getRateForTier,
    normalizeTier,
    normalizeRate,
    normalizeBaseRate,
    getServiceRatesForBaseRate,
    getServiceRateForTier,
    getServiceRatesForTier,
    getCompanyRateMode,
    getCompanyRateOffsets,
    getCompanyServiceRates,
    buildCompanyRateOffsets,
    getCompanyRateConfig,
    applyRateMargin,
    resolveTransferServiceKey,
    getAdminRateServices,
    SERVICE_RATE_ADMIN_FIELDS,
    SERVICE_RATE_CONFIG,
    SERVICE_RATE_KEYS,
    COMPANY_RATE_MODES,
    COMPANY_RATE_INPUT_FIELDS,
    buildMobileRateContract,
    buildCompanyRateContract,
    buildMobileServiceCatalogDto
};
