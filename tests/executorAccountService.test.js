'use strict';

jest.mock('../models/Employee', () => ({
    exists: jest.fn(),
    create: jest.fn(),
    deleteOne: jest.fn()
}));
jest.mock('../models/ExecutorGroup', () => ({
    create: jest.fn(),
    deleteOne: jest.fn()
}));
jest.mock('../models/Transaction', () => ({
    create: jest.fn(),
    deleteOne: jest.fn()
}));

const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const {
    createExecutorAccount,
    createRegisteredExecutorAccount,
    normalizeExecutorUsername
} = require('../services/executorAccountService');

describe('Executor account service', () => {
    let group;
    let manager;

    beforeEach(() => {
        jest.clearAllMocks();
        group = { _id: 'group-1', name: 'منفذ طرابلس', balance: 0, save: jest.fn().mockResolvedValue(true) };
        manager = { _id: 'employee-1' };
        ExecutorGroup.create.mockResolvedValue(group);
        ExecutorGroup.deleteOne.mockResolvedValue({ deletedCount: 1 });
        Employee.exists.mockResolvedValue(null);
        Employee.create.mockResolvedValue(manager);
        Employee.deleteOne.mockResolvedValue({ deletedCount: 1 });
        Transaction.create.mockResolvedValue({ _id: 'opening-1' });
        Transaction.deleteOne.mockResolvedValue({ deletedCount: 1 });
    });

    test('creates a manual executor with normalized login and persistent opening balance', async () => {
        const result = await createExecutorAccount({
            groupData: { name: 'منفذ طرابلس', status: 'active', isApiBot: false },
            managerData: {
                name: 'مدير منفذ طرابلس',
                phone: '091-123-4567',
                webUsername: 'Tripoli_Executor',
                webPassword: 'secret1'
            },
            openingBalance: 5000
        });

        expect(Employee.create).toHaveBeenCalledWith(expect.objectContaining({
            webUsername: 'tripoli_executor@ahram.com',
            phone: '0911234567',
            role: 'manager',
            groupId: 'group-1',
            canViewAllReports: true
        }));
        expect(Transaction.create).toHaveBeenCalledWith(expect.objectContaining({
            executorGroupId: 'group-1',
            status: 'deposit',
            amount: 5000
        }));
        expect(group.balance).toBe(5000);
        expect(group.save).toHaveBeenCalled();
        expect(result.employee).toBe(manager);
    });

    test('records a negative opening balance as a deduction', async () => {
        await createExecutorAccount({
            groupData: { name: 'منفذ مدين', status: 'active', isApiBot: false },
            managerData: {
                name: 'مدير منفذ مدين',
                phone: '0911234568',
                webUsername: 'debit_executor',
                webPassword: 'secret1'
            },
            openingBalance: -350
        });

        expect(Transaction.create).toHaveBeenCalledWith(expect.objectContaining({
            status: 'deduction',
            amount: 350
        }));
        expect(group.balance).toBe(-350);
    });

    test('creates approved registrations as routable manual groups', async () => {
        await createRegisteredExecutorAccount({
            companyName: 'منفذ التسجيل',
            managerName: 'مدير التسجيل',
            phone: '0911234569',
            webUsername: 'registered_executor@ahram.com',
            webPassword: '$2b$12$alreadyHashedPassword'
        });

        expect(ExecutorGroup.create).toHaveBeenCalledWith(expect.objectContaining({
            name: 'منفذ التسجيل',
            isManagerGroup: false,
            isManagerBot: false,
            isApiGroup: false,
            isApiBot: false,
            status: 'active'
        }));
    });

    test('rejects duplicate usernames before creating a group', async () => {
        Employee.exists.mockResolvedValue({ _id: 'existing' });

        await expect(createExecutorAccount({
            groupData: { name: 'منفذ مكرر', isApiBot: false },
            managerData: {
                name: 'مدير مكرر',
                phone: '0911234570',
                webUsername: 'duplicate',
                webPassword: 'secret1'
            }
        })).rejects.toMatchObject({ code: 'USERNAME_TAKEN' });

        expect(ExecutorGroup.create).not.toHaveBeenCalled();
    });

    test('rejects a non-numeric opening balance before creating a group', async () => {
        await expect(createExecutorAccount({
            groupData: { name: 'منفذ رصيد غير صالح', isApiBot: false },
            managerData: {
                name: 'مدير الرصيد',
                phone: '0911234572',
                webUsername: 'invalid_balance_executor',
                webPassword: 'secret1'
            },
            openingBalance: Number.NaN
        })).rejects.toMatchObject({ code: 'INVALID_BALANCE' });

        expect(ExecutorGroup.create).not.toHaveBeenCalled();
    });

    test('removes an orphan group when manager creation fails', async () => {
        Employee.create.mockRejectedValue(new Error('database failure'));

        await expect(createExecutorAccount({
            groupData: { name: 'منفذ متراجع', isApiBot: false },
            managerData: {
                name: 'مدير متراجع',
                phone: '0911234571',
                webUsername: 'rollback_executor',
                webPassword: 'secret1'
            }
        })).rejects.toThrow('database failure');

        expect(ExecutorGroup.deleteOne).toHaveBeenCalledWith({ _id: 'group-1' });
    });

    test('normalizes short usernames consistently', () => {
        expect(normalizeExecutorUsername('  EXEC_01@AHRAM.COM ')).toBe('exec_01@ahram.com');
    });
});
