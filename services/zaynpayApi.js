'use strict';

const axios = require('axios');
const crypto = require('node:crypto');
const { getApiProviderPreset } = require('../utils/apiProviderPresets');
const { classifyProviderPaymentResponse } = require('../utils/providerPaymentResponse');
const { logExecutorFailure } = require('./executorTransactionError');
const { EXTERNAL_API_DISABLED_MESSAGE, isExternalApiEnabled, resolveProviderBaseUrl } = require('../utils/runtimeControls');

class ZaynPayAPI {
    constructor() {
        this.token = null;
        this.contextKey = null;
        this.loginFlight = null;
    }

    configuration() {
        if (!isExternalApiEnabled()) {
            throw Object.assign(new Error(EXTERNAL_API_DISABLED_MESSAGE), { code: 'EXTERNAL_API_DISABLED' });
        }
        const preset = getApiProviderPreset('zayn_external_aggregator');
        const decision = resolveProviderBaseUrl({
            explicitUrl: process.env.ZAYN_AGGREGATOR_URL || process.env.ZAYNPAY_URL || '',
            presetUrl: preset.apiUrl
        });
        if (decision.refused || !decision.baseUrl) {
            throw Object.assign(new Error('PROVIDER_URL_REFUSED: ' + (decision.reason || 'PROVIDER_URL_UNSET')), { code: 'PROVIDER_URL_REFUSED' });
        }
        let baseURL = String(decision.baseUrl).replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(baseURL)) baseURL = 'https://' + baseURL;
        const username = process.env.ZAYN_USERNAME || process.env.ZAYNPAY_USERNAME;
        const password = process.env.ZAYN_PASSWORD || process.env.ZAYNPAY_PASSWORD;
        const contextKey = crypto.createHash('sha256').update(JSON.stringify([baseURL, username, password])).digest('hex');
        if (this.contextKey !== contextKey) { this.token = null; this.contextKey = contextKey; }
        this.baseURL = baseURL;
        return { baseURL, username, password, contextKey, preset };
    }

    async login(config = this.configuration()) {
        if (this.loginFlight?.key === config.contextKey) return this.loginFlight.promise;
        const promise = this.authenticate(config);
        this.loginFlight = { key: config.contextKey, promise };
        try { return await promise; }
        finally { if (this.loginFlight?.promise === promise) this.loginFlight = null; }
    }

    async authenticate(config) {
        try {
            if (!config.username || !config.password) throw new Error('PROVIDER_CREDENTIALS_MISSING');
            const response = await axios.post(config.baseURL + '/api/Account/GetToken', {
                UserName: config.username, Password: config.password,
                AppType: config.preset.appType, AppId: config.preset.appId, VersionID: config.preset.versionId
            }, { headers: { 'app-version': 'xyz67', 'Content-Type': 'application/json' }, timeout: 15000, maxRedirects: 0 });
            const token = response.data?.Data?.Access_Token;
            if (Number(response.data?.Code) !== 200 || typeof token !== 'string' || !token.trim()) throw new Error('PROVIDER_AUTH_REJECTED');
            if (this.contextKey === config.contextKey) this.token = token.trim();
            return token.trim();
        } catch (error) {
            logExecutorFailure('provider-login', error);
            throw new Error('فشل تسجيل الدخول في بوابة ZaynPay');
        }
    }

    async getHeaders(config = this.configuration(), refresh = false) {
        const token = !refresh && this.contextKey === config.contextKey && this.token
            ? this.token : await this.login(config);
        return { Authorization: 'Bearer ' + token, 'app-version': 'xyz67', 'Content-Type': 'application/json', 'Accept-Language': 'ar-EG' };
    }

    payload(config, walletNumber, amount) {
        return { fields: [{ value: walletNumber, key: config.preset.fieldKey }], serviceId: config.preset.serviceId,
            currentServiceProviderId: config.preset.providerId, machineSerial: config.preset.machineSerial, amount };
    }

    async inquiry(walletNumber, amount) {
        try {
            const config = this.configuration();
            const payload = this.payload(config, walletNumber, amount);
            delete payload.amount;
            payload.inqueryAmount = amount;
            let response;
            for (let attempt = 0; attempt < 2; attempt++) {
                const headers = await this.getHeaders(config, attempt > 0);
                try {
                    response = await axios.post(config.baseURL + '/api/V1/Transactions/Inquiry', payload,
                        { headers, timeout: 20000, maxRedirects: 0 });
                    if (Number(response.data?.Code) === 401 && attempt === 0) continue;
                    break;
                } catch (error) {
                    if (error.response?.status === 401 && attempt === 0) continue;
                    throw error;
                }
            }
            const bill = response?.data?.Data?.PaymentBillInfo;
            if (Number(response?.data?.Code) !== 200 || !bill) throw new Error('PROVIDER_INQUIRY_REJECTED');
            return bill;
        } catch (error) {
            logExecutorFailure('provider-inquiry', error);
            if (['EXTERNAL_API_DISABLED', 'PROVIDER_URL_REFUSED'].includes(error.code)) throw error;
            throw new Error('فشل الاستعلام من بوابة ZaynPay');
        }
    }

    async pay(paymentBillInfo, walletNumber, amount) {
        try {
            const config = this.configuration();
            const headers = await this.getHeaders(config);
            const response = await axios.post(config.baseURL + '/api/V1/Transactions/Payment',
                { ...this.payload(config, walletNumber, amount), paymentBillInfo }, { headers, timeout: 180000, maxRedirects: 0 });
            const outcome = classifyProviderPaymentResponse(response.data);
            if (outcome !== 'accepted') return { success: false, unresolved: outcome === 'unresolved', error: 'تعذر تأكيد تنفيذ الدفع لدى المزود.' };
            const data = response.data.Data;
            const scalarReference = (...values) => values.find(value => ['string', 'number'].includes(typeof value) && String(value).trim());
            const print = data.PrintBill || {};
            const transactionNumber = scalarReference(data.TransactionNumber, data.TransactionId, print.TransactionId);
            const refNumber = scalarReference(data.RefTransactionNumber, data.RefNumber, print.RefTransactionNumber, print.RefNumber, data.ApprovalNumber);
            if (!refNumber && !transactionNumber) return { success: false, unresolved: true, error: 'لم يرجع المزود مرجعاً قابلاً للتحقق.' };
            return { success: true, transactionNumber, refNumber,
                amount: data.TotalAmount ?? amount, cost: data.ServiceCost ?? 0 };
        } catch (error) {
            logExecutorFailure('provider-payment', error);
            return { success: false, unresolved: true, code: error.code,
                error: ['EXTERNAL_API_DISABLED', 'PROVIDER_URL_REFUSED'].includes(error.code) ? error.message : 'تعذر تأكيد نتيجة الدفع لدى المزود.' };
        }
    }
}

module.exports = new ZaynPayAPI();
