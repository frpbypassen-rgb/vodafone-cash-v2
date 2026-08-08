// mappers/mobileAgentSubAccountMapper.js
// مابر البيانات لإدارة الحسابات التابعة لتجنب تسريب أي حقول داخلية أو كلمات مرور للموبايل
'use strict';

const { encodeOpaqueId } = require('../utils/mobileOpaqueId');
const { resolveMarginPiasters } = require('../utils/agencyPricing');
const { calculateCreditState } = require('../services/agencyCreditLimitService');

const toSubAccountListItemDto = (sub) => {
    if (!sub) return null;
    const creditState = calculateCreditState({ balance: sub.balance, creditLimit: sub.creditLimit });

    return {
        id: encodeOpaqueId('sub_account', sub._id),
        accountCode: sub.accountCode || '',
        name: sub.name || '',
        phone: sub.phone || '',
        status: sub.status || 'active',
        ...creditState,
        minimumAllowedBalance: creditState.minimumBalance,
        customMargin: Number(sub.customMargin) || 0,
        marginPiasters: resolveMarginPiasters(sub, 'vodafone'),
        serviceMarginPiasters: sub.serviceMarginPiasters || {},
        createdAt: sub.createdAt ? new Date(sub.createdAt).toISOString() : null
    };
};

const toSubAccountDetailsDto = (sub) => {
    if (!sub) return null;
    const creditState = calculateCreditState({ balance: sub.balance, creditLimit: sub.creditLimit });

    return {
        id: encodeOpaqueId('sub_account', sub._id),
        accountCode: sub.accountCode || '',
        name: sub.name || '',
        phone: sub.phone || '',
        webUsername: sub.webUsername || '',
        status: sub.status || 'active',
        ...creditState,
        minimumAllowedBalance: creditState.minimumBalance,
        customMargin: Number(sub.customMargin) || 0,
        marginPiasters: resolveMarginPiasters(sub, 'vodafone'),
        serviceMarginPiasters: sub.serviceMarginPiasters || {},
        createdAt: sub.createdAt ? new Date(sub.createdAt).toISOString() : null
    };
};

const toAgentOverviewDto = (agent, subAccounts = []) => {
    const balance = Number(agent.balance) || 0;
    const creditLimit = Number(agent.creditLimit) || 0;

    let subAccountsCount = subAccounts.length;
    let activeSubAccountsCount = 0;
    let totalCreditLimit = 0;
    let totalDebt = 0;
    let totalAvailableToSpend = 0;

    subAccounts.forEach(sub => {
        if (sub.status === 'active') {
            activeSubAccountsCount++;
        }
        const creditState = calculateCreditState({ balance: sub.balance, creditLimit: sub.creditLimit });
        
        totalCreditLimit += creditState.creditLimit;
        totalDebt += creditState.debt;
        totalAvailableToSpend += creditState.availableToSpend;
    });

    return {
        agent: {
            name: agent.name || '',
            accountCode: agent.accountCode || '',
            balance,
            creditLimit
        },
        summary: {
            subAccountsCount,
            activeSubAccountsCount,
            totalCreditLimit,
            totalDebt,
            totalAvailableToSpend
        }
    };
};

const toSubAccountSettlementDto = (tx, sub) => {
    if (!tx) return null;
    const creditState = calculateCreditState({ balance: sub.balance, creditLimit: sub.creditLimit });

    return {
        transaction: {
            customId: tx.customId || '',
            status: tx.status || '',
            amount: Number(tx.amount) || 0
        },
        subAccount: {
            id: encodeOpaqueId('sub_account', sub._id),
            ...creditState,
            minimumAllowedBalance: creditState.minimumBalance
        }
    };
};

const toSubAccountTransactionDto = (tx) => {
    if (!tx) return null;
    return {
        id: encodeOpaqueId('transaction', tx._id),
        customId: tx.customId || '',
        status: tx.status || 'unknown',
        amount: Number(tx.amount) || 0,
        costLYD: Number(tx.costLYD) || 0,
        subAccountCostLYD: Number(tx.subAccountCostLYD) || 0,
        exchangeRate: Number(tx.exchangeRate) || 0,
        type: tx.transferType || 'unknown',
        recipientNumber: tx.vodafoneNumber || tx.accountNumber || '',
        createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null
    };
};

module.exports = {
    toSubAccountListItemDto,
    toSubAccountDetailsDto,
    toAgentOverviewDto,
    toSubAccountSettlementDto,
    toSubAccountTransactionDto
};
