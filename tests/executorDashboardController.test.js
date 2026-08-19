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
    getEmployeesWorkspace: jest.fn()
}));

const Transaction = require('../models/Transaction');
const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');
const mobileWebParityService = require('../services/mobileWebParityService');
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
        const taskQuery = { lean: jest.fn().mockResolvedValue([task]) };
        const alertsQuery = { lean: jest.fn().mockResolvedValue([]) };
        const depositAlertsQuery = { lean: jest.fn().mockResolvedValue([]) };
        const completedQuery = {
            sort: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue([{ customId: 'ATT-1', amount: 100 }])
        };
        Transaction.find
            .mockReturnValueOnce(taskQuery)
            .mockReturnValueOnce(alertsQuery)
            .mockReturnValueOnce(depositAlertsQuery)
            .mockReturnValueOnce(completedQuery);
        Transaction.updateMany.mockResolvedValue({ modifiedCount: 1 });
        Transaction.aggregate.mockResolvedValue([{ count: 125, amount: 40000 }]);

        const req = {
            session: { executorId: 'employee-1' },
            executorEmployee: { _id: 'employee-1', role: 'operator', groupId: 'group-1' }
        };
        const res = response();

        await controller.getLiveTasks(req, res);

        expect(Transaction.updateMany).toHaveBeenCalledTimes(2);
        expect(completedQuery.limit).toHaveBeenCalledWith(60);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            completedToday: [{ customId: 'ATT-1', amount: 100 }],
            completedTodaySummary: { count: 125, amount: 40000 }
        }));
    });
});
