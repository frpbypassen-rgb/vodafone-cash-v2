'use strict';

jest.mock('../models/Employee', () => ({
    findById: jest.fn()
}));

const Employee = require('../models/Employee');
const {
    DEFAULT_TTL_MS,
    cacheTtlMs,
    clearExecutorAuthCache,
    loadExecutorEmployee
} = require('../services/executorAuthCache');

describe('executor auth cache', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearExecutorAuthCache();
    });

    test('reuses a lean employee lookup within the TTL', async () => {
        const employee = {
            _id: 'employee-1',
            status: 'active',
            role: 'operator',
            groupId: { _id: 'group-1', status: 'active' }
        };
        const query = {
            select: jest.fn().mockReturnThis(),
            populate: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue(employee)
        };
        Employee.findById.mockReturnValue(query);

        const first = await loadExecutorEmployee('employee-1');
        const second = await loadExecutorEmployee('employee-1');

        expect(first).toBe(employee);
        expect(second).toBe(employee);
        expect(Employee.findById).toHaveBeenCalledTimes(1);
        expect(query.lean).toHaveBeenCalledTimes(1);
    });

    test('mutations can bypass the cache', async () => {
        const query = {
            select: jest.fn().mockReturnThis(),
            populate: jest.fn().mockReturnThis(),
            lean: jest.fn()
                .mockResolvedValueOnce({ _id: 'employee-1', status: 'active' })
                .mockResolvedValueOnce({ _id: 'employee-1', status: 'suspended' })
        };
        Employee.findById.mockReturnValue(query);

        await loadExecutorEmployee('employee-1');
        const fresh = await loadExecutorEmployee('employee-1', { fresh: true });

        expect(Employee.findById).toHaveBeenCalledTimes(2);
        expect(fresh.status).toBe('suspended');
    });

    test('rejects unsafe TTL overrides', () => {
        expect(cacheTtlMs({})).toBe(DEFAULT_TTL_MS);
        expect(cacheTtlMs({ EXECUTOR_AUTH_CACHE_MS: '500' })).toBe(DEFAULT_TTL_MS);
        expect(cacheTtlMs({ EXECUTOR_AUTH_CACHE_MS: '20000' })).toBe(20000);
    });
});
