'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(32);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'r'.repeat(32);

jest.mock('../models/Employee', () => ({
    findById: jest.fn()
}));

const Employee = require('../models/Employee');
const { ensureActiveExecutor, tokenMatchesRequestTenant } = require('../middlewares/jwtAuth');

const employeeQuery = (result) => {
    const query = {
        select: jest.fn(),
        populate: jest.fn().mockResolvedValue(result)
    };
    query.select.mockReturnValue(query);
    return query;
};

describe('JWT executor status guard', () => {
    beforeEach(() => jest.clearAllMocks());

    test('allows an active employee in an active executor group', async () => {
        Employee.findById.mockReturnValue(employeeQuery({
            status: 'active',
            groupId: { status: 'active' }
        }));

        await expect(ensureActiveExecutor({ accountType: 'executor', userId: 'employee-1' }))
            .resolves.toBe(true);
    });

    test('rejects an employee whose executor group is archived', async () => {
        Employee.findById.mockReturnValue(employeeQuery({
            status: 'suspended',
            groupId: { status: 'archived' }
        }));

        await expect(ensureActiveExecutor({ accountType: 'executor', userId: 'employee-1' }))
            .resolves.toBe(false);
    });

    test('does not add a database lookup for non-executor accounts', async () => {
        await expect(ensureActiveExecutor({ accountType: 'company', userId: 'company-1' }))
            .resolves.toBe(true);
        expect(Employee.findById).not.toHaveBeenCalled();
    });
});

describe('JWT tenant binding', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalLegacyFlag = process.env.ALLOW_LEGACY_TENANT_TOKENS;

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
        if (originalLegacyFlag === undefined) delete process.env.ALLOW_LEGACY_TENANT_TOKENS;
        else process.env.ALLOW_LEGACY_TENANT_TOKENS = originalLegacyFlag;
    });

    test('allows a token only on its bound tenant', () => {
        const req = { tenant: { _id: 'tenant-a' } };
        expect(tokenMatchesRequestTenant({ tenantId: 'tenant-a' }, req)).toBe(true);
        expect(tokenMatchesRequestTenant({ tenantId: 'tenant-b' }, req)).toBe(false);
    });

    test('rejects legacy tenantless tokens in production', () => {
        process.env.NODE_ENV = 'production';
        process.env.ALLOW_LEGACY_TENANT_TOKENS = 'false';
        expect(tokenMatchesRequestTenant({}, { tenant: { _id: 'tenant-a' } })).toBe(false);
        expect(tokenMatchesRequestTenant({ tenantId: 'tenant-a' }, {})).toBe(false);
    });
});
