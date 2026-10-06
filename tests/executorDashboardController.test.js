'use strict';

jest.mock('../models/Employee');
jest.mock('../utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../models/Transaction');
jest.mock('../models/ExecutorGroup');
jest.mock('../models/ClientCompany');
jest.mock('../models/Admin');
jest.mock('../models/User');
jest.mock('../models/ClientEmployee');
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(true) }));
jest.mock('../services/proofStorageService', () => ({
    proofSourceUrl: jest.fn((value) => `/proofs/${value}`),
    streamProofImage: jest.fn().mockResolvedValue(true)
}));
jest.mock('../services/executorTaskRoutingService', () => ({
    ...jest.requireActual('../services/executorTaskRoutingService'),
    findOwnedAcceptedExecutorTask: jest.fn()
}));
jest.mock('../utils/helpers', () => ({ escapeRegex: jest.fn((value) => value) }));
jest.mock('../services/executorAccountService', () => ({
    ExecutorAccountError: class ExecutorAccountError extends Error {},
    normalizeExecutorPhone: jest.fn((value) => value),
    normalizeExecutorUsername: jest.fn((value) => value)
}));
jest.mock('../services/mobileWebParityService', () => ({
    deleteEmployee: jest.fn(),
    getEmployeesWorkspace: jest.fn(),
    updateEmployeeExecutionPolicy: jest.fn()
}));
jest.mock('../services/executorDepositRequestService', () => ({
    ...jest.requireActual('../services/executorDepositRequestService'),
    listDepositRequests: jest.fn(), createDepositRequest: jest.fn(), reviewAdminDepositRequest: jest.fn()
}));
jest.mock('../services/executorQuickExecuteService', () => ({
    ...jest.requireActual('../services/executorQuickExecuteService'),
    getQuickExecuteState: jest.fn(), saveQuickExecutePreferences: jest.fn(), buildQuickExecuteDial: jest.fn()
}));
jest.mock('../services/executorBalancePoolService', () => ({
    ExecutorBalancePoolError: class ExecutorBalancePoolError extends Error {
        constructor(code, message, status = 400) {
            super(message);
            this.code = code;
            this.status = status;
        }
    },
    archivePool: jest.fn(),
    attachMembers: jest.fn(),
    createPool: jest.fn(),
    detachMember: jest.fn(),
    fundExternalExecutor: jest.fn(),
    listExternalBalanceWorkspace: jest.fn().mockResolvedValue({
        pools: [],
        solos: [],
        employees: [],
        balances: { privateBalance: 0, totalBalance: 0, allocatedBalance: 0 }
    }),
    renamePool: jest.fn(),
    snapshotCompanyBalances: jest.fn().mockResolvedValue({
        privateBalance: 0,
        totalBalance: 0,
        allocatedBalance: 0
    }),
    workingBalanceForEmployee: jest.fn().mockResolvedValue({ kind: 'solo', balance: 0, pool: null })
}));

const Transaction = require('../models/Transaction');
const Employee = require('../models/Employee');
const logger = require('../utils/logger');
const depositService = require('../services/executorDepositRequestService');
const quickExecuteService = require('../services/executorQuickExecuteService');
const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');
const mobileWebParityService = require('../services/mobileWebParityService');
const poolService = require('../services/executorBalancePoolService');
const { findOwnedAcceptedExecutorTask } = require('../services/executorTaskRoutingService');
const controller = require('../controllers/executorDashboardController');
const bcrypt = require('bcryptjs');

const response = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockReturnThis(),
    render: jest.fn().mockReturnThis()
});

describe('executor dashboard error containment', () => {
    beforeEach(() => jest.clearAllMocks());

    const request = () => ({
        params: { id: 'target-1' }, session: { executorId: 'manager-1' },
        body: { decision: 'approve', newPassword: 'new-password' },
        managerEmp: { _id: 'manager-1', groupId: { _id: 'group-1' } },
        executorEmployee: { _id: 'employee-1', groupId: { _id: 'group-1' } }
    });

    test.each([
        ['getDepositRequests', 'listDepositRequests'],
        ['postDepositRequest', 'createDepositRequest'],
        ['postReviewAdminDeposit', 'reviewAdminDepositRequest']
    ])('%s does not expose internal deposit errors', async (handler, operation) => {
        depositService[operation].mockRejectedValueOnce(new Error('mongodb://user:secret@internal-host'));
        const res = response();
        await controller[handler](request(), res);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret');
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    });

    test('preserves deposit validation errors and status', async () => {
        depositService.createDepositRequest.mockRejectedValueOnce(new depositService.ExecutorDepositRequestError('أرفق إيصال إيداع واحدًا على الأقل.', 400));
        const res = response();
        await controller.postDepositRequest(request(), res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: 'أرفق إيصال إيداع واحدًا على الأقل.' });
    });

    test.each([
        ['getQuickExecute', 'getQuickExecuteState'],
        ['putQuickExecute', 'saveQuickExecutePreferences'],
        ['postQuickExecuteDial', 'buildQuickExecuteDial']
    ])('%s does not expose a secret or internal error code', async (handler, operation) => {
        quickExecuteService[operation].mockRejectedValueOnce(Object.assign(new Error('pin=secret'), { code: 'INTERNAL_SECRET', status: 400 }));
        const res = response();
        await controller[handler](request(), res);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ success: false, code: 'QUICK_EXECUTE_FAILED', error: 'تعذر تنفيذ الطلب السريع.' });
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    });

    test.each(['postEmployeesToggle', 'postEmployeesToggleReports', 'postEmployeesResetPassword'])(
        '%s conceals an internal account error', async (handler) => {
            Employee.findById.mockRejectedValueOnce(new Error('mongodb://user:secret@internal-host'));
            const res = response();
            await controller[handler](request(), res);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
            expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret');
            expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
        }
    );

    test('employee-list faults do not expose connection details', async () => {
        mobileWebParityService.getEmployeesWorkspace.mockRejectedValueOnce(new Error('mongodb://user:secret@internal-host'));
        const res = response();
        await controller.getEmployeesList(request(), res);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret');
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    });
});

describe('executor self-service settings', () => {
    beforeEach(() => jest.clearAllMocks());

    test('rejects an incorrect current password without saving', async () => {
        const employee = { _id: 'employee-1', status: 'active', webPassword: await bcrypt.hash('original-password', 4), save: jest.fn() };
        Employee.findById.mockResolvedValue(employee);
        const res = response();
        await controller.postSettingsPassword({ session: { executorId: employee._id }, body: { currentPassword: 'incorrect', newPassword: 'new-password-123', confirmPassword: 'new-password-123' } }, res);
        expect(res.status).toHaveBeenCalledWith(422);
        expect(employee.save).not.toHaveBeenCalled();
    });

    test('rejects unmatched new passwords before loading the account', async () => {
        const res = response();
        await controller.postSettingsPassword({ session: { executorId: 'employee-1' }, body: { currentPassword: 'original-password', newPassword: 'new-password-123', confirmPassword: 'another-password' } }, res);
        expect(res.status).toHaveBeenCalledWith(422);
        expect(Employee.findById).not.toHaveBeenCalled();
    });

    test('saves a new password after verifying the old one', async () => {
        const employee = { _id: 'employee-1', name: 'موظف', status: 'active', webPassword: await bcrypt.hash('original-password', 4), save: jest.fn().mockResolvedValue(true) };
        Employee.findById.mockResolvedValue(employee);
        const res = response();
        await controller.postSettingsPassword({ session: { executorId: employee._id }, body: { currentPassword: 'original-password', newPassword: 'new-password-123', confirmPassword: 'new-password-123' } }, res);
        expect(employee.webPassword).not.toBe('new-password-123');
        expect(await bcrypt.compare('new-password-123', employee.webPassword)).toBe(true);
        expect(employee.save).toHaveBeenCalledTimes(1);
        expect(res.json).toHaveBeenCalledWith({ success: true });
    });
});

describe('executor active task page', () => {
    const taskId = '507f1f77bcf86cd799439011';
    const employee = { _id: 'employee-1', role: 'operator', groupId: { _id: 'group-1' } };

    beforeEach(() => jest.clearAllMocks());

    test('dashboard redirects to the authenticated executor accepted task', async () => {
        Transaction.findOne.mockResolvedValue({ _id: taskId });
        const res = response();
        await controller.getDashboard({ executorEmployee: employee, session: {}, tenant: { _id: 'tenant-1' } }, res);

        expect(Transaction.findOne).toHaveBeenCalledWith(expect.objectContaining({
            status: 'accepted',
            tenantId: 'tenant-1',
            operatorId: 'employee-1',
            $or: expect.arrayContaining([{ executorGroupId: 'group-1' }])
        }));
        expect(res.redirect).toHaveBeenCalledWith(`/executor-portal/active-task/${taskId}`);
        expect(res.render).not.toHaveBeenCalled();
    });

    test('dashboard shows the task list after completion or cancellation', async () => {
        Transaction.findOne.mockResolvedValue(null);
        const res = response();
        await controller.getDashboard({ executorEmployee: employee, session: {} }, res);

        expect(res.redirect).not.toHaveBeenCalled();
        expect(res.render).toHaveBeenCalledWith('executor/dashboard', expect.objectContaining({ activeTaskId: null }));
    });

    test('does not query a malformed task id', async () => {
        const res = response();
        await controller.getActiveTask({ params: { id: 'invalid' }, executorEmployee: employee }, res);
        expect(findOwnedAcceptedExecutorTask).not.toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalledWith('/executor-portal/dashboard');
    });

    test('does not render another employee task or a completed task', async () => {
        findOwnedAcceptedExecutorTask.mockResolvedValue(null);
        const res = response();
        await controller.getActiveTask({ params: { id: taskId }, executorEmployee: employee }, res);
        expect(res.redirect).toHaveBeenCalledWith('/executor-portal/dashboard');
        expect(res.render).not.toHaveBeenCalled();
    });

    test('renders only the authenticated employee accepted task', async () => {
        findOwnedAcceptedExecutorTask.mockResolvedValue({ _id: taskId });
        const req = {
            params: { id: taskId },
            executorEmployee: employee,
            tenant: { _id: 'tenant-1' },
            session: {}
        };
        const res = response();
        await controller.getActiveTask(req, res);
        expect(findOwnedAcceptedExecutorTask).toHaveBeenCalledWith({
            transactionId: taskId,
            executor: employee,
            tenantId: 'tenant-1'
        });
        expect(res.render).toHaveBeenCalledWith('executor/dashboard', expect.objectContaining({ activeTaskId: taskId }));
        expect(Transaction.findOne).not.toHaveBeenCalled();
    });
});

describe('Executor dashboard group ownership', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('archives an employee through the parity service', async () => {
        mobileWebParityService.deleteEmployee.mockResolvedValue(true);
        const req = {
            params: { id: 'employee-2' },
            managerEmp: { _id: 'manager-1', groupId: { _id: 'group-1', name: 'Executor group' } }
        };
        const res = response();

        await controller.postEmployeesDelete(req, res);

        expect(mobileWebParityService.deleteEmployee).toHaveBeenCalledWith({
            executorId: 'manager-1',
            targetId: 'employee-2'
        });
        expect(res.json).toHaveBeenCalledWith({ success: true, archived: true });
    });

    test('rejects archiving an employee from another executor group', async () => {
        mobileWebParityService.deleteEmployee.mockRejectedValue(new Error('FORBIDDEN'));
        const req = {
            params: { id: 'employee-2' },
            managerEmp: { _id: 'manager-1', groupId: { _id: 'group-1' } }
        };
        const res = response();

        await controller.postEmployeesDelete(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: 'تعذر أرشفة حساب الموظف.' });
    });

    test('returns sanitized employee DTOs without credential fields', async () => {
        mobileWebParityService.getEmployeesWorkspace.mockResolvedValue({
            employees: [{
                _id: 'employee-2',
                name: 'Operator',
                phone: '0940000000',
                role: 'operator',
                status: 'active',
                webUsername: 'operator@ahram.com',
                webPassword: '$2b$secret',
                refreshToken: 'private-token',
                metrics: {},
                presence: {}
            }],
            summary: { totalEmployees: 1 }
        });
        const req = { managerEmp: { _id: 'manager-1' } };
        const res = response();

        await controller.getEmployeesList(req, res);

        const payload = res.json.mock.calls[0][0];
        expect(payload.employees[0]).toEqual(expect.objectContaining({ id: 'employee-2', name: 'Operator' }));
        expect(payload.employees[0]).not.toHaveProperty('webPassword');
        expect(payload.employees[0]).not.toHaveProperty('refreshToken');
    });

    test('employees list includes shared-pool workspace fields for the manager UI', async () => {
        mobileWebParityService.getEmployeesWorkspace.mockResolvedValue({
            employees: [{
                _id: 'ahmed',
                name: 'أحمد',
                role: 'external',
                status: 'active',
                webUsername: 'ahmed@ahram.com',
                workingBalance: 900,
                balance: 0,
                soloBalance: 0,
                balanceMembership: 'pool',
                balancePool: { id: 'pool-nour', name: 'شركة النور', balance: 900 },
                metrics: {},
                presence: {}
            }],
            summary: { totalEmployees: 1 }
        });
        poolService.listExternalBalanceWorkspace.mockResolvedValue({
            pools: [{ id: 'pool-nour', name: 'شركة النور', balance: 900, members: [{ id: 'ahmed', name: 'أحمد' }] }],
            solos: [{ _id: 'mounir', name: 'منير', role: 'external', workingBalance: 400 }],
            employees: [],
            balances: { privateBalance: 2500, totalBalance: 3800, allocatedBalance: 1300 }
        });
        const req = { managerEmp: { _id: 'manager-1' } };
        const res = response();

        await controller.getEmployeesList(req, res);

        const payload = res.json.mock.calls[0][0];
        expect(payload.pools).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'pool-nour', name: 'شركة النور' })
        ]));
        expect(payload.soloExternals[0]).toEqual(expect.objectContaining({ name: 'منير' }));
        expect(payload.summary).toEqual(expect.objectContaining({
            privateBalance: 2500,
            totalBalance: 3800
        }));
        expect(payload.employees[0]).toEqual(expect.objectContaining({
            workingBalance: 900,
            balanceMembership: 'pool',
            balancePool: expect.objectContaining({ name: 'شركة النور' })
        }));
    });

    test('funding an external executor returns recipient-only receipt flags', async () => {
        poolService.fundExternalExecutor.mockResolvedValue({
            customId: 'EXT-1',
            companyPrivateBalance: 800,
            companyTotalBalance: 1700,
            employeeBalance: 900,
            workingBalance: 900,
            membership: 'pool',
            pool: { id: 'pool-nour', name: 'شركة النور' },
            recipientId: 'ahmed'
        });
        const req = {
            params: { id: 'ahmed' },
            body: { type: 'deposit', amount: 200, note: '' },
            managerEmp: { _id: 'manager-1', role: 'manager', groupId: 'group-1' }
        };
        const res = response();

        await controller.postExternalEmployeeTransaction(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            customId: 'EXT-1',
            companyPrivateBalance: 800,
            companyTotalBalance: 1700,
            membership: 'pool',
            recipientOnly: true,
            recipientId: 'ahmed'
        }));
    });

    test('creating an external executor can attach them to a named pool', async () => {
        Employee.exists.mockResolvedValue(null);
        Employee.create.mockResolvedValue({ _id: 'ahmed', name: 'أحمد' });
        poolService.attachMembers.mockResolvedValue({ pools: [] });
        const req = {
            body: {
                name: 'أحمد',
                phone: '01000000000',
                role: 'external',
                webUsername: 'ahmed',
                webPassword: 'secret12',
                balancePoolId: 'pool-nour'
            },
            managerEmp: { _id: 'manager-1', name: 'مدير', groupId: 'group-1' },
            session: { executorId: 'manager-1' }
        };
        const res = response();

        await controller.postEmployeesCreate(req, res);

        expect(poolService.attachMembers).toHaveBeenCalledWith({
            manager: req.managerEmp,
            poolId: 'pool-nour',
            memberIds: ['ahmed']
        });
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            employeeId: 'ahmed',
            poolAttachError: null
        }));
    });

    test('streams proof images for a transaction owned by a populated executor group', async () => {
        Transaction.findById.mockResolvedValue({
            executorGroupId: 'group-1',
            managerGroupId: null,
            proofImage: 'proof.png',
            proofImages: []
        });
        const req = {
            params: { id: 'tx-1', index: '0' },
            session: {},
            executorEmployee: { groupId: { _id: 'group-1', name: 'Executor group' } }
        };
        const res = response();

        await controller.getProxyImage(req, res);

        expect(proofSourceUrl).toHaveBeenCalledWith('proof.png');
        expect(streamProofImage).toHaveBeenCalledWith('/proofs/proof.png', res);
        expect(res.status).not.toHaveBeenCalledWith(403);
    });

    test('batches live-task housekeeping and keeps the completed list bounded', async () => {
        const task = {
            _id: 'task-1',
            status: 'processing',
            notifiedExecutors: false,
            autoAlertFired: false,
            executorReceivedAt: new Date(Date.now() - 130000),
            createdAt: new Date(Date.now() - 130000)
        };
        const chain = (result) => ({
            select: jest.fn().mockReturnThis(),
            sort: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue(result)
        });
        const completedQuery = chain([{ customId: 'ATT-1', amount: 100 }]);
        Transaction.find
            .mockReturnValueOnce(chain([task]))
            .mockReturnValueOnce(chain([]))
            .mockReturnValueOnce(completedQuery);
        Transaction.updateMany.mockResolvedValue({ modifiedCount: 1 });
        Transaction.aggregate.mockResolvedValue([{ count: 125, amount: 40000 }]);

        const req = {
            session: { executorId: 'employee-1' },
            executorEmployee: { _id: 'employee-1', role: 'operator', groupId: 'group-1' },
            query: {}
        };
        const res = response();

        await controller.getLiveTasks(req, res);

        expect(Transaction.updateMany).toHaveBeenCalledTimes(2);
        expect(completedQuery.limit).toHaveBeenCalledWith(60);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            completedToday: [{ customId: 'ATT-1', amount: 100 }],
            completedTodaySummary: { count: 125, amount: 40000 },
            pollIntervalSeconds: expect.any(Number)
        }));
    });

    test('lite live-tasks skips the completed list query', async () => {
        const chain = (result) => ({
            select: jest.fn().mockReturnThis(),
            sort: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue(result)
        });
        Transaction.find
            .mockReturnValueOnce(chain([]))
            .mockReturnValueOnce(chain([]));
        Transaction.aggregate.mockResolvedValue([{ count: 3, amount: 900 }]);

        const req = {
            session: { executorId: 'employee-1' },
            executorEmployee: { _id: 'employee-1', role: 'operator', groupId: 'group-1' },
            query: { lite: '1' }
        };
        const res = response();

        await controller.getLiveTasks(req, res);

        expect(Transaction.find).toHaveBeenCalledTimes(2);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            completedToday: [],
            completedTodaySummary: { count: 3, amount: 900 }
        }));
    });

    test('refuses manager saves of per-executor execution policy overrides', async () => {
        const req = {
            params: { id: 'employee-2' },
            managerEmp: { _id: 'manager-1', role: 'manager', groupId: 'group-1' },
            body: { proofRequired: true }
        };
        const res = response();
        await controller.postEmployeeExecutionPolicy(req, res);
        expect(mobileWebParityService.updateEmployeeExecutionPolicy).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            code: 'ADMIN_ONLY'
        }));
    });
});
