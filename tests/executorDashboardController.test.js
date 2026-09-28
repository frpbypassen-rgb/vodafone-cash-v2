'use strict';

jest.mock('../models/Employee');
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
const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');
const mobileWebParityService = require('../services/mobileWebParityService');
const poolService = require('../services/executorBalancePoolService');
const controller = require('../controllers/executorDashboardController');

const response = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis()
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
                webPassword: 'secret1',
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
