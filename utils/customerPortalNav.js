'use strict';

/** Single customer-portal navigation map (retail hub + agent workspace). */

const RETAIL_DOCK = Object.freeze([
    { key: 'home', href: '/client/dashboard', label: 'الرئيسية', icon: 'fa-house' },
    { key: 'transfers', href: '/client/transfers', label: 'تحويل', icon: 'fa-paper-plane' },
    { key: 'services', href: '/client/services', label: 'الخدمات', icon: 'fa-grid-2' },
    { key: 'settings', href: '/client/settings', label: 'حسابي', icon: 'fa-user-gear' }
]);

const RETAIL_MORE = Object.freeze([
    { key: 'account', href: '/client/account?tab=operations', label: 'العمليات وكشف الحساب', icon: 'fa-receipt', tone: 'account' },
    { key: 'reports', href: '/client/reports', label: 'التقارير', icon: 'fa-chart-column', tone: 'reports' },
    { key: 'deposits', href: '/client/account?tab=deposits-new', label: 'إضافة رصيد', icon: 'fa-circle-plus', tone: 'deposit', hideForAgent: true },
    { key: 'support', href: '/client/support', label: 'الدعم والشكاوى', icon: 'fa-headset', tone: 'support' },
    { key: 'security', href: '/client/settings?section=security', label: 'الأمان والإعدادات', icon: 'fa-shield-halved', tone: 'security' },
    { key: 'logout', href: '/client/logout', label: 'تسجيل الخروج', icon: 'fa-power-off', tone: 'logout', danger: true }
]);

const RETAIL_SIDEBAR_HREFS = Object.freeze([
    '/client/dashboard',
    '/client/transfers',
    '/client/account?tab=operations',
    '/client/account?tab=deposits-new',
    '/client/reports',
    '/client/services',
    '/client/support',
    '/client/settings?section=security'
]);

const RETAIL_MORE_ACTIVE = Object.freeze(['account', 'deposits', 'reports', 'support', 'more']);

const AGENT_DOCK_KEYS = Object.freeze(['overview', 'services', 'transactions', 'support']);

const AGENT_DOCK_LABELS = Object.freeze({
    overview: 'الرئيسية',
    services: 'تحويل',
    transactions: 'العمليات',
    support: 'الدعم'
});

const AGENT_MORE_KEYS = Object.freeze([
    'finance',
    'agency_balances',
    'agency_debts',
    'agency_account',
    'agency_position',
    'agency_profits',
    'customers',
    'customer_profile',
    'staff',
    'reports',
    'settings',
    'security'
]);

const normalizeHref = (href) => String(href || '').split('#')[0];

const hrefCovered = (href, covered) => {
    const target = normalizeHref(href);
    if (covered.has(target)) return true;
    if (target.startsWith('/client/settings') && [...covered].some((item) => item.startsWith('/client/settings'))) {
        return true;
    }
    if (target.startsWith('/client/account') && [...covered].some((item) => item.startsWith('/client/account'))) {
        return true;
    }
    return false;
};

const buildRetailDock = (activeNav = 'home') => RETAIL_DOCK.map((item) => ({
    ...item,
    active: item.key === activeNav
}));

const isRetailMoreActive = (activeNav = '') => RETAIL_MORE_ACTIVE.includes(String(activeNav || ''));

const buildRetailMore = ({ canRequestDeposit = true, canEditProfile = false, isAgent = false, activeNav = '' } = {}) => {
    const items = RETAIL_MORE.filter((item) => {
        if (item.hideForAgent && isAgent) return false;
        if (item.key === 'deposits' && canRequestDeposit === false) return false;
        return true;
    }).map((item) => ({
        ...item,
        active: item.key === activeNav
    }));
    if (canEditProfile) {
        items.splice(items.length - 1, 0, {
            key: 'profile',
            href: '/client/settings?section=profile',
            label: 'الملف الشخصي',
            icon: 'fa-user-pen',
            tone: 'profile',
            active: activeNav === 'profile'
        });
    }
    return items;
};

const retailMobileCoversSidebar = (options = {}) => {
    const more = buildRetailMore(options);
    const covered = new Set([
        ...RETAIL_DOCK.map((item) => item.href),
        ...more.map((item) => item.href)
    ]);
    return RETAIL_SIDEBAR_HREFS.every((href) => hrefCovered(href, covered));
};

const buildAgentMobileNav = (navigation = [], activePage = '') => {
    const dock = AGENT_DOCK_KEYS.map((key) => {
        const item = navigation.find((nav) => nav.key === key);
        if (!item) return null;
        return { ...item, dockLabel: AGENT_DOCK_LABELS[key] || item.label };
    }).filter(Boolean);
    const more = navigation.filter((item) => !AGENT_DOCK_KEYS.includes(item.key));
    const moreActive = more.some((item) => item.active) || AGENT_MORE_KEYS.includes(String(activePage || ''));
    return { dock, more, moreActive };
};

const agentMobileCoversSidebar = (navigation = [], activePage = '') => {
    const { dock, more } = buildAgentMobileNav(navigation, activePage);
    const covered = new Set([...dock, ...more].map((item) => item.key));
    return navigation.every((item) => covered.has(item.key));
};

const CUSTOMER_NOTIFICATION_HREFS = Object.freeze({
    '/client/transactions': '/client/account?tab=operations',
    '/client/finance': '/client/account?tab=operations',
    '/client/company/deposits': '/client/account?tab=deposits-new'
});

const rewriteCustomerNotificationHref = (href, { retail = false } = {}) => {
    const target = String(href || '').trim() || '/client/dashboard';
    if (!retail) return target;
    return CUSTOMER_NOTIFICATION_HREFS[target] || target;
};

module.exports = {
    RETAIL_DOCK,
    RETAIL_MORE,
    RETAIL_SIDEBAR_HREFS,
    AGENT_DOCK_KEYS,
    AGENT_DOCK_LABELS,
    buildRetailDock,
    buildRetailMore,
    isRetailMoreActive,
    retailMobileCoversSidebar,
    buildAgentMobileNav,
    agentMobileCoversSidebar,
    rewriteCustomerNotificationHref
};
