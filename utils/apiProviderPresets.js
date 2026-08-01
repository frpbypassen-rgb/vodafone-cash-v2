'use strict';

const API_PROVIDER_PRESETS = {
    zayn_external_aggregator: {
        key: 'zayn_external_aggregator',
        name: 'Zayn External Aggregator',
        nameAr: 'Zayn External Aggregator',
        apiUrl: 'https://zaynpay.com',
        serviceId: 85,
        providerId: 16,
        fieldId: 5488,
        machineSerial: 'XP1',
        appType: '1',
        appId: 'app12',
        versionId: 'Samsuang-502'
    },
    zaynpay_legacy: {
        key: 'zaynpay_legacy',
        name: 'ZaynPay Legacy',
        nameAr: 'ZaynPay Legacy',
        apiUrl: 'https://zaynpay.com',
        serviceId: 307,
        providerId: 29,
        fieldId: 3488,
        machineSerial: 'XP1',
        appType: '1',
        appId: 'app12',
        versionId: 'Samsuang-502'
    }
};

const DEFAULT_API_PROVIDER_KEY = 'zayn_external_aggregator';

const getApiProviderPreset = (key) => {
    const cleanKey = String(key || '').trim();
    return API_PROVIDER_PRESETS[cleanKey] || API_PROVIDER_PRESETS[DEFAULT_API_PROVIDER_KEY];
};

const getApiProviderPresets = () => Object.values(API_PROVIDER_PRESETS);

module.exports = {
    DEFAULT_API_PROVIDER_KEY,
    API_PROVIDER_PRESETS,
    getApiProviderPreset,
    getApiProviderPresets
};
