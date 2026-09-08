'use strict';

const INQUIRY_PAYLOAD_MODES = Object.freeze({
    FIELDS_VALUE: 'fields_value',
    FIELD_KEY_PAIR: 'field_key_pair'
});

const API_PAYMENT_FLOW_MODES = Object.freeze({
    INQUIRY_THEN_PAYMENT: 'inquiry_then_payment',
    DIRECT_PAYMENT: 'direct_payment'
});

const normalizeInquiryPayloadMode = (value, fallback = INQUIRY_PAYLOAD_MODES.FIELDS_VALUE) => {
    const mode = String(value || '').trim();
    return Object.values(INQUIRY_PAYLOAD_MODES).includes(mode) ? mode : fallback;
};

const normalizeApiPaymentFlow = (value, fallback = API_PAYMENT_FLOW_MODES.INQUIRY_THEN_PAYMENT) => {
    const flow = String(value || '').trim();
    return Object.values(API_PAYMENT_FLOW_MODES).includes(flow) ? flow : fallback;
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
        versionId: 'Samsuang-502',
        requiresInquiry: true
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
        // inquiry payload: Fields[{ Key: 'Key1', Value }, { Key: 'Key2', Value }].
        inquiryPayloadMode: INQUIRY_PAYLOAD_MODES.FIELD_KEY_PAIR,
        appType: '1',
        appId: 'app12',
        versionId: 'Samsuang-502',
        requiresInquiry: true,
        // ZaynPay's supplied payment example uses Key1/Key2 with an issued
        // PaymentBillInfo. It intentionally omits MachineSerial and provider ID.
        transactionContract: 'zaynpay_legacy_payment_v1'
    },
    mogapay: {
        key: 'mogapay',
        name: 'MogaPay',
        nameAr: 'MogaPay — بيئة الاختبار',
        // The collection supplied by MogaPay documents this as its test host.
        // Production operators must replace it with the provider-issued live URL.
        apiUrl: 'https://test2.mogapayment.com',
        serviceId: 64,
        providerId: 0,
        fieldId: 0,
        fieldKey: 'Key1',
        serviceVersion: 0,
        machineSerial: 'XP1',
        inquiryPayloadMode: INQUIRY_PAYLOAD_MODES.FIELD_KEY_PAIR,
        appType: '1',
        appId: 'app12',
        appVersion: '45',
        authEndpoint: '/api/Account/Authenticate',
        authContract: 'mogapay_v1',
        transactionContract: 'keyed_payment_bill_v1',
        requiresProviderId: false,
        requiresFieldId: false,
        requiresInquiry: true,
        reconciliationEndpoint: '/api/V1/Reports/GetBillsByTransactionNumber'
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
    API_PAYMENT_FLOW_MODES,
    normalizeInquiryPayloadMode,
    normalizeApiPaymentFlow,
    getApiProviderPreset,
    getApiProviderPresets
};
