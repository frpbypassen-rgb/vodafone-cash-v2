'use strict';

const Transaction = require('../models/Transaction');
const { loadCompanyHome } = require('../services/businessPortalService');

const workspace = {
    isCompany: true,
    entity: { _id: 'company-one' },
    actor: { _id: 'employee-one', name: 'موظف التجربة' },
    permissions: { employee: false },
    forceToday: false
};

afterEach(() => jest.restoreAllMocks());

const mockTransactions = (groups = []) => {
    const aggregate = jest.spyOn(Transaction, 'aggregate').mockResolvedValue(groups);
    const query = { sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) };
    const find = jest.spyOn(Transaction, 'find').mockReturnValue(query);
    return { aggregate, find };
};

test('separates completed Egyptian transfers from deposits, other currencies and pending amounts', async () => {
    mockTransactions([
        { _id: { service: 'vodafone', status: 'completed' }, count: 2, amount: 750 },
        { _id: { service: 'bank_account', status: 'completed' }, count: 1, amount: 1200 },
        { _id: { service: 'bankak_sudan', status: 'completed' }, count: 3, amount: 100000 },
        { _id: { service: 'vodafone', status: 'pending' }, count: 1, amount: 800 },
        { _id: { service: 'bank_account', status: 'cancelled_by_admin' }, count: 1, amount: 250 },
        { _id: { service: 'deposit', status: 'deposit' }, count: 1, amount: 350 },
        { _id: { service: 'deposit', status: 'deposit_pending' }, count: 1, amount: 900 }
    ]);
    expect(await loadCompanyHome(workspace)).toEqual({
        cash: { count: 2, amount: 750 }, bank: { count: 1, amount: 1200 }, deposits: 350, pending: 1, recent: []
    });
});

test('scopes summary and recent rows to the company and restricts employees to their own day', async () => {
    const { aggregate, find } = mockTransactions();
    await loadCompanyHome({ ...workspace, forceToday: true, permissions: { employee: true } });
    const summaryScope = aggregate.mock.calls[0][0][0].$match.$and;
    const recentScope = find.mock.calls[0][0].$and;
    expect(summaryScope[0]).toEqual({ $and: [
        { companyId: 'company-one' },
        { $or: [{ clientActorId: 'employee-one' }, { clientActorId: { $exists: false }, employeeName: 'موظف التجربة' }] }
    ] });
    expect(recentScope[0]).toEqual(summaryScope[0]);
    expect(recentScope[1]).toEqual(summaryScope[1]);
    expect(summaryScope[1].createdAt.$gte.getHours()).toBe(0);
    expect(summaryScope[1].createdAt.$lte.getHours()).toBe(23);
});
