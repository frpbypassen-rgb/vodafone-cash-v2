'use strict';

const { pharaonicIconForNav } = require('../../utils/companyPortalTheme');

const buildNavigation = (workspace, activePage) => {
    const navPage = activePage === 'service_workbench' ? 'services' : activePage;
    // Company accounts do not manage customers. Keep every capability in one clear
    // workspace so the sidebar is the single source of navigation, not a set of
    // repeated shortcuts scattered across dashboard cards.
    const items = workspace.isCompany
        ? [
              {
                  key: 'overview',
                  href: '/client/dashboard?home=1',
                  label: 'مركز القيادة',
                  icon: 'fa-building-shield',
                  group: 'القيادة',
                  visible: !workspace.permissions.employee,
              },
              {
                  key: 'services',
                  href: '/client/services',
                  label: 'معرض الخدمات',
                  icon: 'fa-cubes',
                  group: 'التنفيذ',
                  visible: workspace.permissions.canTransfer,
              },
              {
                  key: 'smart_transfer',
                  href: '/client/smart-transfer',
                  label: 'التحويل الذكي',
                  icon: 'fa-wand-magic-sparkles',
                  group: 'التنفيذ',
                  visible: workspace.permissions.canTransfer,
              },
              {
                  key: 'internal_transfer',
                  href: '/client/internal-transfer',
                  label: 'تحويل داخلي',
                  icon: 'fa-right-left',
                  group: 'التنفيذ',
                  visible: workspace.permissions.canInternalTransfer,
              },
              {
                  key: 'transactions',
                  href: '/client/transactions',
                  label: workspace.forceToday ? 'عمليات اليوم' : 'غرفة العمليات',
                  icon: 'fa-list-check',
                  group: 'التنفيذ',
                  visible: true,
              },
              {
                  key: 'staff',
                  href: '/client/staff',
                  label: 'فريق الشركة',
                  icon: 'fa-user-group',
                  group: 'المؤسسة',
                  visible: workspace.permissions.manager || workspace.permissions.accountant,
              },
              {
                  key: 'deposits',
                  href: '/client/company/deposits',
                  label: workspace.permissions.manager ? 'طلب إيداع' : 'متابعة الإيداع',
                  icon: 'fa-building-columns',
                  group: 'المؤسسة',
                  visible: workspace.permissions.canRequestDeposit,
              },
              {
                  key: 'finance',
                  href: '/client/finance',
                  label: 'مكتب المحاسبة',
                  icon: 'fa-scale-balanced',
                  group: 'الرقابة المالية',
                  visible: workspace.permissions.canViewBalance,
              },
              {
                  key: 'reports',
                  href: '/client/reports',
                  label: 'كشف الحساب',
                  icon: 'fa-file-invoice',
                  group: 'الرقابة المالية',
                  visible: workspace.permissions.canViewReports,
              },
              {
                  key: 'team_reports',
                  href: '/client/reports/staff',
                  label: 'أداء الموظفين',
                  icon: 'fa-chart-column',
                  group: 'الرقابة المالية',
                  visible:
                      workspace.permissions.canViewReports &&
                      (workspace.permissions.manager || workspace.permissions.accountant),
              },
              {
                  key: 'settings',
                  href: '/client/settings',
                  label: 'بيانات المنشأة',
                  icon: 'fa-address-card',
                  group: 'الحساب',
                  visible: true,
              },
              {
                  key: 'security',
                  href: '/client/security',
                  label: 'أمان الحساب',
                  icon: 'fa-shield-halved',
                  group: 'الحساب',
                  visible: true,
              },
              {
                  key: 'support',
                  href: '/client/support',
                  label: 'الدعم الفني',
                  icon: 'fa-headset',
                  group: 'الحساب',
                  visible: true,
              },
          ]
        : [
              {
                  key: 'overview',
                  href: '/client/dashboard?home=1',
                  label: 'الرئيسية',
                  icon: 'fa-grid-2',
                  group: 'العمل اليومي',
                  visible: true,
              },
              {
                  key: 'services',
                  href: '/client/services',
                  label: 'الخدمات والتحويل',
                  icon: 'fa-paper-plane',
                  group: 'العمل اليومي',
                  visible: workspace.permissions.canTransfer,
              },
              {
                  key: 'transactions',
                  href: '/client/transactions',
                  label: 'المعاملات',
                  icon: 'fa-list-check',
                  group: 'العمل اليومي',
                  visible: true,
              },
              {
                  key: 'finance',
                  href: '/client/finance',
                  label: 'الحركات المالية',
                  icon: 'fa-scale-balanced',
                  group: 'العمل اليومي',
                  visible: workspace.permissions.canViewBalance,
              },
              {
                  key: 'agency_balances',
                  href: '/client/finance/customer-balances',
                  label: 'أرصدة العملاء',
                  icon: 'fa-wallet',
                  group: 'محاسبة الوكالة',
                  visible: workspace.permissions.canViewBalance,
              },
              {
                  key: 'agency_debts',
                  href: '/client/finance/customer-debts',
                  label: 'ديون العملاء',
                  icon: 'fa-file-invoice-dollar',
                  group: 'محاسبة الوكالة',
                  visible: workspace.permissions.canViewBalance,
              },
              {
                  key: 'agency_account',
                  href: '/client/finance/agency-account',
                  label: 'حساب الوكالة',
                  icon: 'fa-building-columns',
                  group: 'محاسبة الوكالة',
                  visible: workspace.permissions.canViewBalance,
              },
              {
                  key: 'agency_position',
                  href: '/client/finance/position',
                  label: 'المركز المالي',
                  icon: 'fa-scale-balanced',
                  group: 'محاسبة الوكالة',
                  visible: workspace.permissions.canViewBalance,
              },
              {
                  key: 'agency_profits',
                  href: '/client/finance/profits',
                  label: 'أرباح العملاء',
                  icon: 'fa-chart-line',
                  group: 'محاسبة الوكالة',
                  visible: workspace.permissions.canViewBalance,
              },
              {
                  key: 'customers',
                  href: '/client/customers',
                  label: 'العملاء',
                  icon: 'fa-users',
                  group: 'الإدارة',
                  visible: workspace.permissions.canManageCustomers,
              },
              {
                  key: 'staff',
                  href: '/client/staff',
                  label: 'الموظفون',
                  icon: 'fa-user-group',
                  group: 'الإدارة',
                  visible: workspace.permissions.manager || workspace.permissions.accountant,
              },
              {
                  key: 'reports',
                  href: '/client/reports',
                  label: 'التقارير',
                  icon: 'fa-chart-column',
                  group: 'التحليل',
                  visible: workspace.permissions.canViewReports,
              },
              {
                  key: 'settings',
                  href: '/client/settings',
                  label: 'الإعدادات',
                  icon: 'fa-sliders',
                  group: 'الحساب والنظام',
                  visible: true,
              },
              {
                  key: 'support',
                  href: '/client/support',
                  label: 'الدعم الفني',
                  icon: 'fa-headset',
                  group: 'الحساب والنظام',
                  visible: true,
              },
          ];

    return items
        .filter((item) => item.visible)
        .map((item) => ({
            ...item,
            pharaonicIcon: workspace.isCompany ? pharaonicIconForNav(item.key) : undefined,
            active:
                item.key === navPage ||
                (navPage === 'customer_profile' && item.key === 'customers') ||
                (navPage === 'reports' && item.key === 'reports'),
        }));
};

const COMPANY_MOBILE_KEYS = Object.freeze({
    manager: ['services', 'transactions', 'reports', 'support', 'settings'],
    accountant: ['finance', 'transactions', 'reports', 'support', 'settings'],
    employee: ['services', 'smart_transfer', 'transactions', 'support', 'security'],
});

const COMPANY_MOBILE_LABELS = Object.freeze({
    services: 'الخدمات',
    smart_transfer: 'تحويل',
    transactions: 'عمليات',
    support: 'الدعم',
    settings: 'الحساب',
    security: 'الحساب',
    finance: 'المالية',
    reports: 'التقارير',
});

const buildCompanyMobileNav = (workspace, navigation = []) => {
    const keys = COMPANY_MOBILE_KEYS[workspace?.persona] || COMPANY_MOBILE_KEYS.employee;
    return keys
        .map((key) => {
            const item = navigation.find((nav) => nav.key === key);
            if (!item) return null;
            return { ...item, dockLabel: COMPANY_MOBILE_LABELS[key] || item.label };
        })
        .filter(Boolean)
        .slice(0, 5);
};

module.exports = { buildNavigation, COMPANY_MOBILE_KEYS, COMPANY_MOBILE_LABELS, buildCompanyMobileNav };
