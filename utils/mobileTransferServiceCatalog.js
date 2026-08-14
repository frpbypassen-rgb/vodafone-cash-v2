// Official mobile transfer service catalog.
// This file is the single source of truth for mobile-visible transfer services.
'use strict';

const MOBILE_TRANSFER_SERVICES = Object.freeze([
    Object.freeze({
        key: 'vodafone',
        webType: 'كاش',
        label: 'تحويل كاش',
        shortLabel: 'كاش',
        rateOffset: 0,
        numberLabel: 'رقم المحفظة',
        requiredFields: Object.freeze(['amount', 'number']),
        mobileEnabled: true
    }),
    Object.freeze({
        key: 'post_account',
        webType: 'بريد حساب',
        label: 'تحويل بريد حساب',
        shortLabel: 'بريد حساب',
        rateOffset: -0.05,
        numberLabel: 'رقم الحساب البريدي',
        requiredFields: Object.freeze(['amount', 'number', 'name']),
        mobileEnabled: true
    }),
    Object.freeze({
        key: 'post_card',
        webType: 'بريد بطاقة',
        label: 'تحويل بريد بطاقة',
        shortLabel: 'بريد بطاقة',
        rateOffset: -0.15,
        numberLabel: 'الرقم القومي',
        requiredFields: Object.freeze(['amount', 'number', 'name', 'idCardImage']),
        mobileEnabled: true
    }),
    Object.freeze({
        key: 'bank_account',
        webType: 'حساب بنكي',
        label: 'حساب بنكي مصري',
        shortLabel: 'حساب بنكي',
        rateOffset: -0.10,
        numberLabel: 'رقم الحساب البنكي أو IBAN',
        requiredFields: Object.freeze(['amount', 'number', 'name']),
        mobileEnabled: true
    }),
    Object.freeze({
        key: 'sefa_niger',
        webType: 'سيفا النيجر',
        label: 'سيفا النيجر',
        shortLabel: 'سيفا النيجر',
        amountCurrencyCode: 'XOF',
        amountCurrencyLabel: 'سيفا',
        rateDirection: 'source_to_lyd',
        numberLabel: 'رقم حساب NITA',
        requiredFields: Object.freeze(['amount', 'number', 'name', 'serviceSubtype']),
        allowedSubtypes: Object.freeze(['nita', 'nita_account']),
        mobileEnabled: true
    }),
    Object.freeze({
        key: 'bankak_sudan',
        webType: 'بنكك السودان',
        label: 'بنكك السودان',
        shortLabel: 'بنكك السودان',
        amountCurrencyCode: 'SDG',
        amountCurrencyLabel: 'جنيه سوداني',
        rateDirection: 'lyd_to_source',
        rateOffset: 0.20,
        numberLabel: 'رقم حساب بنكك',
        requiredFields: Object.freeze(['amount', 'number', 'name', 'recipientPhone']),
        mobileEnabled: true
    })
]);

const SERVICE_BY_KEY = Object.freeze(
    MOBILE_TRANSFER_SERVICES.reduce((acc, service) => {
        acc[service.key] = service;
        return acc;
    }, {})
);

const getMobileTransferServices = () => MOBILE_TRANSFER_SERVICES;

const getEnabledMobileTransferServices = () =>
    MOBILE_TRANSFER_SERVICES.filter(service => service.mobileEnabled);

const getEnabledMobileTransferServiceKeys = () =>
    getEnabledMobileTransferServices().map(service => service.key);

const getTransferServiceDefinition = (key) => SERVICE_BY_KEY[key] || null;

const isEnabledMobileTransferService = (key) => {
    const service = getTransferServiceDefinition(key);
    return !!(service && service.mobileEnabled);
};

const getTransferServiceLabel = (key) => {
    const service = getTransferServiceDefinition(key);
    return service ? service.label : String(key || '');
};

const buildMobileServiceCatalogDto = () =>
    getEnabledMobileTransferServices().map(service => ({
        key: service.key,
        label: service.label,
        shortLabel: service.shortLabel,
        numberLabel: service.numberLabel,
        amountCurrencyCode: service.amountCurrencyCode || 'EGP',
        amountCurrencyLabel: service.amountCurrencyLabel || 'EGP',
        rateDirection: service.rateDirection || 'lyd_to_source',
        requiredFields: [...service.requiredFields],
        allowedSubtypes: service.allowedSubtypes ? [...service.allowedSubtypes] : undefined,
        enabled: true
    }));

module.exports = {
    getMobileTransferServices,
    getEnabledMobileTransferServices,
    getEnabledMobileTransferServiceKeys,
    getTransferServiceDefinition,
    getTransferServiceLabel,
    isEnabledMobileTransferService,
    buildMobileServiceCatalogDto
};
