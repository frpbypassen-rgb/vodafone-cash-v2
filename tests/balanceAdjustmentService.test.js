'use strict';

const queryResult = (value) => ({
    session: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject)
});

const Ledger = {
    findOne: jest.fn()
};

const Transaction = {
    findOneAndUpdate: jest.fn(),
    findById: jest.fn(),
    updateOne: jest.fn()
};

jest.mock('../models/Ledger', () => Ledger);
jest.mock('../models/Transaction', () => Transaction);
jest.mock('../services/walletService', () => ({
    updateBalanceWithLedger: jest.fn(),
    isMongoTransactionFallbackError: (error) => String(error?.message || '').includes('replica set'),
    requiresMongoTransactions: () => false,
    financialTransactionsUnavailableError: (cause) => Object.assign(
        new Error('FINANCIAL_TRANSACTIONS_UNAVAILABLE'),
        { code: 'FINANCIAL_TRANSACTIONS_UNAVAILABLE', statusCode: 503, cause }
    )
}));

const mongoose = require('mongoose');
const { updateBalanceWithLedger } = require('../services/walletService');
const { voidBalanceAdjustment } = require('../services/balanceAdjustmentService');

describe('Balance adjustment reversal service', () => {
    const transactionId = '64b000000000000000000001';
    const entityId = '64b000000000000000000002';
    const claimed = {
        _id: transactionId,
        customId: 'DED-TEST-001',
        status: 'deduction',
        balanceAdjustment: {}
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mongoose.startSession = jest.fn().mockRejectedValue(new Error('replica set transactions not supported'));
        mongoose.model = jest.fn().mockReturnValue({
            findById: jest.fn().mockReturnValue(queryResult({ _id: entityId, balance: 80 }))
        });
        Transaction.findOneAndUpdate
            .mockReturnValueOnce(queryResult(claimed))
            .mockReturnValueOnce(queryResult({
                ...claimed,
                status: 'cancelled_by_admin',
                cancellationNumber: 'VOID-TEST-001',
                balanceAdjustment: {
                    originalStatus: 'deduction',
                    voidedAt: new Date('2026-08-05T10:00:00.000Z')
                }
            }));
        Ledger.findOne
            .mockReturnValueOnce(queryResult({
                entityModel: 'User',
                entityId,
                amount: -120,
                balanceBefore: 80,
                balanceAfter: -40
            }))
            .mockReturnValueOnce(queryResult(null));
        updateBalanceWithLedger.mockResolvedValue({ balanceBefore: -40, balanceAfter: 80 });
    });

    test('يعكس الخصم ويحتفظ بالمعاملة الأصلية كعملية ملغاة', async () => {
        const result = await voidBalanceAdjustment({
            transactionId,
            performedBy: 'مدير الاختبار',
            reason: 'حذف تسوية اختبارية'
        });

        expect(updateBalanceWithLedger).toHaveBeenCalledWith(
            'User',
            entityId,
            120,
            'REVERSAL',
            'DED-TEST-001',
            expect.stringContaining('إلغاء الخصم'),
            { allowNegative: true }
        );
        expect(Transaction.findOneAndUpdate).toHaveBeenLastCalledWith(
            expect.objectContaining({ _id: transactionId }),
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: 'cancelled_by_admin',
                    cancellationReason: 'حذف تسوية اختبارية',
                    'balanceAdjustment.originalStatus': 'deduction',
                    'balanceAdjustment.reversible': false
                })
            }),
            { new: true }
        );
        expect(Transaction.findOneAndUpdate.mock.calls[1][1].$unset).toEqual({
            'balanceAdjustment.voidToken': 1,
            'balanceAdjustment.voidStartedAt': 1
        });
        expect(result.reversalDelta).toBe(120);
        expect(result.balanceAfter).toBe(80);
    });

    test('يستكمل الإلغاء بعد الانقطاع من قيد العكس الموجود دون تكرار الرصيد', async () => {
        Ledger.findOne
            .mockReset()
            .mockReturnValueOnce(queryResult({
                entityModel: 'User',
                entityId,
                amount: -120,
                balanceBefore: 80,
                balanceAfter: -40
            }))
            .mockReturnValueOnce(queryResult({
                entityModel: 'User',
                entityId,
                type: 'REVERSAL',
                amount: 120,
                balanceBefore: -40,
                balanceAfter: 80,
                description: 'إلغاء الخصم DED-TEST-001 - رقم الإلغاء VOID-260805-ABC123'
            }));

        const result = await voidBalanceAdjustment({
            transactionId,
            performedBy: 'مدير الاختبار',
            reason: 'استكمال إلغاء سابق'
        });

        expect(updateBalanceWithLedger).not.toHaveBeenCalled();
        expect(result.voidNumber).toBe('VOID-260805-ABC123');
        expect(result.balanceBefore).toBe(-40);
        expect(result.balanceAfter).toBe(80);
    });
});
