'use strict';

const DEFAULT_PRICING = Object.freeze({
    amountCurrencyCode: 'EGP',
    amountCurrencyLabel: 'EGP',
    rateDirection: 'lyd_to_source'
});

const SERVICE_PRICING = Object.freeze({
    sefa_niger: Object.freeze({
        amountCurrencyCode: 'XOF',
        amountCurrencyLabel: 'سيفا',
        rateDirection: 'source_to_lyd'
    })
});

const round = (value, precision = 3) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Number(numeric.toFixed(precision));
};

const getTransferPricingDefinition = (serviceKey) => ({
    ...DEFAULT_PRICING,
    ...(SERVICE_PRICING[String(serviceKey || '').trim()] || {})
});

const isSourceToLydRate = (serviceKey) =>
    getTransferPricingDefinition(serviceKey).rateDirection === 'source_to_lyd';

const calculateTransferCostLYD = ({ serviceKey, amount, exchangeRate, precision = 3 }) => {
    const sourceAmount = Number(amount);
    const rate = Number(exchangeRate);
    if (!Number.isFinite(sourceAmount) || sourceAmount <= 0 || !Number.isFinite(rate) || rate <= 0) return 0;

    const cost = isSourceToLydRate(serviceKey)
        ? sourceAmount * rate
        : sourceAmount / rate;
    return round(cost, precision);
};

const calculateSourceAmount = ({ serviceKey, costLYD, exchangeRate, precision = 3 }) => {
    const cost = Number(costLYD);
    const rate = Number(exchangeRate);
    if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(rate) || rate <= 0) return 0;

    const amount = isSourceToLydRate(serviceKey)
        ? cost / rate
        : cost * rate;
    return round(amount, precision);
};

module.exports = {
    getTransferPricingDefinition,
    isSourceToLydRate,
    calculateTransferCostLYD,
    calculateSourceAmount
};
