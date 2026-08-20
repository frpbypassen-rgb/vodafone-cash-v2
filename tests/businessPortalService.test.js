'use strict';

const {
    resolveDateRange,
    resolveCompanyPermissions,
    resolveAgentPermissions,
    buildNavigation,
    buildReportGroups,
    summarizeTransactions,
    SERVICE_CATALOG
} = require('../services/businessPortalService');

describe('Business portal service', () => {
    test('resolves company permissions without granting staff creation to delegated managers', () => {
        const owner = resolveCompanyPermissions({ role: 'owner' });
        const manager = resolveCompanyPermissions({ role: 'employee', canManageCompany: true, canViewAllReports: true });
        const employee = resolveCompanyPermissions({ role: 'employee' });

        expect(owner).toMatchObject({ owner: true, manager: true, canManageStaff: true, canManageCustomers: true });
        expect(manager).toMatchObject({ owner: false, manager: true, canManageStaff: false, canManageCustomers: true });
        expect(employee).toMatchObject({ employee: true, canViewBalance: false, canViewReports: true, canTransfer: true });
    });

    test('keeps accountants read-only and agent owners fully enabled', () => {
        const accountant = resolveAgentPermissions({ role: 'accountant' });
        const owner = resolveAgentPermissions({ role: 'agent' });

        expect(accountant).toMatchObject({ accountant: true, canTransfer: false, canViewBalance: true, canViewReports: true });
        expect(owner).toMatchObject({ owner: true, manager: true, canTransfer: true, canManageStaff: true, canManageCustomers: true });
    });

    test('resolves explicit local date ranges inclusively', () => {
        const range = resolveDateRange({ from: '2026-08-01', to: '2026-08-03' });

        expect(range.from).toBe('2026-08-01');
        expect(range.to).toBe('2026-08-03');
        expect(range.start.getHours()).toBe(0);
        expect(range.end.getHours()).toBe(23);
        expect(range.end.getMinutes()).toBe(59);
    });

    test('ignores requested dates when an employee is restricted to today', () => {
        const range = resolveDateRange({ from: '2020-01-01', to: '2030-12-31' }, { forceToday: true });
        const today = new Date();
        const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        expect(range).toMatchObject({ from: expected, to: expected, label: 'اليوم' });
        expect(range.start.getHours()).toBe(0);
        expect(range.end.getHours()).toBe(23);
    });

    test('builds role-aware navigation with real standalone routes', () => {
        const navigation = buildNavigation({
            permissions: {
                canTransfer: false,
                canViewBalance: true,
                canManageCustomers: false,
                manager: false,
                accountant: true,
                canViewReports: true
            }
        }, 'reports');

        expect(navigation.some((item) => item.href === '/client/services')).toBe(false);
        expect(navigation.some((item) => item.href === '/client/customers')).toBe(false);
        expect(navigation.find((item) => item.key === 'reports')).toMatchObject({ active: true, href: '/client/reports' });
        expect(navigation.some((item) => item.href.startsWith('#'))).toBe(false);
    });

    test('uses the client transfer fields for company and agent services', () => {
        const byKey = Object.fromEntries(SERVICE_CATALOG.map((service) => [service.key, service]));

        expect(byKey.vodafone).toMatchObject({ destinationMaxLength: 11, beneficiaryRequired: false });
        expect(byKey.post_account).toMatchObject({ destinationMaxLength: 15, beneficiaryMinWords: 3 });
        expect(byKey.post_card).toMatchObject({
            destinationRequired: false,
            requiresNationalId: true,
            requiresGovernorate: true,
            requiresIdentityImage: true
        });
        expect(byKey.bank_account.requiresBankName).toBeUndefined();
        expect(byKey.sefa_niger).toMatchObject({
            integerAmount: true,
            destinationMaxLength: 11,
            amountCurrencyLabel: 'سيفا',
            rateDirection: 'source_to_lyd'
        });
        expect(byKey.sefa_niger.cityRequiredForSubtypes).toEqual(['nita']);
    });

    test('summarizes and groups organization, customer, and staff reports', () => {
        const transactions = [
            { status: 'completed', amount: 1000, costLYD: 160, createdAt: new Date('2026-08-02T08:00:00Z'), employeeName: 'أحمد', subAccountName: 'عميل 1' },
            { status: 'pending', amount: 500, costLYD: 80, createdAt: new Date('2026-08-02T09:00:00Z'), employeeName: 'أحمد', subAccountName: 'عميل 1' },
            { status: 'deposit', amount: 250, createdAt: new Date('2026-08-03T10:00:00Z'), employeeName: 'سالم', subAccountName: 'عميل 2' },
            { status: 'cancelled_by_admin', amount: 300, costLYD: 48, createdAt: new Date('2026-08-03T11:00:00Z'), employeeName: 'سالم', subAccountName: 'عميل 2' }
        ];

        expect(summarizeTransactions(transactions)).toMatchObject({
            totalCount: 4,
            completedCount: 1,
            pendingCount: 1,
            cancelledCount: 1,
            totalEGP: 1000,
            totalLYD: 160,
            depositTotal: 250
        });
        expect(buildReportGroups(transactions, 'organization')).toHaveLength(2);
        expect(buildReportGroups(transactions, 'customers').map((row) => row.key).sort()).toEqual(['عميل 1', 'عميل 2']);
        expect(buildReportGroups(transactions, 'staff').map((row) => row.key).sort()).toEqual(['أحمد', 'سالم']);
    });
});
