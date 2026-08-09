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

const getExecutorServiceLabel = (executorOrKey) => {
    const value = typeof executorOrKey === 'object' && executorOrKey !== null
        ? executorOrKey.serviceKey
        : executorOrKey;
    return getExecutorServiceDefinition(value)?.label || EXECUTOR_SERVICE_BY_KEY.vodafone.label;
};

const getExecutorSupportedTransferTypes = (executorOrKey) => {
    const value = typeof executorOrKey === 'object' && executorOrKey !== null
        ? executorOrKey.serviceKey
        : executorOrKey;
    const definition = getExecutorServiceDefinition(value);
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
    normalizeExecutorServiceKey,
    getExecutorServiceDefinition,
    getExecutorServiceLabel,
    getExecutorSupportedTransferTypes,
    executorSupportsTransferType,
    executorTransferRequiresProof,
    getExecutorServiceOptions
};
