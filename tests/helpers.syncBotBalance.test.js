'use strict';

jest.mock('../models/ExecutorGroup', () => ({ findById: jest.fn() }));
jest.mock('../models/Transaction', () => ({ find: jest.fn() }));
jest.mock('../models/Employee', () => ({ find: jest.fn() }));
jest.mock('../models/ExecutorBalancePool', () => ({ find: jest.fn() }));
jest.mock('../services/adminFinancialMutationService', () => ({
    withOptionalMongoTransaction: jest.fn((work) => work(null))
}));

const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const Employee = require('../models/Employee');
const ExecutorBalancePool = require('../models/ExecutorBalancePool');
const { syncBotBalance } = require('../utils/helpers');

describe('syncBotBalance company ledger', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Employee.find.mockResolvedValue([]);
        ExecutorBalancePool.find.mockResolvedValue([]);
    });

    test('excludes internal external-executor allocations from the company total', async () => {
        const bot = { _id: 'group-1', isManagerGroup: false, save: jest.fn().mockResolvedValue(true) };
        ExecutorGroup.findById.mockResolvedValue(bot);
        Transaction.find.mockResolvedValue([
            { status: 'deposit', amount: 1000, transferType: 'vodafone' },
            { status: 'completed', amount: 200, transferType: 'vodafone' }
        ]);

        const balance = await syncBotBalance('group-1');

        expect(Transaction.find).toHaveBeenCalledWith(expect.objectContaining({
            executorGroupId: 'group-1',
            transferType: { $ne: 'external_balance' }
        }));
        expect(balance).toBe(800);
        expect(bot.balance).toBe(800);
        expect(bot.serviceBalances).toEqual({ vodafone: 800 });
    });

    test('subtracts solo and pooled allocations only from the primary currency ledger', async () => {
        const bot = { _id: 'group-1', serviceKey: 'vodafone', save: jest.fn().mockResolvedValue(true) };
        ExecutorGroup.findById.mockResolvedValue(bot);
        Transaction.find.mockResolvedValue([
            { status: 'deposit', amount: 1000, transferType: 'vodafone' },
            { status: 'deposit', amount: 400, transferType: 'bank_account' }
        ]);
        ExecutorBalancePool.find.mockResolvedValue([{ _id: 'pool-1', balance: 150 }]);
        Employee.find.mockResolvedValue([
            { role: 'external', balance: 50 }, { role: 'external', balancePoolId: 'pool-1', balance: 150 }
        ]);
        expect(await syncBotBalance('group-1')).toBe(800);
        expect(bot.serviceBalances).toEqual({ vodafone: 800, bank_account: 400 });
    });
});
