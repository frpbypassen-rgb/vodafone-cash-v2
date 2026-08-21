'use strict';

jest.mock('../models/Employee', () => ({
    findById: jest.fn(),
    find: jest.fn()
}));

jest.mock('../models/Transaction', () => ({
    find: jest.fn()
}));

jest.mock('../models/MobilePushDevice', () => ({
    find: jest.fn(),
    updateMany: jest.fn()
}));

const mockLogAction = jest.fn();
jest.mock('../services/auditService', () => ({
    logAction: (...args) => mockLogAction(...args)
}));

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const MobilePushDevice = require('../models/MobilePushDevice');
const {
    getEmployeesWorkspace,
    deleteEmployee
} = require('../services/mobileWebParityService');

const sortedLean = (value) => ({
    sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(value)
    })
});

describe('executor employee workspace', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockLogAction.mockResolvedValue(undefined);
    });

    test('returns server-scoped presence, current task, and daily performance', async () => {
        const now = new Date();
        Employee.findById.mockResolvedValue({
            _id: 'manager-1',
            name: 'Manager',
            role: 'manager',
            groupId: 'group-1',
            tenantId: null
        });
        Employee.find.mockReturnValue(sortedLean([
            {
                _id: 'manager-1',
                name: 'Manager',
                role: 'manager',
                status: 'active',
                groupId: 'group-1'
            },
            {
                _id: 'operator-1',
                name: 'Operator',
                role: 'operator',
                status: 'active',
                groupId: 'group-1'
            }
        ]));

        const completed = {
            _id: 'tx-completed',
            customId: 'ATT-2608-1001',
            operatorId: 'operator-1',
            executorName: 'Operator',
            status: 'completed',
            amount: 1000,
            executorReceivedAt: new Date(now.getTime() - 180000),
            completedAt: new Date(now.getTime() - 60000),
            createdAt: now
        };
        const cancelled = {
            _id: 'tx-cancelled',
            customId: 'ATT-2608-1002',
            operatorId: 'operator-1',
            status: 'rejected',
            amount: 500,
            createdAt: now
        };
        const accepted = {
            _id: 'tx-current',
            customId: 'ATT-2608-1003',
            operatorId: 'operator-1',
            status: 'accepted',
            transferType: 'vodafone',
            vodafoneNumber: '01108172258',
            amount: 250,
            executorReceivedAt: new Date(now.getTime() - 30000),
            createdAt: now
        };
        Transaction.find.mockImplementation((query) => (
            query.status === 'accepted'
                ? sortedLean([accepted])
                : sortedLean([completed, cancelled, accepted])
        ));
        MobilePushDevice.find.mockReturnValue({
            lean: jest.fn().mockResolvedValue([
                {
                    accountId: 'operator-1',
                    enabled: true,
                    permissionStatus: 'authorized',
                    deviceName: 'Android test device',
                    lastSeenAt: new Date(now.getTime() - 60000),
                    lastSuccessfulPushAt: now
                }
            ])
        });

        const workspace = await getEmployeesWorkspace({
            executorId: 'manager-1',
            tenantId: null
        });

        expect(workspace.summary).toMatchObject({
            totalEmployees: 2,
            onlineEmployees: 1,
            busyEmployees: 1,
            completedCount: 1,
            cancelledCount: 1,
            totalEGP: 1000,
            averageDurationSeconds: 120
        });
        const operator = workspace.employees.find((item) => String(item._id) === 'operator-1');
        expect(operator.presence).toMatchObject({
            isOnline: true,
            pushReady: true,
            deviceName: 'Android test device'
        });
        expect(operator.metrics).toMatchObject({
            completedCount: 1,
            cancelledCount: 1,
            totalEGP: 1000,
            averageDurationSeconds: 120,
            successRate: 50
        });
        expect(operator.currentTask).toMatchObject({
            customId: 'ATT-2608-1003',
            recipient: '01108172258',
            amount: 250
        });
    });

    test('keeps legacy employees in the configured single-tenant workspace', async () => {
        const previousTenantMode = process.env.TENANT_MODE;
        process.env.TENANT_MODE = 'single';
        Employee.findById.mockResolvedValue({
            _id: 'manager-1',
            name: 'Manager',
            role: 'manager',
            groupId: 'group-1',
            tenantId: 'tenant-1'
        });
        Employee.find.mockReturnValue(sortedLean([]));
        Transaction.find.mockReturnValue(sortedLean([]));
        MobilePushDevice.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });

        await getEmployeesWorkspace({
            executorId: 'manager-1',
            tenantId: { $in: ['tenant-1', null] }
        });

        expect(Employee.find).toHaveBeenCalledWith(expect.objectContaining({
            groupId: 'group-1',
            tenantId: { $in: ['tenant-1', null] }
        }));
        expect(Transaction.find).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: { $in: ['tenant-1', null] }
        }));
        process.env.TENANT_MODE = previousTenantMode;
    });

    test('archives an employee and disables push devices without deleting history', async () => {
        const manager = {
            _id: 'manager-1',
            name: 'Manager',
            role: 'manager',
            groupId: 'group-1'
        };
        const employee = {
            _id: 'operator-1',
            name: 'Operator',
            role: 'operator',
            status: 'active',
            groupId: 'group-1',
            webUsername: 'operator@ahram.com',
            refreshToken: 'refresh-token',
            save: jest.fn().mockResolvedValue(undefined)
        };
        Employee.findById.mockImplementation((id) => Promise.resolve(
            id === 'manager-1' ? manager : employee
        ));
        MobilePushDevice.updateMany.mockResolvedValue({ modifiedCount: 1 });

        await deleteEmployee({ executorId: 'manager-1', targetId: 'operator-1' });

        expect(employee.status).toBe('suspended');
        expect(employee.archivedAt).toBeInstanceOf(Date);
        expect(employee.archivedBy).toBe('manager-1');
        expect(employee.refreshToken).toBeUndefined();
        expect(employee.save).toHaveBeenCalledTimes(1);
        expect(MobilePushDevice.updateMany).toHaveBeenCalledWith(
            { accountType: 'executor', accountId: 'operator-1' },
            { $set: { enabled: false } }
        );
        expect(mockLogAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'USER_ARCHIVED',
            targetId: 'operator-1'
        }));
    });
});
