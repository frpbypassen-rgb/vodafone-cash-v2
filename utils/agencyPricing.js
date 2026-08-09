'use strict';

const { SERVICE_RATE_KEYS, normalizeRate } = require('./rateHelper');
const {
    calculateTransferCostLYD,
    getTransferPricingDefinition,
    isSourceToLydRate
} = require('./transferPricing');

const MAX_MARGIN_PIASTERS = 500;

const finiteNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const roundMoney = (value, digits = 3) => Number(finiteNumber(value).toFixed(digits));

const normalizeMarginPiasters = (value, fallback = 0) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return normalizeMarginPiasters(fallback, 0);
    return Math.min(MAX_MARGIN_PIASTERS, Math.max(0, Math.round(parsed)));
};

const legacyMarginToPiasters = (legacyMargin) =>
    normalizeMarginPiasters(finiteNumber(legacyMargin) * 100);

const marginPiastersToRateDelta = (marginPiasters) =>
    Number((normalizeMarginPiasters(marginPiasters) / 100).toFixed(2));

const readServiceMargin = (subAccount, serviceKey) => {
    const serviceMargins = subAccount?.serviceMarginPiasters;
    if (!serviceMargins) return undefined;
    const value = typeof serviceMargins.get === 'function'
        ? serviceMargins.get(serviceKey)
        : serviceMargins[serviceKey];
    return Number.isFinite(Number(value)) ? Number(value) : undefined;
};

const resolveMarginPiasters = (subAccount, serviceKey) => {
    const serviceMargin = readServiceMargin(subAccount, serviceKey);
    if (serviceMargin !== undefined) return normalizeMarginPiasters(serviceMargin);

    if (Number.isFinite(Number(subAccount?.marginPiasters))) {
        return normalizeMarginPiasters(subAccount.marginPiasters);
    }

    return legacyMarginToPiasters(subAccount?.customMargin);
};

const buildMarginStorage = ({ marginPiasters, customMargin, serviceMarginPiasters } = {}) => {
    const normalized = Number.isFinite(Number(marginPiasters))
        ? normalizeMarginPiasters(marginPiasters)
        : legacyMarginToPiasters(customMargin);
    const serviceMargins = SERVICE_RATE_KEYS.reduce((result, serviceKey) => {
        const raw = serviceMarginPiasters?.[serviceKey];
        if (raw !== '' && raw !== null && raw !== undefined && Number.isFinite(Number(raw))) {
            result[serviceKey] = normalizeMarginPiasters(raw);
        }
        return result;
    }, {});

    return {
        marginPiasters: normalized,
        customMargin: marginPiastersToRateDelta(normalized),
        serviceMarginPiasters: Object.keys(serviceMargins).length ? serviceMargins : undefined,
        pricingVersion: 2
    };
};

const applyCustomerRateMargins = (masterRates, subAccount) =>
    SERVICE_RATE_KEYS.reduce((rates, serviceKey) => {
        const baseRate = normalizeRate(masterRates?.[serviceKey]);
        const marginPiasters = resolveMarginPiasters(subAccount, serviceKey);
        const rateDelta = marginPiastersToRateDelta(marginPiasters);
        const adjustedRate = Number((baseRate + (isSourceToLydRate(serviceKey) ? rateDelta : -rateDelta)).toFixed(2));
        rates[serviceKey] = adjustedRate > 0 ? adjustedRate : baseRate;
        return rates;
    }, {});

const calculateAgencyPricing = ({ amountEGP, masterRates, serviceKey, subAccount }) => {
    const amount = finiteNumber(amountEGP);
    const agentRate = normalizeRate(masterRates?.[serviceKey]);
    const marginPiasters = resolveMarginPiasters(subAccount, serviceKey);
    const rateDelta = marginPiastersToRateDelta(marginPiasters);
    const proposedCustomerRate = Number((agentRate + (isSourceToLydRate(serviceKey) ? rateDelta : -rateDelta)).toFixed(2));
    const customerRate = proposedCustomerRate > 0 ? proposedCustomerRate : agentRate;
    const effectiveMarginPiasters = customerRate === agentRate ? 0 : marginPiasters;
    const agentCostLYD = calculateTransferCostLYD({ serviceKey, amount, exchangeRate: agentRate });
    const customerChargeLYD = calculateTransferCostLYD({ serviceKey, amount, exchangeRate: customerRate });
    const profitLYD = roundMoney(Math.max(0, customerChargeLYD - agentCostLYD));
    const pricing = getTransferPricingDefinition(serviceKey);

    return {
        serviceKey,
        pricingVersion: Number(subAccount?.pricingVersion) || 2,
        amountEGP: roundMoney(amount, 2),
        amountCurrency: pricing.amountCurrencyCode,
        agentRate,
        customerRate,
        marginPiasters: effectiveMarginPiasters,
        rateDelta: marginPiastersToRateDelta(effectiveMarginPiasters),
        agentCostLYD,
        customerChargeLYD,
        profitLYD
    };
};

const pricingFromTransaction = (transaction = {}) => {
    const snapshot = transaction.agencyPricing || {};
    const agentCostLYD = roundMoney(snapshot.agentCostLYD ?? transaction.costLYD);
    const customerChargeLYD = roundMoney(snapshot.customerChargeLYD ?? transaction.subAccountCostLYD ?? agentCostLYD);
    return {
        serviceKey: snapshot.serviceKey || transaction.transferType || 'vodafone',
        pricingVersion: Number(snapshot.pricingVersion) || 1,
        amountEGP: roundMoney(transaction.amount, 2),
        amountCurrency: snapshot.amountCurrency || getTransferPricingDefinition(snapshot.serviceKey || transaction.transferType).amountCurrencyCode,
        agentRate: finiteNumber(snapshot.agentRate ?? transaction.exchangeRate),
        customerRate: finiteNumber(snapshot.customerRate ?? transaction.subClientRate ?? transaction.exchangeRate),
        marginPiasters: Number.isFinite(Number(snapshot.marginPiasters))
            ? normalizeMarginPiasters(snapshot.marginPiasters)
            : normalizeMarginPiasters((finiteNumber(transaction.exchangeRate) - finiteNumber(transaction.subClientRate)) * 100),
        agentCostLYD,
        customerChargeLYD,
        profitLYD: roundMoney(snapshot.profitLYD ?? transaction.masterProfit ?? transaction.commission ?? (customerChargeLYD - agentCostLYD))
    };
};

module.exports = {
    MAX_MARGIN_PIASTERS,
    normalizeMarginPiasters,
    legacyMarginToPiasters,
    marginPiastersToRateDelta,
    resolveMarginPiasters,
    buildMarginStorage,
    applyCustomerRateMargins,
    calculateAgencyPricing,
    pricingFromTransaction,
    roundMoney
};
