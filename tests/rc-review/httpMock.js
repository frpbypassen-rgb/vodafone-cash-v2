'use strict';

// Blocks every outbound HTTP client used by the app. Nothing here dials a
// provider, WhatsApp, SMTP, or any host. Axios is replaced in the module cache
// before application code loads.

const http = require('http');
const https = require('https');
const axios = require('axios');

const counters = {
    providerAuth: 0,
    providerInquiry: 0,
    providerPayment: 0,
    providerBalance: 0,
    providerOther: 0,
    messageSends: 0,
    webhookPosts: 0,
    smtpSends: 0,
    rawHttpBlocked: 0,
    calls: []
};

const paymentScript = [];

const queuePaymentResult = (result) => {
    paymentScript.push(result);
};

const clearPaymentScript = () => {
    paymentScript.length = 0;
};

const resetCounters = () => {
    counters.providerAuth = 0;
    counters.providerInquiry = 0;
    counters.providerPayment = 0;
    counters.providerBalance = 0;
    counters.providerOther = 0;
    counters.messageSends = 0;
    counters.webhookPosts = 0;
    counters.smtpSends = 0;
    counters.rawHttpBlocked = 0;
    counters.calls = [];
};

const snapshotCounters = () => ({
    providerAuth: counters.providerAuth,
    providerInquiry: counters.providerInquiry,
    providerPayment: counters.providerPayment,
    providerBalance: counters.providerBalance,
    providerOther: counters.providerOther,
    messageSends: counters.messageSends,
    webhookPosts: counters.webhookPosts,
    smtpSends: counters.smtpSends,
    rawHttpBlocked: counters.rawHttpBlocked,
    calls: counters.calls.map((call) => ({ ...call }))
});

const classify = (url) => {
    const text = String(url || '');
    if (/GetToken/i.test(text)) return 'providerAuth';
    if (/Transactions\/Inquiry/i.test(text)) return 'providerInquiry';
    if (/Transactions\/Payment/i.test(text)) return 'providerPayment';
    if (/GetBalance/i.test(text)) return 'providerBalance';
    if (/whatchimp|whatsapp|graph\.facebook|telegram|smtp/i.test(text)) return 'messageSends';
    if (/hook|webhook/i.test(text)) return 'webhookPosts';
    if (/zayn|provider|Transactions/i.test(text)) return 'providerOther';
    return 'messageSends';
};

const mockPost = async (url, data, config) => {
    const kind = classify(url);
    counters[kind] += 1;
    counters.calls.push({
        kind,
        url: String(url || '').slice(0, 180),
        amount: data && data.Amount !== undefined ? data.Amount : undefined,
        eventId: (() => {
            const headers = config && config.headers;
            if (!headers) return null;
            if (typeof headers.get === 'function') return headers.get('x-ahrampay-event-id') || null;
            return headers['x-ahrampay-event-id'] || headers['X-Ahrampay-Event-Id'] || null;
        })()
    });
    if (kind === 'providerPayment' && paymentScript.length) {
        const scripted = paymentScript.shift();
        if (scripted === 'timeout') {
            const error = new Error('timeout of 10000ms exceeded');
            error.code = 'ECONNABORTED';
            throw error;
        }
        if (scripted === 'connection' || scripted === 'reset') {
            const error = new Error(scripted === 'reset' ? 'socket hang up' : 'connect ECONNREFUSED 127.0.0.1:1');
            error.code = scripted === 'reset' ? 'ECONNRESET' : 'ECONNREFUSED';
            throw error;
        }
        if (scripted === '5xx') {
            return { status: 503, data: { Code: 503, Message: 'local simulated provider 503' } };
        }
    }

    if (kind === 'providerAuth') {
        return { status: 200, data: { Code: 200, Data: { Access_Token: 'rc-review-fake-token' } } };
    }
    if (kind === 'providerInquiry') {
        return { status: 200, data: { Code: 200, Message: 'ok', Data: { PaymentBillInfo: { BillId: 'local-bill' } } } };
    }
    if (kind === 'providerPayment') {
        const amount = data && data.Amount;
        return {
            status: 200,
            data: {
                Code: 200,
                Message: 'mocked local success',
                Data: {
                    IsPaid: true,
                    IsFailure: 0,
                    Amount: amount,
                    RefTransactionNumber: 'LOCAL-REF-1',
                    TransactionNumber: 'LOCAL-PROV-1',
                    BalanceBefore: 100000,
                    BalanceAfter: 100000 - Number(amount || 0),
                    Status: 'success'
                }
            }
        };
    }
    if (kind === 'providerBalance') {
        return {
            status: 200,
            data: {
                Code: 200,
                Data: { AvailableBalance: 100000, ServiceCredit: 100000, CashCredit: 0 }
            }
        };
    }
    return { status: 200, data: { success: true, mocked: true } };
};

const install = () => {
    axios.post = mockPost;
    axios.get = async (url) => {
        counters.providerOther += 1;
        counters.calls.push({ kind: 'providerOther', url: String(url || '').slice(0, 180), method: 'GET' });
        return { status: 200, data: { mocked: true } };
    };
    axios.request = async (config = {}) => mockPost(config.url, config.data);
    axios.create = () => axios;

    const originals = {
        httpRequest: http.request,
        httpGet: http.get,
        httpsRequest: https.request,
        httpsGet: https.get
    };
    const hostOf = (args) => {
        const options = args[0];
        if (typeof options === 'string') {
            try { return new URL(options).hostname; } catch (_error) { return ''; }
        }
        if (options instanceof URL) return options.hostname;
        return String((options && (options.hostname || options.host)) || '').replace(/:\d+$/, '');
    };
    const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1'].includes(String(host || '').toLowerCase());
    const blockedRequest = (moduleName, method) => {
        counters.rawHttpBlocked += 1;
        const error = new Error(`RC review blocked raw ${moduleName}.${method}`);
        return {
            on(event, handler) {
                if (event === 'error' && typeof handler === 'function') process.nextTick(() => handler(error));
                return this;
            },
            once(event, handler) { return this.on(event, handler); },
            end() { return this; },
            write() { return true; },
            setTimeout() { return this; },
            setNoDelay() { return this; },
            setHeader() { return this; },
            abort() {},
            destroy() {}
        };
    };
    const wrap = (moduleName, method, original) => function wrappedRequest(...args) {
        if (!isLoopback(hostOf(args))) return blockedRequest(moduleName, method);
        return original.apply(this, args);
    };
    http.request = wrap('http', 'request', originals.httpRequest);
    http.get = wrap('http', 'get', originals.httpGet);
    https.request = wrap('https', 'request', originals.httpsRequest);
    https.get = wrap('https', 'get', originals.httpsGet);

    try {
        const nodemailer = require('nodemailer');
        nodemailer.createTransport = () => ({
            sendMail: async () => {
                counters.smtpSends += 1;
                counters.calls.push({ kind: 'smtpSends', url: 'smtp://127.0.0.1' });
                return { messageId: 'rc-review-mock' };
            }
        });
    } catch (_error) {
        // nodemailer is optional for paths that never load it.
    }
};

module.exports = {
    install,
    resetCounters,
    snapshotCounters,
    queuePaymentResult,
    clearPaymentScript,
    counters
};
