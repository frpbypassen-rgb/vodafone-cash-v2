'use strict';

const {
    resolveCanonicalRole,
    resolveCompanyAccess,
    canAccessCompanyPage,
    assertCapability,
    assertSameCompany,
    assertNotSelf,
    dashboardPersona
} = require('../services/companyAccessService');

describe('company access roles vs capabilities', () => {
    test('maps legacy owner and corporateRole aliases without promoting employees', () => {
        expect(resolveCanonicalRole({ role: 'employee', canViewAllReports: true })).toBe('owner');
        expect(resolveCanonicalRole({ role: 'owner' })).toBe('owner');
        expect(resolveCanonicalRole({ role: 'employee', corporateRole: 'accountant' })).toBe('accountant');
        expect(resolveCanonicalRole({ role: 'employee', canManageCompany: true })).toBe('employee');
        expect(resolveCanonicalRole({ role: 'employee', corporateRole: 'manager' })).toBe('employee');
    });

    test('keeps role independent from transfer and profile flags', () => {
        const blockedEmployee = resolveCompanyAccess({
            role: 'employee',
            canCreateTransfer: false,
            canManageCompanyProfile: true
        });
        expect(blockedEmployee.role).toBe('employee');
        expect(blockedEmployee.canCreateTransfer).toBe(false);
        expect(blockedEmployee.canManageCompanyProfile).toBe(true);
        expect(blockedEmployee.canManageTeam).toBe(false);

        const transferringAccountant = resolveCompanyAccess({
            role: 'accountant',
            canCreateTransfer: true
        });
        expect(transferringAccountant.role).toBe('accountant');
        expect(transferringAccountant.canCreateTransfer).toBe(true);
        expect(transferringAccountant.canManageTeam).toBe(false);
    });

    test('allows and denies pages from server capabilities, not nav maps', () => {
        const owner = resolveCompanyAccess({ role: 'owner' });
        const employee = resolveCompanyAccess({ role: 'employee' });
        const accountant = resolveCompanyAccess({ role: 'accountant' });

        expect(canAccessCompanyPage(owner, 'staff')).toBe(true);
        expect(canAccessCompanyPage(owner, 'services')).toBe(true);
        expect(canAccessCompanyPage(employee, 'finance')).toBe(false);
        expect(canAccessCompanyPage(employee, 'services')).toBe(true);
        expect(canAccessCompanyPage(accountant, 'services')).toBe(false);
        expect(canAccessCompanyPage(accountant, 'finance')).toBe(true);
        expect(canAccessCompanyPage(employee, 'overview')).toBe(false);
        expect(canAccessCompanyPage(owner, 'overview')).toBe(true);
    });

    test('only the owner can manage the team even if flags are crafted', () => {
        const crafted = resolveCompanyAccess({
            role: 'employee',
            canManageCompany: true,
            canCreateCompanyStaff: false,
            canManageTeam: true
        });
        expect(crafted.canManageTeam).toBe(false);
        expect(crafted.canResetStaffPassword).toBe(false);
        expect(() => assertCapability(crafted, 'canManageTeam')).toThrow('FORBIDDEN');
        expect(dashboardPersona({ role: 'employee', canManageCompany: true })).toBe('manager');
    });

    test('blocks cross-company and self targets', () => {
        expect(() => assertSameCompany('aaa', 'bbb')).toThrow('CROSS_COMPANY');
        expect(() => assertNotSelf('user-1', 'user-1')).toThrow('SELF_TARGET_FORBIDDEN');
        expect(() => assertSameCompany('aaa', 'aaa')).not.toThrow();
    });
});
