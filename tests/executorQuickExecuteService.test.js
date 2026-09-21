'use strict';

jest.mock('../models/Employee');
jest.mock('../services/executorTaskRoutingService', () => ({
    findOwnedAcceptedExecutorTask: jest.fn()
}));
jest.mock('../services/executorAuthCache', () => ({
    invalidateExecutorAuth: jest.fn()
}));

process.env.JWT_SECRET = 'test-secret-key-for-encryption-32chars-long-enough';

const Employee = require('../models/Employee');
const { encrypt } = require('../utils/encryption');
const { findOwnedAcceptedExecutorTask } = require('../services/executorTaskRoutingService');
const {
    QuickExecuteError,
    buildQuickExecuteDial,
    saveQuickExecutePreferences
} = require('../services/executorQuickExecuteService');

const chainEmployee = (employee) => {
    const query = {
        select: jest.fn().mockReturnThis(),
        populate: jest.fn().mockReturnThis(),
        then: (resolve, reject) => Promise.resolve(employee).then(resolve, reject)
    };
    return query;
};

describe('executor quick execute service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('encrypts the wallet PIN and never keeps plaintext on the employee', async () => {
        const employee = {
            _id: 'emp-1',
            ussdNetwork: 'vodafone',
            groupId: { manualQuickExecuteEnabled: true },
            save: jest.fn().mockResolvedValue(true)
        };
        Employee.findById.mockReturnValue(chainEmployee(employee));

        const state = await saveQuickExecutePreferences({
            executorId: 'emp-1',
            network: 'etisalat',
            pin: '4321'
        });

        expect(employee.ussdNetwork).toBe('etisalat');
        expect(employee.ussdWalletPinEncrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i);
        expect(employee.ussdWalletPinEncrypted).not.toContain('4321');
        expect(employee.ussdWalletPinSetAt).toBeInstanceOf(Date);
        expect(state.pinSet).toBe(true);
        expect(JSON.stringify(state)).not.toContain('4321');
        expect(employee.save).toHaveBeenCalled();
    });

    test('builds an owned-task dial string with a stored PIN and redacts debug output', async () => {
        const pin = '2468';
        const employee = {
            _id: 'emp-1',
            ussdNetwork: 'orange',
            ussdWalletPinEncrypted: encrypt(pin),
            ussdWalletPinSetAt: new Date(),
            groupId: { manualQuickExecuteEnabled: true }
        };
        Employee.findById.mockReturnValue(chainEmployee(employee));
        findOwnedAcceptedExecutorTask.mockResolvedValue({
            _id: 'task-1',
            status: 'accepted',
            transferType: 'vodafone',
            amount: 180,
            vodafoneNumber: '01012345678',
            operatorId: 'emp-1'
        });

        const dial = await buildQuickExecuteDial({ executorId: 'emp-1', taskId: 'task-1' });
        expect(dial.ussd).toBe('*7115*7*01012345678*180*2468#');
        expect(dial.telUri).toBe('tel:*7115*7*01012345678*180*2468%23');
        expect(dial.pinIncluded).toBe(true);
        expect(dial.debug).not.toContain(pin);
        expect(dial.debug).toContain('[PIN]');
        expect(JSON.stringify(dial.debug)).not.toContain(pin);
    });

    test('rejects dial when quick execute is disabled or the task is not an owned cash wallet', async () => {
        Employee.findById.mockReturnValue(chainEmployee({
            _id: 'emp-1',
            ussdNetwork: 'vodafone',
            groupId: { manualQuickExecuteEnabled: false }
        }));
        await expect(buildQuickExecuteDial({ executorId: 'emp-1', taskId: 'task-1' }))
            .rejects.toMatchObject({ code: 'QUICK_EXECUTE_DISABLED', status: 403 });

        Employee.findById.mockReturnValue(chainEmployee({
            _id: 'emp-1',
            ussdNetwork: 'vodafone',
            groupId: { manualQuickExecuteEnabled: true }
        }));
        findOwnedAcceptedExecutorTask.mockResolvedValue(null);
        await expect(buildQuickExecuteDial({ executorId: 'emp-1', taskId: 'task-1' }))
            .rejects.toBeInstanceOf(QuickExecuteError);
    });
});
