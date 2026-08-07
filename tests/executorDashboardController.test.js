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

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');
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

    test('deletes an employee when the manager group is populated', async () => {
        const employee = { _id: 'employee-2', role: 'operator', groupId: 'group-1' };
        Employee.findById.mockResolvedValue(employee);
        Employee.findByIdAndDelete.mockResolvedValue(employee);
        const req = {
            params: { id: 'employee-2' },
            managerEmp: { groupId: { _id: 'group-1', name: 'Executor group' } }
        };
        const res = response();

        await controller.postEmployeesDelete(req, res);

        expect(Employee.findByIdAndDelete).toHaveBeenCalledWith('employee-2');
        expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    test('rejects deleting an employee from another executor group', async () => {
        Employee.findById.mockResolvedValue({ _id: 'employee-2', role: 'operator', groupId: 'group-2' });
        const req = {
            params: { id: 'employee-2' },
            managerEmp: { groupId: { _id: 'group-1' } }
        };
        const res = response();

        await controller.postEmployeesDelete(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(Employee.findByIdAndDelete).not.toHaveBeenCalled();
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
