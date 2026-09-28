'use strict';

jest.mock('../models/Employee');
jest.mock('../models/Transaction', () => ({
    findById: jest.fn()
}));
jest.mock('../services/executorTaskRoutingService', () => ({
    findOwnedAcceptedExecutorTask: jest.fn(),
    acceptExecutorTask: jest.fn(),
    routingErrorMessage: jest.fn((code) => `routing:${code}`)
}));
jest.mock('../services/executorAuthCache', () => ({
    invalidateExecutorAuth: jest.fn()
}));

process.env.JWT_SECRET = 'test-secret-key-for-encryption-32chars-long-enough';

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const { encrypt } = require('../utils/encryption');
const {
    findOwnedAcceptedExecutorTask,
    acceptExecutorTask
} = require('../services/executorTaskRoutingService');
const {
    TASK_NOT_ACCEPTED_AR,
    TASK_NOT_CLAIMABLE_AR,
    buildQuickExecuteDial,
    normalizeDialTenantScope,
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
        Transaction.findById.mockResolvedValue(null);
        acceptExecutorTask.mockResolvedValue({ ok: false, code: 'TASK_UNAVAILABLE' });
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
        expect(dial.telUri).toBe('tel:%2A7115%2A7%2A01012345678%2A180%2A2468%23');
        expect(dial.pinIncluded).toBe(true);
        expect(dial.acceptedNow).toBe(false);
        expect(dial.debug).not.toContain(pin);
        expect(dial.debug).toContain('[PIN]');
        expect(JSON.stringify(dial.debug)).not.toContain(pin);
    });

    test('rejects dial when quick execute is disabled', async () => {
        Employee.findById.mockReturnValue(chainEmployee({
            _id: 'emp-1',
            ussdNetwork: 'vodafone',
            groupId: { manualQuickExecuteEnabled: false }
        }));
        await expect(buildQuickExecuteDial({ executorId: 'emp-1', taskId: 'task-1' }))
            .rejects.toMatchObject({ code: 'QUICK_EXECUTE_DISABLED', status: 403 });
        expect(findOwnedAcceptedExecutorTask).not.toHaveBeenCalled();
    });

    test('rejects dial when the cash-wallet task is not yet accepted', async () => {
        Employee.findById.mockReturnValue(chainEmployee({
            _id: 'emp-1',
            ussdNetwork: 'vodafone',
            groupId: { manualQuickExecuteEnabled: true }
        }));
        findOwnedAcceptedExecutorTask.mockResolvedValue(null);
        Transaction.findById.mockResolvedValue({
            _id: 'task-1',
            status: 'processing',
            transferType: 'vodafone',
            amount: 80,
            vodafoneNumber: '01012345678',
            assignedExecutorId: null
        });

        await expect(buildQuickExecuteDial({ executorId: 'emp-1', taskId: 'task-1' }))
            .rejects.toMatchObject({
                name: 'QuickExecuteError',
                code: 'TASK_NOT_ACCEPTED',
                status: 403
            });
        await expect(buildQuickExecuteDial({ executorId: 'emp-1', taskId: 'task-1' }))
            .rejects.toHaveProperty('message', TASK_NOT_ACCEPTED_AR);
        expect(TASK_NOT_ACCEPTED_AR).toContain('اسحب/اقبل المهمة أولًا');
        expect(acceptExecutorTask).not.toHaveBeenCalled();
    });

    test('dials after accept when the finder returns the owned accepted task', async () => {
        Employee.findById.mockReturnValue(chainEmployee({
            _id: 'emp-1',
            ussdNetwork: 'vodafone',
            groupId: { manualQuickExecuteEnabled: true }
        }));
        findOwnedAcceptedExecutorTask.mockResolvedValue({
            _id: 'task-1',
            status: 'accepted',
            transferType: 'vodafone',
            amount: 90,
            vodafoneNumber: '01108172258',
            operatorId: 'emp-1'
        });

        const dial = await buildQuickExecuteDial({ executorId: 'emp-1', taskId: 'task-1' });
        expect(dial.ussd).toBe('*9*7*01108172258*90#');
        expect(dial.telUri).toBe('tel:%2A9%2A7%2A01108172258%2A90%23');
        expect(acceptExecutorTask).not.toHaveBeenCalled();
    });

    test('auto-accepts an assigned-to-me cash wallet then returns the dial URI', async () => {
        Employee.findById.mockReturnValue(chainEmployee({
            _id: 'emp-1',
            ussdNetwork: 'vodafone',
            groupId: { manualQuickExecuteEnabled: true }
        }));
        findOwnedAcceptedExecutorTask.mockResolvedValue(null);
        Transaction.findById.mockResolvedValue({
            _id: 'task-1',
            status: 'processing',
            transferType: 'vodafone',
            amount: 140,
            vodafoneNumber: '01099998888',
            assignedExecutorId: 'emp-1'
        });
        acceptExecutorTask.mockResolvedValue({
            ok: true,
            transaction: {
                _id: 'task-1',
                status: 'accepted',
                transferType: 'vodafone',
                amount: 140,
                vodafoneNumber: '01099998888',
                operatorId: 'emp-1'
            }
        });

        const dial = await buildQuickExecuteDial({ executorId: 'emp-1', taskId: 'task-1' });
        expect(acceptExecutorTask).toHaveBeenCalledWith(expect.objectContaining({
            transactionId: 'task-1',
            executor: expect.objectContaining({ _id: 'emp-1' })
        }));
        expect(dial.ussd).toBe('*9*7*01099998888*140#');
        expect(dial.telUri).toBe('tel:%2A9%2A7%2A01099998888%2A140%23');
        expect(dial.acceptedNow).toBe(true);
    });

    test('uses a tenant-lenient fallback when an owned accepted task missed the strict finder', async () => {
        Employee.findById.mockReturnValue(chainEmployee({
            _id: 'emp-1',
            ussdNetwork: 'vodafone',
            webUsername: 'trial.user',
            groupId: { manualQuickExecuteEnabled: true }
        }));
        findOwnedAcceptedExecutorTask.mockResolvedValue(null);
        Transaction.findById.mockResolvedValue({
            _id: 'task-1',
            status: 'accepted',
            transferType: 'vodafone',
            amount: 75,
            vodafoneNumber: '01108172258',
            operatorId: 'emp-1',
            tenantId: null
        });

        const dial = await buildQuickExecuteDial({
            executorId: 'emp-1',
            taskId: 'task-1',
            tenantId: 'tenant-1'
        });
        expect(dial.ussd).toBe('*9*7*01108172258*75#');
        expect(dial.acceptedNow).toBe(false);
        expect(acceptExecutorTask).not.toHaveBeenCalled();
        expect(TASK_NOT_CLAIMABLE_AR).toContain('اسحب/اقبل المهمة أولًا');
    });

    test('normalizes single-tenant dial scope so legacy null tenant rows still match', () => {
        const previous = process.env.TENANT_MODE;
        process.env.TENANT_MODE = 'single';
        try {
            expect(normalizeDialTenantScope('tenant-1')).toEqual({ $in: ['tenant-1', null] });
            expect(normalizeDialTenantScope({ $in: ['tenant-1', null] })).toEqual({ $in: ['tenant-1', null] });
        } finally {
            if (previous === undefined) delete process.env.TENANT_MODE;
            else process.env.TENANT_MODE = previous;
        }
    });
});
