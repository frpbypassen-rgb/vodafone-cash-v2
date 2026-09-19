'use strict';

const crypto = require('crypto');
const Settings = require('../models/Settings');
const { createTransfer } = require('./transferService');
const { getCompanyServiceRates } = require('../utils/rateHelper');
const { calculateTransferCostLYD, getTransferPricingDefinition } = require('../utils/transferPricing');

class CorporateLedgerError extends Error {
    constructor(code, message, statusCode = 400) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}

const buildReference = () => {
    const stamp = new Date();
    const ymd = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}`;
    return `CORP-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

const payoutIdempotencyKey = (companyId, requestId) => `corp:${companyId}:${requestId}`;

/**
 * Convert the request's source-currency amount (usually EGP) into the company
 * wallet settlement currency (LYD) using the same rate table as live transfers.
 */
const quoteSettlement = async ({ company, amount, currency = 'EGP', serviceType = 'vodafone', settings } = {}) => {
    const resolvedSettings = settings || await Settings.findOne({}).lean();
    const serviceKey = String(serviceType || 'vodafone').trim() || 'vodafone';
    const rates = getCompanyServiceRates(company, resolvedSettings) || {};
    const rate = Number(rates[serviceKey] || rates.vodafone || 0);
    if (!(rate > 0)) {
        throw new CorporateLedgerError('RATE_UNAVAILABLE', 'لا يوجد سعر صرف معتمد لهذه الشركة/الخدمة.', 409);
    }

    const originalAmount = Number(amount);
    if (!Number.isFinite(originalAmount) || originalAmount <= 0) {
        throw new CorporateLedgerError('INVALID_AMOUNT', 'أدخل مبلغاً صحيحاً.');
    }

    const settledAmount = calculateTransferCostLYD({
        serviceKey,
        amount: originalAmount,
        exchangeRate: rate
    });
    if (!(settledAmount > 0)) {
        throw new CorporateLedgerError('FX_INVALID', 'تعذر تحويل المبلغ إلى الدينار بسعر الصرف الحالي.', 400);
    }

    const pricing = getTransferPricingDefinition(serviceKey);
    return {
        originalAmount,
        originalCurrency: String(currency || pricing.amountCurrencyCode || 'EGP').toUpperCase(),
        exchangeRate: rate,
        settledAmount,
        settledCurrency: 'LYD',
        serviceType: serviceKey
    };
};

const withPayoutHeaders = (req, key) => ({
    ...(req || {}),
    headers: {
        ...((req && req.headers) || {}),
        'idempotency-key': key
    }
});

/**
 * Pay the beneficiary through the product transfer pipeline: FX quote, LYD
 * wallet debit, ledger row, and a pending executor Transaction. Retry-safe via
 * a server-generated idempotency key scoped to this company + request.
 */
const executeCompanyPayout = async ({ context, request, beneficiary, req }) => {
    if (request.payoutTransactionId) {
        return {
            idempotent: true,
            txId: request.payoutTransactionId,
            costLYD: Number(request.settledAmount) || undefined,
            exchangeRate: Number(request.exchangeRate) || undefined,
            quote: {
                originalAmount: Number(request.originalAmount || request.amount),
                originalCurrency: request.originalCurrency || request.currency || 'EGP',
                exchangeRate: Number(request.exchangeRate) || undefined,
                settledAmount: Number(request.settledAmount) || undefined,
                settledCurrency: request.settledCurrency || 'LYD'
            }
        };
    }

    const quote = await quoteSettlement({
        company: context.company,
        amount: request.amount,
        currency: request.currency || request.originalCurrency || 'EGP',
        serviceType: beneficiary.serviceType || request.beneficiarySnapshot?.serviceType || 'vodafone'
    });

    const accountNumber = typeof beneficiary.decryptAccountNumber === 'function'
        ? beneficiary.decryptAccountNumber()
        : '';
    if (!accountNumber) {
        throw new CorporateLedgerError('BENEFICIARY_ACCOUNT_MISSING', 'تعذر قراءة حساب المستفيد المعتمد.', 409);
    }

    const result = await createTransfer({
        userId: String(context.actor._id),
        accountType: 'company',
        transferData: {
            transferType: beneficiary.serviceType || 'vodafone',
            amount: quote.originalAmount,
            number: accountNumber,
            name: beneficiary.name,
            notes: `CORP ${request.reference}${request.notes ? ` | ${request.notes}` : ''}`,
            currency: quote.originalCurrency
        },
        req: withPayoutHeaders(req, payoutIdempotencyKey(context.companyId, request._id))
    });

    if (!result || (!result.success && result.code !== 'DUPLICATE_REPLAYED')) {
        throw new CorporateLedgerError(
            result?.code || 'PAYOUT_FAILED',
            result?.message || 'تعذر إنشاء التحويل للمستفيد.',
            result?.statusCode || 400
        );
    }

    return {
        idempotent: result.code === 'DUPLICATE_REPLAYED',
        txId: result.txId,
        costLYD: Number(result.costLYD),
        exchangeRate: Number(result.exchangeRate),
        newBalance: result.newBalance,
        quote: {
            ...quote,
            settledAmount: Number(result.costLYD) || quote.settledAmount,
            exchangeRate: Number(result.exchangeRate) || quote.exchangeRate
        }
    };
};

module.exports = {
    CorporateLedgerError,
    buildReference,
    payoutIdempotencyKey,
    quoteSettlement,
    executeCompanyPayout
};
