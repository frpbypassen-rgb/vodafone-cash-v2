'use strict';

const { companyRoleHelpers } = require('../controllers/clientCompanyController');

describe('Company client role helpers', () => {
    test('legacy company manager keeps staff creation permission', () => {
        const legacyOwner = {
            role: 'employee',
            canViewAllReports: true
        };

        expect(companyRoleHelpers.dashboardPersona(legacyOwner)).toBe('manager');
        expect(companyRoleHelpers.canManageCompany(legacyOwner)).toBe(true);
        expect(companyRoleHelpers.canCreateStaff(legacyOwner)).toBe(true);
        expect(companyRoleHelpers.canViewCompanyBalance(legacyOwner)).toBe(true);
    });

    test('delegated manager cannot create company staff', () => {
        const delegatedManager = {
            role: 'employee',
            canViewAllReports: true,
            canManageCompany: true,
            canCreateCompanyStaff: false
        };

        expect(companyRoleHelpers.dashboardPersona(delegatedManager)).toBe('manager');
        expect(companyRoleHelpers.canManageCompany(delegatedManager)).toBe(true);
        expect(companyRoleHelpers.canCreateStaff(delegatedManager)).toBe(false);
        expect(companyRoleHelpers.canViewCompanyBalance(delegatedManager)).toBe(true);
    });

    test('accountant and employee resolve to separate dashboards', () => {
        expect(companyRoleHelpers.dashboardPersona({ role: 'accountant' })).toBe('accountant');
        expect(companyRoleHelpers.canViewCompanyBalance({ role: 'accountant' })).toBe(true);

        const employee = { role: 'employee', canViewAllReports: false };
        expect(companyRoleHelpers.dashboardPersona(employee)).toBe('employee');
        expect(companyRoleHelpers.canViewCompanyBalance(employee)).toBe(false);
        expect(companyRoleHelpers.canCreateStaff(employee)).toBe(false);
    });

    test('company usernames are normalized to the official domain', () => {
        expect(companyRoleHelpers.normalizeCompanyUsername('Branch_User')).toBe('branch_user@ahram.com');
        expect(() => companyRoleHelpers.normalizeCompanyUsername('bad user')).toThrow('INVALID_USERNAME');
    });
});
