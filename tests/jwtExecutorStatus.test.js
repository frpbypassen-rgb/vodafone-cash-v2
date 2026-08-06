'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(32);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'r'.repeat(32);

jest.mock('../models/Employee', () => ({
    findById: jest.fn()
}));

const Employee = require('../models/Employee');
const { ensureActiveExecutor } = require('../middlewares/jwtAuth');

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
