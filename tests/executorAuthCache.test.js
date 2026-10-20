'use strict';

jest.mock('../models/Employee', () => ({
    findById: jest.fn()
}));

const Employee = require('../models/Employee');
const {
    DEFAULT_TTL_MS,
    MAX_CACHE_ENTRIES,
    cacheTtlMs,
    clearExecutorAuthCache,
    clearExecutorPortalSession,
    loadExecutorEmployee,
    getCachedExecutor,
    setCachedExecutor
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

    test('evicts the oldest entry when the cache reaches its bound', () => {
        for (let index = 0; index < MAX_CACHE_ENTRIES; index += 1) {
            setCachedExecutor(`employee-${index}`, { index }, { now: 1000, ttlMs: 100000 });
        }
        setCachedExecutor('new-employee', { index: MAX_CACHE_ENTRIES }, { now: 1000, ttlMs: 100000 });
        expect(getCachedExecutor('employee-0', 1000)).toBeNull();
        expect(getCachedExecutor('new-employee', 1000)).toEqual({ index: MAX_CACHE_ENTRIES });
    });

    test('clears the same portal session keys for auth and manager revocation', () => {
        const session = {
            isExecutorLoggedIn: true,
            executorId: 'employee-1',
            executorGroupId: 'group-1',
            executorSessionVersion: 4,
            unrelated: 'keep'
        };
        clearExecutorPortalSession(session);
        expect(session).toEqual({ unrelated: 'keep' });
        clearExecutorPortalSession(null);
        const route = require('fs').readFileSync(require('path').join(__dirname, '../routes/executorPortal.js'), 'utf8');
        expect(route.match(/clearExecutorPortalSession\(req\.session\)/g)).toHaveLength(2);
    });
});
