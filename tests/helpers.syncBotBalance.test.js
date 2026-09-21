'use strict';

jest.mock('../models/ExecutorGroup', () => ({ findById: jest.fn() }));
jest.mock('../models/Transaction', () => ({ find: jest.fn() }));

const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const { syncBotBalance } = require('../utils/helpers');

describe('syncBotBalance company ledger', () => {
    beforeEach(() => {
        jest.clearAllMocks();
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
    });
});
