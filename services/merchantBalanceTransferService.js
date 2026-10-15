'use strict';

const mongoose = require('mongoose');
const MerchantAccount = require('../models/MerchantAccount');
const { updateBalanceWithLedger } = require('./walletService');

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
            if (/replica set|transaction numbers|transactions are not supported|retryable writes/i.test(String(error.message || ''))) {
                return work(null);
            }
        }
        throw error;
    } finally {
        if (session) session.endSession();
    }
};

const createMerchantBalanceTransfer = async ({ fromMerchantId, toMerchantId, amount, note = '', actor, tenantId = null }) => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw new Error('INVALID_AMOUNT');
    if (!fromMerchantId || !toMerchantId || String(fromMerchantId) === String(toMerchantId)) throw new Error('INVALID_MERCHANTS');
    if (!actor?.id || !actor?.name) throw new Error('INVALID_ACTOR');

    return withOptionalTransaction(async (session) => {
        const filter = { _id: { $in: [fromMerchantId, toMerchantId] }, status: 'active' };
        if (tenantId) filter.tenantId = tenantId;
        const merchants = await MerchantAccount.find(filter, null, session ? { session } : {}).lean();
        const source = merchants.find((merchant) => String(merchant._id) === String(fromMerchantId));
        const target = merchants.find((merchant) => String(merchant._id) === String(toMerchantId));
        if (!source || !target) throw new Error('MERCHANT_NOT_FOUND');
        if (Number(source.balance || 0) < value) throw new Error('INSUFFICIENT_BALANCE');

        const transferId = `MTR-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        const cleanNote = String(note || '').replace(/\u0000/g, '').trim().slice(0, 500);
        const description = cleanNote || `نقل رصيد من ${source.name} إلى ${target.name}`;
        const sourceResult = await updateBalanceWithLedger(
            'MerchantAccount', source._id, -value, 'TRANSFER', transferId,
            `تحويل إلى ${target.name}${cleanNote ? ` — ${cleanNote}` : ''}`,
            { minBalance: 0, session, tenantId }
        );
        const targetResult = await updateBalanceWithLedger(
            'MerchantAccount', target._id, value, 'TRANSFER', transferId,
            `تحويل من ${source.name}${cleanNote ? ` — ${cleanNote}` : ''}`,
            { session, tenantId }
        );
        return {
            transferId,
            amount: value,
            note: description,
            source: { id: String(source._id), name: source.name, balanceAfter: sourceResult.balanceAfter },
            target: { id: String(target._id), name: target.name, balanceAfter: targetResult.balanceAfter }
        };
    });
};

module.exports = { createMerchantBalanceTransfer };
