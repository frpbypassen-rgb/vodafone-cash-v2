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
            operatorId: 'employee-1'
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
});
