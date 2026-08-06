'use strict';

jest.mock('../models/ApiBalanceAudit', () => ({
    findOne: jest.fn(),
    create: jest.fn()
}));

jest.mock('../models/ApiProviderReturn', () => ({
    updateOne: jest.fn()
}));

jest.mock('../models/ExecutorGroup', () => ({
    updateOne: jest.fn(),
    find: jest.fn()
}));

jest.mock('../models/Notification', () => ({
    create: jest.fn()
}));

jest.mock('../models/Transaction', () => ({
    find: jest.fn(),
    updateOne: jest.fn()
}));

jest.mock('../services/externalApiService', () => ({
    getApiProviderBalance: jest.fn(),
    getApiProviderTransactions: jest.fn()
}));

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const ApiBalanceAudit = require('../models/ApiBalanceAudit');
const ApiProviderReturn = require('../models/ApiProviderReturn');
const ExecutorGroup = require('../models/ExecutorGroup');
const Notification = require('../models/Notification');
const Transaction = require('../models/Transaction');
const { getApiProviderBalance, getApiProviderTransactions } = require('../services/externalApiService');
const {
    startApiBalanceAudit,
    finishApiBalanceAudit,
    syncProviderReturnedOperations
} = require('../services/apiProviderReconciliationService');

const queryResult = (value) => ({
    sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(value)
        }),
        lean: jest.fn().mockResolvedValue(value)
    })
});

describe('apiProviderReconciliationService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        ExecutorGroup.updateOne.mockResolvedValue({ acknowledged: true });
        Notification.create.mockResolvedValue({ _id: 'notification-1' });
        Transaction.updateOne.mockResolvedValue({ acknowledged: true });
    });

    test('records continuity mismatch, alerts admin, and still finalizes the balance audit', async () => {
        const tx = { _id: 'tx-1', customId: 'ATT-2608-0100', amount: 50, apiResultData: {} };
        const executorGroup = { _id: 'group-1', name: 'Zayn API' };
        const previous = {
            _id: 'audit-old',
            afterCheck: { success: true, availableBalance: 1000 }
        };
        const audit = {
            _id: 'audit-new',
            beforeCheck: { success: true, availableBalance: 900 },
            alerts: ['رصيد ما قبل العملية (900) لا يطابق رصيد ما بعد آخر عملية (1000)؛ الفرق -100'],
            save: jest.fn().mockResolvedValue(true)
        };

        getApiProviderBalance
            .mockResolvedValueOnce({ success: true, serviceCredit: 900, cashCredit: 0, availableBalance: 900 })
            .mockResolvedValueOnce({ success: true, serviceCredit: 850, cashCredit: 0, availableBalance: 850 });
        ApiBalanceAudit.findOne.mockReturnValue(queryResult(previous));
        ApiBalanceAudit.create.mockImplementation(async (data) => {
            Object.assign(audit, data);
            return audit;
        });

        const started = await startApiBalanceAudit({ tx, executorGroup });
        expect(started.checkStatus).toBe('discrepancy');
        expect(started.continuityDifference).toBe(-100);
        expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({
            audience: 'admin',
            type: 'api_balance_discrepancy',
            txId: 'ATT-2608-0100'
        }));

        const completed = await finishApiBalanceAudit({
            audit: started,
            tx,
            executorGroup,
            apiResult: {
                success: true,
                provider_transaction_id: 'P-100',
                reference_number: 'R-100'
            }
        });

        expect(completed.checkStatus).toBe('discrepancy');
        expect(completed.observedDebit).toBe(50);
        expect(completed.expectedDebit).toBe(50);
        expect(completed.debitDifference).toBe(0);
        expect(completed.executionStatus).toBe('success');
        expect(completed.save).toHaveBeenCalled();
        expect(tx.apiResultData).toMatchObject({
            balanceAuditId: 'audit-new',
            providerBalanceBefore: 900,
            providerBalanceAfter: 850,
            providerBalanceCheckStatus: 'discrepancy'
        });
    });

    test('stores a returned provider operation and creates one actionable alert', async () => {
        const executorGroup = { _id: 'group-1', name: 'Zayn API' };
        const transaction = {
            _id: 'tx-2',
            customId: 'ATT-2608-0200',
            status: 'completed',
            apiResultData: { providerTransactionId: '9001' },
            vodafoneNumber: '01000000001',
            createdAt: new Date()
        };
        Transaction.find.mockReturnValue(queryResult([transaction]));
        getApiProviderTransactions.mockResolvedValue({
            success: true,
            failedCount: 0,
            operations: [{
                success: true,
                requestedTransactionId: '9001',
                providerTransactionId: '9001',
                referenceNumber: 'REF-9001',
                providerStatus: 'عملية مسترجعة',
                amount: 150,
                phone: '01000000001',
                isReturned: true,
                rawData: { TransactionId: 9001 }
            }]
        });
        ApiProviderReturn.updateOne.mockResolvedValue({ upsertedCount: 1 });

        const result = await syncProviderReturnedOperations(executorGroup, { force: true });

        expect(result).toMatchObject({
            success: true,
            checkedCount: 1,
            returnedCount: 1,
            newAlerts: 1
        });
        expect(ApiProviderReturn.updateOne).toHaveBeenCalledWith(
            { executorGroupId: 'group-1', providerTransactionId: '9001' },
            expect.objectContaining({
                $set: expect.objectContaining({
                    transactionCustomId: 'ATT-2608-0200',
                    providerStatus: 'عملية مسترجعة'
                }),
                $setOnInsert: expect.objectContaining({ status: 'pending_review' })
            }),
            { upsert: true }
        );
        expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({
            type: 'api_provider_return',
            txId: 'ATT-2608-0200'
        }));
    });

    test('does not duplicate the admin alert when the same returned operation is detected again', async () => {
        const executorGroup = { _id: 'group-1', name: 'Zayn API' };
        Transaction.find.mockReturnValue(queryResult([{
            _id: 'tx-3',
            customId: 'ATT-2608-0300',
            apiResultData: { externalTransactionId: '9002' },
            createdAt: new Date()
        }]));
        getApiProviderTransactions.mockResolvedValue({
            success: true,
            operations: [{
                success: true,
                requestedTransactionId: '9002',
                providerStatus: 'Refunded',
                isReturned: true,
                rawData: {}
            }]
        });
        ApiProviderReturn.updateOne.mockResolvedValue({ upsertedCount: 0 });

        const result = await syncProviderReturnedOperations(executorGroup, { force: true });

        expect(result.returnedCount).toBe(1);
        expect(result.newAlerts).toBe(0);
        expect(Notification.create).not.toHaveBeenCalled();
    });

    test('records an already-cancelled local transaction without reopening an admin review', async () => {
        const executorGroup = { _id: 'group-1', name: 'Zayn API' };
        Transaction.find.mockReturnValue(queryResult([{
            _id: 'tx-4',
            customId: 'ATT-2608-0400',
            status: 'cancelled_by_admin',
            cancellationNumber: 'CAN-2608-00001',
            cancelledBy: 'Admin',
            cancelledAt: new Date('2026-08-06T12:00:00Z'),
            apiResultData: { providerTransactionId: '9004' },
            createdAt: new Date()
        }]));
        getApiProviderTransactions.mockResolvedValue({
            success: true,
            operations: [{
                success: true,
                requestedTransactionId: '9004',
                providerStatus: 'عملية مسترجعة',
                isReturned: true,
                rawData: {}
            }]
        });
        ApiProviderReturn.updateOne.mockResolvedValue({ upsertedCount: 1 });

        const result = await syncProviderReturnedOperations(executorGroup, { force: true });

        expect(result.returnedCount).toBe(1);
        const update = ApiProviderReturn.updateOne.mock.calls[0][1];
        expect(update.$set).toMatchObject({
            status: 'cancelled',
            cancellationNumber: 'CAN-2608-00001'
        });
        expect(update.$setOnInsert.status).toBeUndefined();
        expect(Notification.create).not.toHaveBeenCalled();
    });
});
