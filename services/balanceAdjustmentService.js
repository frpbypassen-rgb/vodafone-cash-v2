'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Transaction = require('../models/Transaction');
const { updateBalanceWithLedger, isMongoTransactionFallbackError } = require('./walletService');

const REVERSIBLE_MODELS = Object.freeze(['User', 'ClientCompany', 'SubAccount']);

const withSession = (query, session) => (session ? query.session(session) : query);

const createVoidNumber = () => {
    const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    return `VOID-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

const runWithOptionalTransaction = async (work) => {
    let session;
    try {
        session = await mongoose.startSession();
        session.startTransaction();
        const result = await work(session);
        await session.commitTransaction();
        return result;
    } catch (error) {
        if (session) {
            try { await session.abortTransaction(); } catch (_) {}
        }
        if (isMongoTransactionFallbackError(error)) return work(null);
        throw error;
    } finally {
        if (session) session.endSession();
    }
};

const findOriginalLedger = async (transaction, session) => {
    const expectedType = transaction.status === 'deposit' ? 'DEPOSIT' : 'DEDUCTION';
    const amountFilter = transaction.status === 'deposit' ? { $gt: 0 } : { $lt: 0 };
    const filter = {
        transactionId: transaction.customId,
        type: expectedType,
        amount: amountFilter,
        entityModel: { $in: REVERSIBLE_MODELS }
    };

    if (transaction.balanceAdjustment?.entityModel) filter.entityModel = transaction.balanceAdjustment.entityModel;
    if (transaction.balanceAdjustment?.entityId) filter.entityId = transaction.balanceAdjustment.entityId;

    return withSession(Ledger.findOne(filter).sort({ createdAt: 1 }), session);
};

const voidBalanceAdjustment = async ({ transactionId, performedBy, reason }) => runWithOptionalTransaction(async (session) => {
    const token = crypto.randomUUID();
    const voidStartedAt = new Date();
    const staleVoidBefore = new Date(voidStartedAt.getTime() - (2 * 60 * 1000));
    let claimed = null;

    try {
        claimed = await withSession(Transaction.findOneAndUpdate(
            {
                _id: transactionId,
                status: { $in: ['deposit', 'deduction'] },
                'balanceAdjustment.voidedAt': { $exists: false },
                $or: [
                    { 'balanceAdjustment.voidToken': { $exists: false } },
                    { 'balanceAdjustment.voidToken': null },
                    { 'balanceAdjustment.voidToken': '' },
                    { 'balanceAdjustment.voidStartedAt': { $exists: false } },
                    { 'balanceAdjustment.voidStartedAt': { $lt: staleVoidBefore } }
                ]
            },
            {
                $set: {
                    'balanceAdjustment.voidToken': token,
                    'balanceAdjustment.voidStartedAt': voidStartedAt
                }
            },
            { new: true, ...(session ? { session } : {}) }
        ), session);

        if (!claimed) {
            const existing = await withSession(Transaction.findById(transactionId), session);
            if (!existing) throw new Error('ADJUSTMENT_NOT_FOUND');
            if (existing.balanceAdjustment?.voidedAt || existing.status === 'cancelled_by_admin') {
                throw new Error('ADJUSTMENT_ALREADY_VOIDED');
            }
            throw new Error('ADJUSTMENT_NOT_REVERSIBLE');
        }

        const originalLedger = await findOriginalLedger(claimed, session);
        if (!originalLedger) throw new Error('ADJUSTMENT_LEDGER_NOT_FOUND');

        const entityModel = originalLedger.entityModel;
        const entityId = originalLedger.entityId;
        if (!REVERSIBLE_MODELS.includes(entityModel)) throw new Error('ADJUSTMENT_NOT_REVERSIBLE');

        const normalizedReason = String(reason || 'حذف التسوية من الإدارة').trim().slice(0, 240);
        const originalLabel = claimed.status === 'deposit' ? 'الإيداع' : 'الخصم';
        const reversalDelta = -Number(originalLedger.amount);
        const existingReversal = await withSession(Ledger.findOne({
            transactionId: claimed.customId,
            type: 'REVERSAL',
            entityModel,
            entityId
        }).sort({ createdAt: -1 }), session);
        const existingVoidNumber = String(existingReversal?.description || '').match(/VOID-\d{6}-[A-F0-9]{6}/)?.[0];
        const voidNumber = existingVoidNumber || createVoidNumber();

        const balanceResult = existingReversal
            ? { balanceBefore: existingReversal.balanceBefore, balanceAfter: existingReversal.balanceAfter }
            : await updateBalanceWithLedger(
                entityModel,
                entityId,
                reversalDelta,
                'REVERSAL',
                claimed.customId,
                `إلغاء ${originalLabel} ${claimed.customId} - رقم الإلغاء ${voidNumber}`,
                { allowNegative: true, ...(session ? { session } : {}) }
            );

        const voidedAt = new Date();
        const voidedBy = String(performedBy || 'الإدارة').trim().slice(0, 160);
        const finalized = await withSession(Transaction.findOneAndUpdate(
            { _id: claimed._id, 'balanceAdjustment.voidToken': token },
            {
                $set: {
                    status: 'cancelled_by_admin',
                    cancellationNumber: voidNumber,
                    cancellationReason: normalizedReason,
                    cancelledBy: voidedBy,
                    cancelledAt: voidedAt,
                    'balanceAdjustment.entityModel': entityModel,
                    'balanceAdjustment.entityId': entityId,
                    'balanceAdjustment.delta': Number(originalLedger.amount),
                    'balanceAdjustment.reversible': false,
                    'balanceAdjustment.originalStatus': claimed.status,
                    'balanceAdjustment.voidedAt': voidedAt,
                    'balanceAdjustment.voidedBy': voidedBy,
                    'balanceAdjustment.voidReason': normalizedReason
                },
                $unset: {
                    'balanceAdjustment.voidToken': 1,
                    'balanceAdjustment.voidStartedAt': 1
                }
            },
            { new: true, ...(session ? { session } : {}) }
        ), session);
        if (!finalized) throw new Error('ADJUSTMENT_VOID_CONFLICT');

        const Model = mongoose.model(entityModel);
        const account = await withSession(Model.findById(entityId), session);
        if (!account) throw new Error('ACCOUNT_NOT_FOUND');

        return {
            transaction: finalized,
            account,
            entityModel,
            entityId,
            reversalDelta,
            balanceBefore: balanceResult.balanceBefore,
            balanceAfter: balanceResult.balanceAfter,
            voidNumber
        };
    } catch (error) {
        if (!session && claimed) {
            await Transaction.updateOne(
                { _id: claimed._id, 'balanceAdjustment.voidToken': token },
                {
                    $unset: {
                        'balanceAdjustment.voidToken': 1,
                        'balanceAdjustment.voidStartedAt': 1
                    }
                }
            ).catch(() => {});
        }
        throw error;
    }
});

module.exports = {
    REVERSIBLE_MODELS,
    voidBalanceAdjustment
};
