'use strict';

jest.mock('../models/Employee', () => ({ findById: jest.fn() }));
jest.mock('../models/ExecutorGroup', () => ({ findById: jest.fn() }));
jest.mock('../models/Transaction', () => ({ find: jest.fn() }));

const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const { getExecutorReports } = require('../services/mobileWebParityService');
const { toClientReportDto } = require('../mappers/mobileWebParityMapper');

const leanResult = (value) => ({ lean: jest.fn().mockResolvedValue(value) });

const expectGroupAndDateFilters = (query) => {
    expect(query.$and).toEqual(expect.arrayContaining([
        expect.objectContaining({
            $or: expect.arrayContaining([
                { executorGroupId: 'group-1' },
                { managerGroupId: 'group-1' }
            ])
        }),
        expect.objectContaining({
            $or: expect.arrayContaining([
                expect.objectContaining({ createdAt: expect.any(Object) })
            ])
        })
    ]));
};

describe('executor employee reports', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Employee.findById.mockResolvedValue({
            _id: 'employee-1',
            groupId: 'group-1',
            role: 'operator',
            name: 'موظف الاختبار',
            phone: '0910000000',
            webUsername: 'operator@ahram.com',
            createdAt: new Date('2026-08-01T00:00:00.000Z')
        });
        ExecutorGroup.findById.mockReturnValue(leanResult({
            _id: 'group-1',
            name: 'شركة التنفيذ',
            balance: 99999
        }));
        Transaction.find.mockImplementation(() => ({
            sort: jest.fn().mockReturnValue(leanResult([
                {
                    _id: 'completed-1',
                    customId: 'ATT-1',
                    status: 'completed',
                    amount: 125,
                    vodafoneNumber: '01000000000',
                    operatorId: 'employee-1',
                    createdAt: new Date('2026-08-14T10:00:00.000Z')
                },
                {
                    _id: 'cancelled-1',
                    customId: 'ATT-2',
                    status: 'rejected',
                    amount: 75,
                    vodafoneNumber: '01111111111',
                    operatorId: 'employee-1',
                    createdAt: new Date('2026-08-14T11:00:00.000Z')
                }
            ]))
        }));
    });

    test('limits an operator to their own records and keeps cancelled work separate', async () => {
        const report = await getExecutorReports({
            executorId: 'employee-1',
            dateType: 'day',
            dateValue: '2026-08-14'
        });

        expect(Transaction.find).toHaveBeenCalledWith(expect.objectContaining({
            $and: expect.arrayContaining([
                expect.objectContaining({ operatorId: 'employee-1' })
            ])
        }));
        expect(report.scope).toBe('employee');
        expect(report.company).toBeUndefined();
        expect(report.currentBalance).toBeUndefined();
        expect(report.operationCount).toBe(1);
        expect(report.totalEGP).toBe(125);
        expect(report.operations.map((item) => item.customId)).toEqual(['ATT-1']);
        expect(report.cancelledOperations.map((item) => item.customId)).toEqual(['ATT-2']);
    });

    test('does not expose company fields or executor names in the mobile DTO', async () => {
        const report = await getExecutorReports({
            executorId: 'employee-1',
            dateType: 'month',
            dateValue: '2026-08'
        });
        const dto = toClientReportDto(report);

        expect(dto.scope).toBe('employee');
        expect(dto.company).toBeNull();
        expect(dto.companyBalance).toBeNull();
        expect(dto.myPerformance).toBeNull();
        expect(dto.operations[0].executorName).toBeNull();
        expect(dto.cancelledOperations[0].executorName).toBeNull();
    });

    test('includes legacy execution rows in the configured single-tenant report scope', async () => {
        const previousTenantMode = process.env.TENANT_MODE;
        process.env.TENANT_MODE = 'single';
        try {
            await getExecutorReports({
                executorId: 'employee-1',
                dateType: 'day',
                dateValue: '2026-08-14',
                tenantId: 'tenant-1'
            });
        } finally {
            if (previousTenantMode === undefined) delete process.env.TENANT_MODE;
            else process.env.TENANT_MODE = previousTenantMode;
        }

        expect(Transaction.find).toHaveBeenCalledWith(expect.objectContaining({
            $and: expect.arrayContaining([
                expect.objectContaining({
                    tenantId: { $in: ['tenant-1', null] },
                    operatorId: 'employee-1'
                })
            ])
        }));
    });

    test('wraps ObjectId-like tenant ids in single-tenant legacy scope', async () => {
        const tenantObjectId = { toString: () => 'tenant-1' };
        const previousTenantMode = process.env.TENANT_MODE;
        process.env.TENANT_MODE = 'single';
        try {
            await getExecutorReports({
                executorId: 'employee-1',
                dateType: 'day',
                dateValue: '2026-08-14',
                tenantId: tenantObjectId
            });
        } finally {
            if (previousTenantMode === undefined) delete process.env.TENANT_MODE;
            else process.env.TENANT_MODE = previousTenantMode;
        }

        expect(Transaction.find).toHaveBeenCalledWith(expect.objectContaining({
            $and: expect.arrayContaining([
                expect.objectContaining({
                    tenantId: { $in: [tenantObjectId, null] },
                    operatorId: 'employee-1'
                })
            ])
        }));
    });

    test('builds manager team performance and a balanced financial summary', async () => {
        Employee.findById.mockResolvedValue({
            _id: 'manager-1',
            groupId: 'group-1',
            role: 'manager',
            name: 'مدير التنفيذ',
            phone: '0940000000',
            webUsername: 'manager@ahram.com'
        });
        ExecutorGroup.findById.mockReturnValue(leanResult({
            _id: 'group-1',
            name: 'شركة التنفيذ',
            balance: 900
        }));
        Transaction.find.mockImplementation(() => ({
            sort: jest.fn().mockReturnValue(leanResult([
                {
                    _id: 'completed-1', customId: 'ATT-10', status: 'completed', amount: 100,
                    operatorId: 'operator-1', executorName: 'أحمد',
                    executorReceivedAt: new Date('2026-08-14T10:00:00.000Z'),
                    completedAt: new Date('2026-08-14T10:02:00.000Z'),
                    createdAt: new Date('2026-08-14T10:00:00.000Z')
                },
                {
                    _id: 'deposit-1', customId: 'DEP-1', status: 'deposit', amount: 300,
                    createdAt: new Date('2026-08-14T09:00:00.000Z')
                },
                {
                    _id: 'deduction-1', customId: 'DED-1', status: 'deduction', amount: 50,
                    createdAt: new Date('2026-08-14T09:30:00.000Z')
                },
                {
                    _id: 'accepted-1', customId: 'ATT-11', status: 'accepted', amount: 75,
                    operatorId: 'operator-1', executorName: 'أحمد',
                    createdAt: new Date('2026-08-14T11:00:00.000Z')
                }
            ]))
        }));

        const report = await getExecutorReports({
            executorId: 'manager-1',
            dateType: 'range',
            dateFrom: '2026-08-01',
            dateTo: '2026-08-14'
        });

        expect(report.scope).toBe('group');
        expect(report.reportPeriod.type).toBe('range');
        const reportQuery = Transaction.find.mock.calls[0][0];
        expectGroupAndDateFilters(reportQuery);
        expect(reportQuery.$and).toEqual(expect.arrayContaining([
            expect.objectContaining({
                $or: expect.arrayContaining([
                    expect.objectContaining({
                        updatedAt: {
                            $gte: expect.any(Date),
                            $lte: expect.any(Date)
                        }
                    })
                ])
            })
        ]));
        const dateClause = reportQuery.$and.find((clause) => clause.$or?.some((entry) => entry.createdAt));
        expect(dateClause.$or[0].createdAt.$gte.toISOString()).toBe('2026-07-31T22:00:00.000Z');
        expect(dateClause.$or[0].createdAt.$lte.toISOString()).toBe('2026-08-14T21:59:59.999Z');
        expect(reportQuery.operatorId).toBeUndefined();
        expect(report.summary.pendingCount).toBe(1);
        expect(report.summary.averageDurationSeconds).toBe(120);
        expect(report.financialSummary).toEqual(expect.objectContaining({
            openingBalance: 750,
            additions: 300,
            deductions: 50,
            executedAmount: 100,
            netMovement: 150,
            closingBalance: 900
        }));
        expect(report.teamPerformance).toEqual([
            expect.objectContaining({
                employeeId: 'operator-1',
                employeeName: 'أحمد',
                completedCount: 1,
                totalEGP: 100
            })
        ]);
    });

    test('allows accountants to reconcile the group without exposing team ranking', async () => {
        Employee.findById.mockResolvedValue({
            _id: 'accountant-1',
            groupId: 'group-1',
            role: 'accountant',
            name: 'محاسب التنفيذ',
            phone: '0920000000',
            webUsername: 'accountant@ahram.com'
        });

        const dto = toClientReportDto(await getExecutorReports({
            executorId: 'accountant-1',
            dateType: 'day',
            dateValue: '2026-08-14'
        }));

        const reportQuery = Transaction.find.mock.calls[0][0];
        expectGroupAndDateFilters(reportQuery);
        expect(reportQuery.operatorId).toBeUndefined();
        expect(dto.scope).toBe('group');
        expect(dto.capabilities.canViewReconciliation).toBe(true);
        expect(dto.capabilities.canViewTeamPerformance).toBe(false);
        expect(dto.teamPerformance).toEqual([]);
        expect(dto.financialSummary).not.toBeNull();
    });

    test('limits external employees to their own operations and deposits', async () => {
        Employee.findById.mockResolvedValue({
            _id: 'external-1',
            groupId: 'group-1',
            role: 'external',
            name: 'موظف خارجي',
            phone: '0930000000',
            webUsername: 'external@ahram.com',
            balance: 250,
            createdAt: new Date('2026-08-01T00:00:00.000Z')
        });
        Transaction.find.mockImplementation(() => ({
            sort: jest.fn().mockReturnValue(leanResult([
                {
                    _id: 'completed-ext',
                    customId: 'ATT-EXT-1',
                    status: 'completed',
                    amount: 90,
                    operatorId: 'external-1',
                    createdAt: new Date('2026-08-14T10:00:00.000Z')
                },
                {
                    _id: 'deposit-ext',
                    customId: 'DEP-EXT-1',
                    status: 'deposit',
                    amount: 120,
                    operatorId: 'external-1',
                    createdAt: new Date('2026-08-14T09:00:00.000Z')
                }
            ]))
        }));

        const report = await getExecutorReports({
            executorId: 'external-1',
            dateType: 'day',
            dateValue: '2026-08-14'
        });
        const dto = toClientReportDto(report);

        expect(Transaction.find).toHaveBeenCalledWith(expect.objectContaining({
            $and: expect.arrayContaining([
                expect.objectContaining({ operatorId: 'external-1' })
            ])
        }));
        expect(report.scope).toBe('employee');
        expect(report.deposits).toHaveLength(1);
        expect(report.deposits[0].customId).toBe('DEP-EXT-1');
        expect(dto.financialSummary).toEqual(expect.objectContaining({
            additions: 120,
            closingBalance: 250
        }));
    });

    test('rejects attempts by an operator to request another employee report', async () => {
        await expect(getExecutorReports({
            executorId: 'employee-1',
            employeeId: 'employee-2',
            dateType: 'day',
            dateValue: '2026-08-14'
        })).rejects.toThrow('FORBIDDEN');
        expect(Transaction.find).not.toHaveBeenCalled();
    });

    test('includes tasks completed today even when created on an earlier day', async () => {
        Transaction.find.mockImplementation(() => ({
            sort: jest.fn().mockReturnValue(leanResult([
                {
                    _id: 'completed-today',
                    customId: 'ATT-TODAY',
                    status: 'completed',
                    amount: 200,
                    operatorId: 'employee-1',
                    createdAt: new Date('2026-08-22T10:00:00.000Z'),
                    completedAt: new Date('2026-08-25T10:00:00.000Z'),
                    updatedAt: new Date('2026-08-25T10:00:00.000Z')
                }
            ]))
        }));

        const report = await getExecutorReports({
            executorId: 'employee-1',
            dateType: 'day',
            dateValue: '2026-08-25'
        });

        const reportQuery = Transaction.find.mock.calls[0][0];
        expectGroupAndDateFilters(reportQuery);
        expect(report.operations.map((item) => item.customId)).toEqual(['ATT-TODAY']);
    });

    test('includes tasks completed yesterday even when created earlier', async () => {
        Transaction.find.mockImplementation(() => ({
            sort: jest.fn().mockReturnValue(leanResult([
                {
                    _id: 'completed-yesterday',
                    customId: 'ATT-YDAY',
                    status: 'completed',
                    amount: 150,
                    operatorId: 'employee-1',
                    createdAt: new Date('2026-08-20T08:00:00.000Z'),
                    completedAt: new Date('2026-08-24T12:00:00.000Z'),
                    updatedAt: new Date('2026-08-24T12:00:00.000Z')
                }
            ]))
        }));

        const report = await getExecutorReports({
            executorId: 'employee-1',
            dateType: 'day',
            dateValue: '2026-08-24'
        });

        expect(report.operations.map((item) => item.customId)).toEqual(['ATT-YDAY']);
    });

    test('rejects report ranges longer than one year', async () => {
        await expect(getExecutorReports({
            executorId: 'employee-1',
            dateType: 'range',
            dateFrom: '2025-01-01',
            dateTo: '2026-08-14'
        })).rejects.toThrow('INVALID_PERIOD');
    });
});
