'use strict';

jest.mock('../models/Transaction', () => ({
    find: jest.fn()
}));
jest.mock('../models/UnifiedReportEntry', () => ({
    bulkWrite: jest.fn()
}));
jest.mock('../models/UnifiedReportState', () => ({
    updateOne: jest.fn()
}));

const Transaction = require('../models/Transaction');
const UnifiedReportEntry = require('../models/UnifiedReportEntry');
const {
    buildReportEntry,
    buildReportSnapshot,
    findReportTransactions
} = require('../services/unifiedReportService');

describe('unified report service', () => {
    beforeEach(() => jest.clearAllMocks());

    test('builds one searchable report entry without idempotency secrets', () => {
        const transaction = {
            _id: '507f1f77bcf86cd799439011',
            customId: 'ATT-2608-5001',
            status: 'completed',
            transferType: 'vodafone',
            userId: '0911111111',
            companyId: '507f1f77bcf86cd799439012',
            executorGroupId: '507f1f77bcf86cd799439013',
            operatorId: '507f1f77bcf86cd799439014',
            amount: 100,
            costLYD: 18,
            idempotencyKey: 'secret-key',
            idempotencyFingerprint: 'secret-fingerprint',
            idempotencyResponse: { private: true },
            createdAt: new Date('2026-08-24T10:00:00.000Z'),
            updatedAt: new Date('2026-08-24T10:01:00.000Z')
        };

        const snapshot = buildReportSnapshot(transaction);
        const entry = buildReportEntry(transaction);

        expect(snapshot).not.toHaveProperty('idempotencyKey');
        expect(snapshot).not.toHaveProperty('idempotencyFingerprint');
        expect(snapshot).not.toHaveProperty('idempotencyResponse');
        expect(entry).toMatchObject({
            transactionId: transaction._id,
            customId: transaction.customId,
            userId: transaction.userId,
            companyId: transaction.companyId,
            executorGroupId: transaction.executorGroupId,
            operatorId: transaction.operatorId,
            status: 'completed'
        });
        expect(entry.snapshot.amount).toBe(100);
        expect(entry.snapshot.costLYD).toBe(18);
    });

    test('keeps the existing query contract while routing reads through one gateway', async () => {
        const rows = [{ customId: 'ATT-1', status: 'completed', amount: 100 }];
        const lean = jest.fn().mockResolvedValue(rows);
        const sort = jest.fn().mockReturnValue({ lean });
        const select = jest.fn().mockReturnValue({ sort, lean });
        Transaction.find.mockReturnValue({ select, sort, lean });

        const result = await findReportTransactions(
            { operatorId: 'employee-1', createdAt: { $gte: new Date('2026-08-24') } },
            { select: 'status amount', sort: { createdAt: -1 } }
        );

        expect(Transaction.find).toHaveBeenCalledWith(expect.objectContaining({
            operatorId: 'employee-1'
        }));
        expect(select).toHaveBeenCalledWith('status amount');
        expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
        expect(result).toEqual(rows);
        expect(UnifiedReportEntry.bulkWrite).not.toHaveBeenCalled();
    });
});
