'use strict';

const INQUIRY_PAYLOAD_MODES = Object.freeze({
    FIELDS_VALUE: 'fields_value',
    FIELD_KEY_PAIR: 'field_key_pair'
});

const normalizeInquiryPayloadMode = (value, fallback = INQUIRY_PAYLOAD_MODES.FIELDS_VALUE) => {
    const mode = String(value || '').trim();
    return Object.values(INQUIRY_PAYLOAD_MODES).includes(mode) ? mode : fallback;
};

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
        inquiryPayloadMode: INQUIRY_PAYLOAD_MODES.FIELDS_VALUE,
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
        // ZaynPay Legacy requires the provider-defined names inside the
        // inquiry payload: Fields[].Key1 and root Key2.
        inquiryPayloadMode: INQUIRY_PAYLOAD_MODES.FIELD_KEY_PAIR,
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
    INQUIRY_PAYLOAD_MODES,
    normalizeInquiryPayloadMode,
    getApiProviderPreset,
    getApiProviderPresets
};
