'use strict';

const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const MerchantAccount = require('../models/MerchantAccount');
const ExecutorGroup = require('../models/ExecutorGroup');
const { updateBalanceWithLedger } = require('./walletService');
const { getExecutorEnabledServiceKeys, getExecutorPrimaryServiceKey, normalizeExecutorServiceKey } = require('../utils/executorServiceCatalog');
const { fundingFieldsForService } = require('../utils/executorServiceLedger');

const withOptionalTransaction = async (work) => {
    let session;
    try {
        session = await mongoose.startSession();
        session.startTransaction();
        const result = await work(session);
        await session.commitTransaction();
        return result;
    } catch (error) {
        if (session) {
            await session.abortTransaction().catch(() => {});
            if (/replica set|transaction numbers|transactions are not supported|retryable writes/i.test(String(error.message || ''))) return work(null);
        }
        throw error;
    } finally {
        if (session) session.endSession();
    }
};

const resolveDepositServiceKey = (executor, requestedServiceKey) => {
    const enabled = getExecutorEnabledServiceKeys(executor);
    const primary = getExecutorPrimaryServiceKey(executor);
    const serviceKey = normalizeExecutorServiceKey(requestedServiceKey || primary, null);
    if (!serviceKey || !enabled.includes(serviceKey)) throw new Error('INVALID_EXECUTOR_SERVICE');
    return serviceKey;
};

const createMerchantExecutorDepositRequest = async ({ merchantId, executorId, amountEGP, exchangeRate, serviceKey, actor, note = '' }) => {
    const amount = Number(amountEGP);
    const rate = Number(exchangeRate);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_AMOUNT');
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('INVALID_EXCHANGE_RATE');
    const amountLYD = Number((amount / rate).toFixed(3));
    const [merchant, executor] = await Promise.all([
        MerchantAccount.findOne({ _id: merchantId, status: 'active' }).lean(),
        ExecutorGroup.findOne({ _id: executorId, status: { $nin: ['archived', 'inactive'] } })
    ]);
    if (!merchant) throw new Error('MERCHANT_NOT_FOUND');
    if (!executor) throw new Error('EXECUTOR_NOT_FOUND');
    const selectedServiceKey = resolveDepositServiceKey(executor, serviceKey);
    const { createDepositRequest } = require('./executorDepositRequestService');
    const request = await createDepositRequest({
        employee: { groupId: executor._id },
        group: executor,
        submittedBy: { id: actor.id, name: actor.name, phone: '' },
        amount,
        note,
        receipts: [],
        submittedFromAdmin: true,
        serviceKey: selectedServiceKey,
        settlementDetails: {
            category: 'merchant_executor_deposit_request',
            paymentMethod: 'merchant_exchange',
            statement: `بعد القبول: خصم ${amountLYD} LYD من التاجر وإضافة ${amount} EGP للمنفذ`
        },
        apiResultData: {
            financialSource: 'merchant',
            merchantId: String(merchant._id),
            merchantAmountLYD: amountLYD,
            executorAmountEGP: amount,
            exchangeRate: rate,
            serviceKey: selectedServiceKey
        }
    });
    return { ...request, amountEGP: amount, amountLYD, exchangeRate: rate };
};

const createMerchantExecutorDeposit = async ({ merchantId, executorId, officeId = null, amountEGP, exchangeRate, serviceKey, actor, tenantId = null, note = '' }) => {
    const amount = Number(amountEGP);
    const rate = Number(exchangeRate);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_AMOUNT');
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('INVALID_EXCHANGE_RATE');
    const amountLYD = Number((amount / rate).toFixed(3));
    return withOptionalTransaction(async (session) => {
        const options = session ? { session } : {};
        const [merchant, executor] = await Promise.all([
            MerchantAccount.findOne({ _id: merchantId, status: 'active' }, null, options),
            ExecutorGroup.findOne({ _id: executorId, status: { $nin: ['archived', 'inactive'] } }, null, options)
        ]);
        if (!merchant) throw new Error('MERCHANT_NOT_FOUND');
        if (!executor) throw new Error('EXECUTOR_NOT_FOUND');
        const selectedServiceKey = resolveDepositServiceKey(executor, serviceKey);
        const funding = fundingFieldsForService(selectedServiceKey);
        const customId = `MDEP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        const transaction = (await Transaction.create([{
            tenantId: tenantId || undefined, userId: 'admin', executorGroupId: executor._id,
            amount, costLYD: amountLYD, exchangeRate: rate, status: 'deposit', customId,
            vodafoneNumber: 'إيداع تاجر للمنفذ', companyName: merchant.name, employeeName: actor.name,
            executorName: executor.name, adminNotes: note, ...funding,
            settlementDetails: { category: 'merchant_executor_deposit', paymentMethod: 'merchant_exchange', serviceKey: selectedServiceKey, statement: `خصم ${amountLYD} LYD من التاجر وإضافة ${amount} EGP للمنفذ`, settledBy: actor.name }
        }], session ? { session } : {}))[0];
        const merchantResult = await updateBalanceWithLedger('MerchantAccount', merchant._id, -amountLYD, 'DEDUCTION', customId, `خصم تاجر مقابل إيداع ${amount} EGP للمنفذ`, { allowNegative: true, session, tenantId });
        const executorResult = await updateBalanceWithLedger('ExecutorGroup', executor._id, amount, 'DEPOSIT', customId, `إيداع ${amount} EGP من التاجر ${merchant.name}`, { allowNegative: true, session, tenantId });
        transaction.balanceAdjustment = { entityModel: 'ExecutorGroup', entityId: executor._id, delta: amount, reversible: false, originalStatus: 'deposit' };
        transaction.apiResultData = { financialSource: 'merchant', merchantId: String(merchant._id), officeId: officeId ? String(officeId) : '', merchantAmountLYD: amountLYD, executorAmountEGP: amount, exchangeRate: rate, serviceKey: selectedServiceKey };
        await transaction.save(session ? { session } : {});
        return { transaction, merchantBalanceAfter: merchantResult.balanceAfter, executorBalanceAfter: executorResult.balanceAfter, amountLYD, amountEGP: amount, exchangeRate: rate };
    });
};

const settleMerchantExecutorDepositRequest = async ({ transactionId, actor, session = null }) => {
    const options = session ? { session } : {};
    const transaction = await Transaction.findOne({
        _id: transactionId,
        status: 'deposit',
        'settlementDetails.category': 'merchant_executor_deposit_request',
        'apiResultData.financialSource': 'merchant'
    }, null, options);
    if (!transaction) throw new Error('MERCHANT_DEPOSIT_REQUEST_NOT_FOUND');
    const merchant = await MerchantAccount.findOne({ _id: transaction.apiResultData?.merchantId }, null, options);
    if (!merchant) throw new Error('MERCHANT_NOT_FOUND');
    const amountEGP = Number(transaction.apiResultData?.executorAmountEGP || transaction.amount || 0);
    const amountLYD = Number(transaction.apiResultData?.merchantAmountLYD || transaction.costLYD || 0);
    const merchantResult = await updateBalanceWithLedger('MerchantAccount', merchant._id, -amountLYD, 'DEDUCTION', transaction.customId, `خصم تاجر مقابل إيداع ${amountEGP} EGP للمنفذ`, { allowNegative: true, session, tenantId: transaction.tenantId });
    const executorResult = await updateBalanceWithLedger('ExecutorGroup', transaction.executorGroupId, amountEGP, 'DEPOSIT', transaction.customId, `إيداع ${amountEGP} EGP من التاجر ${merchant.name}`, { allowNegative: true, session, tenantId: transaction.tenantId });
    transaction.costLYD = amountLYD;
    transaction.exchangeRate = Number(transaction.apiResultData?.exchangeRate || transaction.exchangeRate || 0);
    transaction.balanceAdjustment = { entityModel: 'ExecutorGroup', entityId: transaction.executorGroupId, delta: amountEGP, reversible: false, originalStatus: 'deposit_pending' };
    transaction.apiResultData = { ...transaction.apiResultData.toObject?.() || transaction.apiResultData, settledAt: new Date(), settledBy: actor?.name || '' };
    await transaction.save(options);
    return { merchantBalanceAfter: merchantResult.balanceAfter, executorBalanceAfter: executorResult.balanceAfter, amountEGP, amountLYD };
};

module.exports = { createMerchantExecutorDeposit, createMerchantExecutorDepositRequest, settleMerchantExecutorDepositRequest };

const reverseMerchantExecutorDeposit = async ({ transactionId, actor, tenantId = null, reason = '' }) => withOptionalTransaction(async (session) => {
    const options = session ? { session } : {};
    const original = await Transaction.findOne({ customId: transactionId, status: 'deposit', 'apiResultData.financialSource': 'merchant' }, null, options);
    if (!original) throw new Error('MERCHANT_DEPOSIT_NOT_FOUND');
    if (original.apiResultData?.reversedAt) throw new Error('MERCHANT_DEPOSIT_ALREADY_REVERSED');
    const merchantId = original.apiResultData?.merchantId;
    const merchant = await MerchantAccount.findOne({ _id: merchantId }, null, options);
    if (!merchant) throw new Error('MERCHANT_NOT_FOUND');
    const amountEGP = Number(original.amount || 0);
    const amountLYD = Number(original.costLYD || 0);
    const reversalId = `MREV-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await updateBalanceWithLedger('MerchantAccount', merchant._id, amountLYD, 'REVERSAL', reversalId, `عكس إيداع المنفذ ${transactionId}`, { allowNegative: true, session, tenantId });
    await updateBalanceWithLedger('ExecutorGroup', original.executorGroupId, -amountEGP, 'REVERSAL', reversalId, `عكس إيداع التاجر ${transactionId}`, { allowNegative: true, session, tenantId });
    original.apiResultData = { ...original.apiResultData.toObject?.() || original.apiResultData, reversedAt: new Date(), reversedBy: actor.name, reversalId, reversalReason: reason };
    await original.save(session ? { session } : {});
    const reversal = (await Transaction.create([{
        tenantId: tenantId || undefined, userId: 'admin', executorGroupId: original.executorGroupId,
        amount: amountEGP, costLYD: amountLYD, exchangeRate: original.exchangeRate, status: 'deduction', customId: reversalId,
        vodafoneNumber: 'عكس إيداع تاجر', companyName: merchant.name, employeeName: actor.name, executorName: original.executorName,
        adminNotes: reason, settlementDetails: { category: 'merchant_executor_deposit_reversal', externalReference: transactionId, settledBy: actor.name }
    }], session ? { session } : {}))[0];
    return { reversal, reversalId, amountEGP, amountLYD };
});

module.exports.reverseMerchantExecutorDeposit = reverseMerchantExecutorDeposit;
