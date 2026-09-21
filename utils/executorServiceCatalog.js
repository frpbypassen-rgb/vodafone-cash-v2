'use strict';

const EXECUTOR_SERVICE_CATALOG = Object.freeze([
    Object.freeze({
        key: 'vodafone',
        label: 'محافظ كاش',
        shortLabel: 'كاش',
        transferTypes: Object.freeze(['vodafone'])
    }),
    Object.freeze({
        key: 'postal',
        label: 'خدمات البريد',
        shortLabel: 'البريد',
        transferTypes: Object.freeze(['post_account', 'post_card'])
    }),
    Object.freeze({
        key: 'bank_account',
        label: 'الحساب البنكي',
        shortLabel: 'بنك',
        transferTypes: Object.freeze(['bank_account'])
    }),
    Object.freeze({
        key: 'sefa_niger',
        label: 'سيفا النيجر',
        shortLabel: 'سيفا',
        requiresProofOnCompletion: true,
        transferTypes: Object.freeze(['sefa_niger'])
    }),
    Object.freeze({
        key: 'bankak_sudan',
        label: 'بنكك السودان',
        shortLabel: 'بنكك',
        transferTypes: Object.freeze(['bankak_sudan'])
    })
]);

const EXECUTOR_SERVICE_BY_KEY = Object.freeze(
    EXECUTOR_SERVICE_CATALOG.reduce((catalog, service) => {
        catalog[service.key] = service;
        return catalog;
    }, {})
);

const EXECUTOR_SERVICE_KEYS = Object.freeze(EXECUTOR_SERVICE_CATALOG.map((service) => service.key));

const SERVICE_ALIASES = Object.freeze({
    cash: 'vodafone',
    post_account: 'postal',
    post_card: 'postal'
});

const normalizeExecutorServiceKey = (value, fallback = 'vodafone') => {
    const key = String(value || '').trim().toLowerCase();
    const normalized = SERVICE_ALIASES[key] || key;
    if (EXECUTOR_SERVICE_BY_KEY[normalized]) return normalized;
    return fallback && EXECUTOR_SERVICE_BY_KEY[fallback] ? fallback : null;
};

const getExecutorServiceDefinition = (value) => {
    const key = normalizeExecutorServiceKey(value);
    return key ? EXECUTOR_SERVICE_BY_KEY[key] : null;
};

const getExecutorPrimaryServiceKey = (executorOrKey, fallback = 'vodafone') => {
    const value = typeof executorOrKey === 'object' && executorOrKey !== null
        ? executorOrKey.serviceKey
        : executorOrKey;
    return normalizeExecutorServiceKey(value, fallback);
};

const uniqueServiceKeys = (values = []) => {
    const keys = [];
    (Array.isArray(values) ? values : [values]).forEach((value) => {
        const key = normalizeExecutorServiceKey(value, null);
        if (key && !keys.includes(key)) keys.push(key);
    });
    return keys;
};

const getExecutorEnabledServiceKeys = (executorOrKey) => {
    if (typeof executorOrKey !== 'object' || executorOrKey === null) {
        const key = normalizeExecutorServiceKey(executorOrKey);
        return key ? [key] : [EXECUTOR_SERVICE_BY_KEY.vodafone.key];
    }
    const primary = getExecutorPrimaryServiceKey(executorOrKey);
    return uniqueServiceKeys([primary, ...(Array.isArray(executorOrKey.serviceKeys) ? executorOrKey.serviceKeys : [])]);
};

const normalizeEnabledServiceKeys = (values, primaryValue) => {
    const primary = getExecutorPrimaryServiceKey(primaryValue);
    return uniqueServiceKeys([primary, ...(Array.isArray(values) ? values : [values])]);
};

const collectEnabledServiceKeysFromBody = (body = {}, primaryValue) => {
    const raw = body.enabledServices ?? body.serviceKeys ?? body.extraServiceKeys;
    return normalizeEnabledServiceKeys(raw, primaryValue);
};

const getExecutorServiceLabel = (executorOrKey) => {
    const value = typeof executorOrKey === 'object' && executorOrKey !== null
        ? getExecutorPrimaryServiceKey(executorOrKey)
        : executorOrKey;
    return getExecutorServiceDefinition(value)?.label || EXECUTOR_SERVICE_BY_KEY.vodafone.label;
};

const getExecutorServiceShortLabel = (executorOrKey) => {
    const key = typeof executorOrKey === 'object' && executorOrKey !== null
        ? getExecutorPrimaryServiceKey(executorOrKey)
        : executorOrKey;
    return getExecutorServiceDefinition(key)?.shortLabel || getExecutorServiceLabel(key);
};

const SERVICE_BALANCE_COPY = Object.freeze({
    vodafone: Object.freeze({
        privateLabel: 'الرصيد الخاص للكاش',
        totalLabel: 'إجمالي الكاش',
        singleLabel: 'رصيد الكاش'
    }),
    bank_account: Object.freeze({
        privateLabel: 'الرصيد الخاص للتحويل البنكي',
        totalLabel: 'إجمالي التحويل البنكي',
        singleLabel: 'رصيد التحويل البنكي'
    }),
    postal: Object.freeze({
        privateLabel: 'الرصيد الخاص للبريد',
        totalLabel: 'إجمالي البريد',
        singleLabel: 'رصيد البريد'
    }),
    sefa_niger: Object.freeze({
        privateLabel: 'الرصيد الخاص لسيفا',
        totalLabel: 'إجمالي سيفا',
        singleLabel: 'رصيد سيفا'
    }),
    bankak_sudan: Object.freeze({
        privateLabel: 'الرصيد الخاص لبنكك',
        totalLabel: 'إجمالي بنكك',
        singleLabel: 'رصيد بنكك'
    })
});

const getExecutorServiceBalanceCopy = (serviceKey) => {
    const key = normalizeExecutorServiceKey(serviceKey);
    const copy = SERVICE_BALANCE_COPY[key] || {
        privateLabel: `الرصيد الخاص — ${getExecutorServiceLabel(key)}`,
        totalLabel: `إجمالي ${getExecutorServiceLabel(key)}`,
        singleLabel: `رصيد ${getExecutorServiceLabel(key)}`
    };
    return {
        serviceKey: key,
        label: getExecutorServiceLabel(key),
        shortLabel: getExecutorServiceShortLabel(key),
        ...copy
    };
};

const representativeTransferTypeForService = (serviceKey) => {
    const definition = getExecutorServiceDefinition(serviceKey);
    return definition?.transferTypes?.[0] || 'vodafone';
};

const getExecutorSupportedTransferTypes = (executorOrKey) => {
    if (typeof executorOrKey === 'object' && executorOrKey !== null) {
        const types = getExecutorEnabledServiceKeys(executorOrKey)
            .flatMap((key) => getExecutorServiceDefinition(key)?.transferTypes || []);
        return [...new Set(types.length ? types : ['vodafone'])];
    }
    const definition = getExecutorServiceDefinition(executorOrKey);
    return definition ? [...definition.transferTypes] : ['vodafone'];
};

const executorSupportsTransferType = (executorOrKey, transferType) => {
    const normalizedTransferType = String(transferType || 'vodafone').trim().toLowerCase();
    return getExecutorSupportedTransferTypes(executorOrKey).includes(normalizedTransferType);
};

const executorTransferRequiresProof = (transferType) =>
    Boolean(getExecutorServiceDefinition(transferType)?.requiresProofOnCompletion);

const getExecutorServiceOptions = () => EXECUTOR_SERVICE_CATALOG.map((service) => ({
    key: service.key,
    label: service.label,
    shortLabel: service.shortLabel,
    requiresProofOnCompletion: Boolean(service.requiresProofOnCompletion),
    transferTypes: [...service.transferTypes]
}));

module.exports = {
    EXECUTOR_SERVICE_CATALOG,
    EXECUTOR_SERVICE_KEYS,
    SERVICE_BALANCE_COPY,
    collectEnabledServiceKeysFromBody,
    getExecutorEnabledServiceKeys,
    getExecutorPrimaryServiceKey,
    getExecutorServiceBalanceCopy,
    getExecutorServiceDefinition,
    getExecutorServiceLabel,
    getExecutorServiceShortLabel,
    getExecutorSupportedTransferTypes,
    executorSupportsTransferType,
    executorTransferRequiresProof,
    getExecutorServiceOptions,
    normalizeEnabledServiceKeys,
    normalizeExecutorServiceKey,
    representativeTransferTypeForService,
    uniqueServiceKeys
};
