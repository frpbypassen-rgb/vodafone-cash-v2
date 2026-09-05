'use strict';

jest.mock('../models/Transaction', () => ({
    findById: jest.fn(),
    findOneAndUpdate: jest.fn()
}));
jest.mock('../models/ClientCompany', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../models/User', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../models/ExecutorGroup', () => ({
    findById: jest.fn(),
    findOneAndUpdate: jest.fn()
}));

const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const ClientCompany = require('../models/ClientCompany');
const ExecutorGroup = require('../models/ExecutorGroup');
const {
    editTransactionAmount,
    reassignTransactionExecutor
} = require('../services/adminFinancialMutationService');

describe('adminFinancialMutationService', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalTransactionRequirement = process.env.MONGO_TRANSACTIONS_REQUIRED;
    let session;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.NODE_ENV = 'test';
        process.env.MONGO_TRANSACTIONS_REQUIRED = 'false';
        session = {
            startTransaction: jest.fn(),
            commitTransaction: jest.fn().mockResolvedValue(undefined),
            abortTransaction: jest.fn().mockResolvedValue(undefined),
            endSession: jest.fn()
        };
        mongoose.startSession = jest.fn().mockResolvedValue(session);
    });

    afterAll(() => {
        process.env.NODE_ENV = originalNodeEnv;
        if (originalTransactionRequirement === undefined) delete process.env.MONGO_TRANSACTIONS_REQUIRED;
        else process.env.MONGO_TRANSACTIONS_REQUIRED = originalTransactionRequirement;
    });

    test('updates a completed transfer and all affected balances in one session', async () => {
        const transaction = {
            _id: 'tx-1',
            amount: 100,
            costLYD: 50,
            exchangeRate: 2,
            transferType: 'vodafone_cash',
            status: 'completed',
            companyId: 'company-1',
            executorGroupId: 'executor-1',
            managerGroupId: 'manager-1',
            adminNotes: '',
            createdAt: new Date('2026-01-01T00:00:00.000Z')
        };
        const query = { session: jest.fn().mockResolvedValue(transaction) };
        Transaction.findById.mockReturnValue(query);
        ClientCompany.findOneAndUpdate.mockResolvedValue({ _id: 'company-1' });
        ExecutorGroup.findOneAndUpdate.mockResolvedValue({ _id: 'group' });
        Transaction.findOneAndUpdate.mockResolvedValue({ ...transaction, amount: 140, costLYD: 70 });

        const result = await editTransactionAmount({
            transactionId: 'tx-1',
            newAmount: 140,
            adminName: 'Admin'
        });

        expect(ClientCompany.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: 'company-1' },
            { $inc: { balance: -20 } },
            { new: true, session }
        );
        expect(ExecutorGroup.findOneAndUpdate).toHaveBeenNthCalledWith(
            1,
            { _id: 'executor-1' },
            { $inc: { balance: -40 } },
            { new: true, session }
        );
        expect(ExecutorGroup.findOneAndUpdate).toHaveBeenNthCalledWith(
            2,
            { _id: 'manager-1' },
            { $inc: { balance: -40 } },
            { new: true, session }
        );
        expect(result.newCostLYD).toBe(70);
        expect(session.commitTransaction).toHaveBeenCalledTimes(1);
    });

    test('updates a deposit balance and returns bot balances that need recalculation', async () => {
        const transaction = {
            _id: 'tx-2',
            amount: 100,
            costLYD: 0,
            status: 'deposit',
            companyId: 'company-2',
            adminNotes: ''
        };
        Transaction.findById.mockReturnValue({ session: jest.fn().mockResolvedValue(transaction) });
        ClientCompany.findOneAndUpdate.mockResolvedValue({ _id: 'company-2' });
        Transaction.findOneAndUpdate.mockResolvedValue({ ...transaction, amount: 125 });

        const result = await editTransactionAmount({ transactionId: 'tx-2', newAmount: 125, adminName: 'Admin' });

        expect(ClientCompany.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: 'company-2' },
            { $inc: { balance: 25 } },
            { new: true, session }
        );
        expect(result.syncGroupIds).toEqual([]);
    });

    test('reassigns a completed transfer with offsetting executor balance changes', async () => {
        const transaction = {
            _id: 'tx-3',
            amount: 80,
            status: 'completed',
            transferType: 'vodafone',
            executorGroupId: 'old-executor',
            managerGroupId: 'old-manager',
            executorName: 'Old executor',
            adminNotes: ''
        };
        const newExecutor = {
            _id: 'new-executor',
            name: 'New executor',
            status: 'active',
            serviceKey: 'vodafone',
            parentGroupId: 'new-manager'
        };
        Transaction.findById.mockReturnValue({ session: jest.fn().mockResolvedValue(transaction) });
        ExecutorGroup.findById.mockReturnValue({ session: jest.fn().mockResolvedValue(newExecutor) });
        ExecutorGroup.findOneAndUpdate.mockResolvedValue({ _id: 'group' });
        Transaction.findOneAndUpdate.mockResolvedValue({ ...transaction, executorGroupId: 'new-executor', executorName: 'New executor' });

        const result = await reassignTransactionExecutor({ transactionId: 'tx-3', newGroupId: 'new-executor' });

        expect(ExecutorGroup.findOneAndUpdate).toHaveBeenNthCalledWith(
            1, { _id: 'old-executor' }, { $inc: { balance: 80 } }, { new: true, session }
        );
        expect(ExecutorGroup.findOneAndUpdate).toHaveBeenNthCalledWith(
            2, { _id: 'old-manager' }, { $inc: { balance: 80 } }, { new: true, session }
        );
        expect(ExecutorGroup.findOneAndUpdate).toHaveBeenNthCalledWith(
            3, { _id: 'new-executor' }, { $inc: { balance: -80 } }, { new: true, session }
        );
        expect(ExecutorGroup.findOneAndUpdate).toHaveBeenNthCalledWith(
            4, { _id: 'new-manager' }, { $inc: { balance: -80 } }, { new: true, session }
        );
        expect(result.oldExecutorName).toBe('Old executor');
    });
});
