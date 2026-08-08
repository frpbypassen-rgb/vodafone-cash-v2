'use strict';

const CREDIT_LIMIT_DECIMALS = 3;
const MAX_CREDIT_LIMIT_LYD = 1000000000;

class AgencyCreditLimitError extends Error {
    constructor(code) {
        super(code);
        this.name = 'AgencyCreditLimitError';
        this.code = code;
    }
}

const roundMoney = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    const factor = 10 ** CREDIT_LIMIT_DECIMALS;
    return Math.round((numeric + Number.EPSILON) * factor) / factor;
};

const readMoney = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? roundMoney(numeric) : 0;
};

const readCreditLimit = (value) => Math.max(0, readMoney(value));

const normalizeCreditLimit = (value, { required = false } = {}) => {
    const blank = value === undefined || value === null || String(value).trim() === '';
    if (blank && !required) return 0;

    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_CREDIT_LIMIT_LYD) {
        throw new AgencyCreditLimitError('INVALID_CREDIT_LIMIT');
    }

    return roundMoney(numeric);
};

const calculateCreditState = ({ balance = 0, creditLimit = 0 } = {}) => {
    const currentBalance = readMoney(balance);
    const limit = readCreditLimit(creditLimit);
    const minimumBalance = roundMoney(-limit);
    const debt = roundMoney(Math.max(0, -currentBalance));
    const availableToSpend = roundMoney(Math.max(0, currentBalance + limit));
    const usedCredit = roundMoney(Math.min(limit, debt));
    const remainingCredit = roundMoney(Math.max(0, limit - usedCredit));

    return {
        balance: currentBalance,
        creditLimit: limit,
        minimumBalance,
        debt,
        availableToSpend,
        usedCredit,
        remainingCredit
    };
};

const minimumBalanceForDebit = (cost, creditLimit) => {
    const debit = readMoney(cost);
    return roundMoney(debit - readCreditLimit(creditLimit));
};

const assertCreditLimitCanCoverBalance = ({ balance = 0, creditLimit = 0 } = {}) => {
    const state = calculateCreditState({ balance, creditLimit });
    if (state.balance < state.minimumBalance) {
        throw new AgencyCreditLimitError('CREDIT_LIMIT_BELOW_OUTSTANDING_DEBT');
    }
    return state;
};

module.exports = {
    AgencyCreditLimitError,
    CREDIT_LIMIT_DECIMALS,
    MAX_CREDIT_LIMIT_LYD,
    roundMoney,
    readMoney,
    readCreditLimit,
    normalizeCreditLimit,
    calculateCreditState,
    minimumBalanceForDebit,
    assertCreditLimitCanCoverBalance
};
