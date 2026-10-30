'use strict';
jest.mock('../models/Transaction', () => ({ aggregate: jest.fn(), find: jest.fn() }));
const Transaction = require('../models/Transaction');
const { loadRetailHome } = require('../services/retailHomeService');
beforeEach(() => {
    Transaction.aggregate.mockResolvedValue([
        { _id: 'completed', count: 36 },
        { _id: 'processing', count: 1 },
        { _id: 'accepted', count: 1 },
    ]);
    Transaction.find.mockReturnValue({
        select: () => ({
            sort: () => ({
                limit: () => ({
                    lean: async () => [
                        {
                            customId: 'ATT-100',
                            status: 'completed',
                            transferType: 'vodafone',
                            amount: 1500,
                            createdAt: new Date('2026-10-30T10:00:00Z'),
                            executorSecret: 'PRIVATE',
                        },
                    ],
                }),
            }),
        }),
    });
    jest.clearAllMocks();
});
test('monthly statistics cover the account independently of the bounded recent list', async () => {
    const result = await loadRetailHome({
        account: { phone: '0911111111' },
        isSubAccount: false,
        now: new Date('2026-10-30T12:00:00Z'),
    });
    expect(result.summary).toMatchObject({ totalCount: 38, completedCount: 36, pendingCount: 2 });
    expect(result.recent).toHaveLength(1);
    expect(result.recent[0]).not.toHaveProperty('executorSecret');
    expect(Transaction.aggregate.mock.calls[0][0][0].$match).toMatchObject({
        userId: '0911111111',
        companyId: null,
        subAccountId: null,
    });
});
test('sub-client home is scoped by its own account ID, not the master phone', async () => {
    await loadRetailHome({ account: { _id: 'child', phone: 'master' }, isSubAccount: true });
    expect(Transaction.aggregate.mock.calls[0][0][0].$match).toMatchObject({ subAccountId: 'child' });
    expect(Transaction.find.mock.calls[0][0]).not.toHaveProperty('userId');
});
test('missing identity never produces an unscoped query', async () => {
    await expect(loadRetailHome({ account: {}, isSubAccount: false })).rejects.toThrow(
        'CUSTOMER_IDENTITY_REQUIRED'
    );
    expect(Transaction.find).not.toHaveBeenCalled();
});
test('empty history produces zero metrics and an empty recent list', async () => {
    Transaction.aggregate.mockResolvedValue([]);
    Transaction.find.mockReturnValue({
        select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
    });
    const result = await loadRetailHome({ account: { phone: '0911111111' }, isSubAccount: false });
    expect(result.summary.totalCount).toBe(0);
    expect(result.recent).toEqual([]);
});
test('tenant identity also scopes both monthly and recent queries when present', async () => {
    await loadRetailHome({
        account: { phone: '0911111111', tenantId: 'retail-tenant' },
        isSubAccount: false,
    });
    expect(Transaction.aggregate.mock.calls[0][0][0].$match.tenantId).toBe('retail-tenant');
    expect(Transaction.find.mock.calls[0][0].tenantId).toBe('retail-tenant');
});
