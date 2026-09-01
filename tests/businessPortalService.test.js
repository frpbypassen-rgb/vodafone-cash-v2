'use strict';

const {
    resolveDateRange,
    resolveCompanyPermissions,
    resolveAgentPermissions,
    buildNavigation,
    buildReportGroups,
    summarizeTransactions,
    findServiceByToken,
    resolvePortalHomeHref,
    forbiddenRedirectPath,
    canAccessPage,
    canPostPortalTransfer,
    buildLowBalanceAlert,
    parseCompanyDepositSupportMessage,
    isCompanyDepositCreateIntent,
    canCreateCompanyDepositRequest,
    SERVICE_CATALOG
} = require('../services/businessPortalService');

describe('Business portal service', () => {
    test('resolves company permissions without granting staff creation to delegated managers', () => {
        const owner = resolveCompanyPermissions({ role: 'owner' });
        const manager = resolveCompanyPermissions({ role: 'employee', canManageCompany: true, canViewAllReports: true });
        const employee = resolveCompanyPermissions({ role: 'employee' });

        expect(owner).toMatchObject({ owner: true, manager: true, canManageStaff: true, canManageCustomers: false, canInternalTransfer: true, canRequestDeposit: true });
        expect(manager).toMatchObject({ owner: false, manager: true, canManageStaff: false, canManageCustomers: false, canInternalTransfer: true });
        expect(employee).toMatchObject({ employee: true, canViewBalance: false, canViewReports: false, canTransfer: true, canInternalTransfer: false });
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

    test('isolates company services, internal transfer, and deposits by role', () => {
        const managerNav = buildNavigation({
            isCompany: true,
            forceToday: false,
            permissions: {
                canTransfer: true,
                canViewBalance: true,
                canManageCustomers: false,
                manager: true,
                accountant: false,
                employee: false,
                canViewReports: true,
                canInternalTransfer: true,
                canRequestDeposit: true
            }
        }, 'services');
        const employeeNav = buildNavigation({
            isCompany: true,
            forceToday: true,
            permissions: {
                canTransfer: true,
                canViewBalance: false,
                canManageCustomers: false,
                manager: false,
                accountant: false,
                employee: true,
                canViewReports: false,
                canInternalTransfer: false,
                canRequestDeposit: false
            }
        }, 'services');

        expect(managerNav.find((item) => item.key === 'services')).toMatchObject({ href: '/client/services', active: true });
        expect(managerNav.some((item) => item.key === 'smart_transfer')).toBe(true);
        expect(managerNav.some((item) => item.key === 'internal_transfer')).toBe(true);
        expect(managerNav.find((item) => item.key === 'deposits')).toMatchObject({ href: '/client/company/deposits', label: 'طلب إيداع' });
        expect(managerNav.some((item) => item.href === '/client/security')).toBe(true);
        expect(managerNav.find((item) => item.key === 'settings')).toMatchObject({ href: '/client/settings', label: 'بيانات المنشأة' });
        expect(managerNav.some((item) => item.key === 'customers')).toBe(false);
        expect(employeeNav.some((item) => item.key === 'overview')).toBe(false);
        expect(employeeNav.some((item) => item.key === 'internal_transfer')).toBe(false);
        expect(employeeNav.some((item) => item.key === 'staff')).toBe(false);
        expect(employeeNav.some((item) => item.key === 'finance')).toBe(false);
        expect(resolvePortalHomeHref({ isCompany: true, persona: 'employee' })).toBe('/client/services');
        expect(resolvePortalHomeHref({ isCompany: true, persona: 'accountant' })).toBe('/client/finance');
        expect(resolvePortalHomeHref({ isCompany: true, persona: 'manager' })).toBe('/client/dashboard?home=1');
        expect(forbiddenRedirectPath({ isCompany: true, persona: 'employee' })).toBe('/client/services?portalError=forbidden');
        expect(forbiddenRedirectPath({ isCompany: true, persona: 'accountant' })).toBe('/client/finance?portalError=forbidden');
        expect(forbiddenRedirectPath({ isCompany: true, persona: 'manager' })).toBe('/client/dashboard?home=1&portalError=forbidden');
        expect(canAccessPage({
            isCompany: true,
            permissions: { employee: true, canTransfer: true }
        }, 'overview')).toBe(false);
        expect(canAccessPage({
            isCompany: true,
            permissions: { employee: false, manager: true, canTransfer: true, canInternalTransfer: true, canRequestDeposit: true, canViewBalance: true, canViewReports: true }
        }, 'overview')).toBe(true);
        expect(canAccessPage({
            isCompany: true,
            permissions: { employee: true, canTransfer: true }
        }, 'internal_transfer')).toBe(false);
        expect(canAccessPage({
            isCompany: true,
            permissions: { employee: true, canViewBalance: false, canTransfer: true }
        }, 'finance')).toBe(false);
        expect(canAccessPage({
            isCompany: true,
            permissions: { accountant: true, canViewBalance: true, canRequestDeposit: true }
        }, 'finance')).toBe(true);
        expect(canAccessPage({
            isCompany: true,
            permissions: { employee: true, canTransfer: true }
        }, 'security')).toBe(true);
        expect(canAccessPage({
            isCompany: true,
            permissions: { accountant: true, canTransfer: false }
        }, 'services')).toBe(false);
        expect(employeeNav.some((item) => item.href === '/client/security')).toBe(true);

        const accountantNav = buildNavigation({
            isCompany: true,
            forceToday: false,
            permissions: {
                accountant: true,
                manager: false,
                employee: false,
                canTransfer: false,
                canViewBalance: true,
                canViewReports: true,
                canRequestDeposit: true,
                canInternalTransfer: false
            }
        }, 'finance');
        expect(accountantNav.find((item) => item.key === 'deposits')).toMatchObject({
            href: '/client/company/deposits',
            label: 'متابعة الإيداع'
        });
        expect(accountantNav.some((item) => item.key === 'services')).toBe(false);
        expect(accountantNav.some((item) => item.key === 'internal_transfer')).toBe(false);
        expect(canPostPortalTransfer('company', { role: 'accountant' })).toBe(false);
        expect(canPostPortalTransfer('company', { role: 'employee' })).toBe(true);
        expect(canPostPortalTransfer('company', { role: 'owner' })).toBe(true);
        expect(canPostPortalTransfer('agent_staff', { role: 'accountant' })).toBe(false);
        expect(canPostPortalTransfer('user', { role: 'agent' })).toBe(true);
        expect(canPostPortalTransfer('user', { role: 'accountant' })).toBe(false);
    });

    test('resolves company service workbenches by key or slug', () => {
        expect(findServiceByToken('cash').key).toBe('vodafone');
        expect(findServiceByToken('post-card').key).toBe('post_card');
        expect(findServiceByToken('bank_account').slug).toBe('bank');
        expect(findServiceByToken('unknown')).toBeNull();
    });

    test('uses the client transfer fields for company and agent services', () => {
        const byKey = Object.fromEntries(SERVICE_CATALOG.map((service) => [service.key, service]));

        expect(byKey.vodafone).toMatchObject({ destinationMaxLength: 11, beneficiaryRequired: false, slug: 'cash' });
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

    test('builds a one-time low-balance alert for company accounts that can view balance', () => {
        const company = (balance, creditLimit, canViewBalance = true) => ({
            isCompany: true,
            permissions: { canViewBalance },
            entity: { name: 'شركة الأهرام', balance, creditLimit }
        });

        expect(buildLowBalanceAlert(company(-12, 1000))).toMatchObject({
            tone: 'danger',
            title: 'الرصيد تحت الصفر'
        });
        expect(buildLowBalanceAlert(company(80, 1000))).toMatchObject({
            tone: 'warning',
            title: 'الرصيد يقترب من الحد'
        });
        expect(buildLowBalanceAlert(company(20, 0))).toMatchObject({
            tone: 'warning',
            title: 'الرصيد منخفض'
        });
        expect(buildLowBalanceAlert(company(400, 1000))).toBeNull();
        expect(buildLowBalanceAlert(company(-5, 0, false))).toBeNull();
        expect(buildLowBalanceAlert({
            isCompany: false,
            permissions: { canViewBalance: true },
            entity: { name: 'وكيل', balance: 0, creditLimit: 0 }
        })).toBeNull();
    });

    test('parses company deposit requests sent through support tickets', () => {
        const pending = parseCompanyDepositSupportMessage(
            'طلب إيداع رصيد\nالقيمة: 250.50 LYD\nالملاحظة: حوالة مصرف ليبيا',
            { ticketId: 'TCK-123456', status: 'open', createdAt: new Date('2026-09-01T10:00:00Z') }
        );
        const closed = parseCompanyDepositSupportMessage(
            'طلب إيداع رصيد\nالقيمة: 100 LYD\nالملاحظة: تم',
            { ticketId: 'TCK-999000', status: 'resolved' }
        );

        expect(pending).toMatchObject({
            customId: 'TCK-123456',
            amount: 250.5,
            status: 'deposit_pending',
            source: 'support',
            note: 'حوالة مصرف ليبيا'
        });
        expect(closed).toMatchObject({ status: 'deposit', amount: 100 });
        expect(parseCompanyDepositSupportMessage('مرحباً أحتاج مساعدة')).toBeNull();
    });

    test('blocks informal company deposit create intent but allows follow-up', () => {
        expect(isCompanyDepositCreateIntent('أريد إيداع 500 دينار')).toBe(true);
        expect(isCompanyDepositCreateIntent('طلب إيداع جديد بقيمة 200')).toBe(true);
        expect(isCompanyDepositCreateIntent('طلب إيداع رصيد\nالقيمة: 80 LYD\nالملاحظة: حوالة')).toBe(true);
        expect(isCompanyDepositCreateIntent('ما حالة طلب الإيداع؟')).toBe(false);
        expect(isCompanyDepositCreateIntent('متابعة طلب الإيداع رقم TCK-1')).toBe(false);
        expect(isCompanyDepositCreateIntent('رقم العملية AH-12 معلّقة')).toBe(false);
    });

    test('allows only company managers to create a deposit request', () => {
        expect(canCreateCompanyDepositRequest({
            isCompany: true,
            permissions: { manager: true }
        })).toBe(true);
        expect(canCreateCompanyDepositRequest({
            isCompany: true,
            permissions: { accountant: true, manager: false }
        })).toBe(false);
        expect(canCreateCompanyDepositRequest({
            isCompany: true,
            permissions: { employee: true, manager: false }
        })).toBe(false);
        expect(canCreateCompanyDepositRequest({
            isCompany: false,
            permissions: { manager: true }
        })).toBe(false);
    });
});
