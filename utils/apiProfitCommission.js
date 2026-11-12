'use strict';

const finiteNumber = value => {
    if (!['number', 'string'].includes(typeof value)
        || (typeof value === 'string' && !value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};
const roundMoney = value => Math.round((value + Number.EPSILON) * 1000) / 1000;
const parseProfitPercent = value => {
    const number = finiteNumber(value);
    if (number === null || number < 0 || number >= 100 || Math.abs(number * 10000 - Math.round(number * 10000)) > 0.000001) {
        throw new Error('INVALID_API_PROFIT_PERCENT');
    }
    return number;
};
const apiProfitPricing = (amount, percent = 0) => {
    const value = finiteNumber(amount);
    if (value === null || value <= 0) throw new Error('INVALID_API_PROFIT_AMOUNT');
    const rate = parseProfitPercent(percent);
    const expectedProfitCommission = roundMoney(value * rate / 100);
    return {
        transactionAmount: value,
        profitCommissionPercent: rate,
        expectedProfitCommission,
        expectedDebit: roundMoney(value - expectedProfitCommission)
    };
};
const observedApiProfit = (amount, cost) => {
    const value = finiteNumber(amount);
    const debit = finiteNumber(cost);
    if (value === null || value <= 0 || debit === null || debit <= 0) return null;
    return roundMoney(value - debit);
};
module.exports = { finiteNumber, roundMoney, parseProfitPercent, apiProfitPricing, observedApiProfit };
