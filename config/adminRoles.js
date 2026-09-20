'use strict';

const ADMIN_ROLES = Object.freeze(['master', 'admin', 'accountant']);

const ADMIN_PERMISSIONS = Object.freeze([
    ['dashboard.read', 'عرض لوحة القيادة'],
    ['transactions.read', 'عرض العمليات'],
    ['transactions.manage', 'إدارة وتوجيه العمليات'],
    ['accounts.read', 'عرض الحسابات'],
    ['accounts.manage', 'إدارة الحسابات والأرصدة'],
    ['executors.read', 'عرض شركات التنفيذ'],
    ['executors.manage', 'إدارة شركات التنفيذ'],
    ['reports.read', 'عرض التقارير وسجل التدقيق'],
    ['reports.manage', 'إدارة التقارير والحركات المالية'],
    ['support.read', 'عرض الدعم والشكاوى'],
    ['support.manage', 'إدارة الدعم والشكاوى'],
    ['settings.read', 'عرض الإعدادات'],
    ['settings.manage', 'تعديل إعدادات المنظومة'],
    ['security.read', 'عرض مركز الأمان'],
    ['security.manage', 'إدارة الحماية والأجهزة']
]);

const ACCOUNTANT_PERMISSIONS = Object.freeze([
    'dashboard.read',
    'transactions.read',
    'accounts.read',
    'executors.read',
    'reports.read'
]);

const ACCOUNTANT_ALLOWED_HREFS = Object.freeze([
    '/',
    '/financial-movements',
    '/transactions/live',
    '/transactions',
    '/transactions/operations',
    '/transactions/movements',
    '/transactions/search',
    '/reports',
    '/audit-log',
    '/clients'
]);

const ACCOUNTANT_BLOCKED_PATHS = [
    /^\/settings(?:\/|$)/,
    /^\/admin\/security(?:\/|$)/,
    /^\/admin\/accounts(?:\/|$)/,
    /^\/broadcast(?:\/|$)/,
    /^\/registration-requests(?:\/|$)/,
    /^\/support(?:\/|$)/,
    /^\/complaints(?:\/|$)/,
    /^\/whatsapp-monitor(?:\/|$)/,
    /^\/admin\/webhooks(?:\/|$)/,
    /^\/sub-account(?:\/|$)/,
    /^\/employees(?:\/|$)/,
    /^\/executors(?:\/|$)/,
    /^\/executor(?:\/|$)/
];

const ACCOUNTANT_WRITE_ALLOWLIST = [
    /^\/logout\/?$/
];

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const normalizeAdminRole = (value) => {
    const role = String(value || '').trim().toLowerCase();
    if (role === 'master') return 'master';
    if (role === 'accountant') return 'accountant';
    return 'admin';
};

const isAccountantRole = (role) => normalizeAdminRole(role) === 'accountant';

const allowedPermissionValues = () => ADMIN_PERMISSIONS.map(([value]) => value);

const sanitizeRequestedPermissions = (requested = []) => {
    const allowed = new Set(allowedPermissionValues());
    return [...new Set((Array.isArray(requested) ? requested : []).map(String).filter((item) => allowed.has(item)))];
};

const permissionsForRole = (role, requested = []) => {
    const normalized = normalizeAdminRole(role);
    if (normalized === 'master') return ['*'];
    if (normalized === 'accountant') return [...ACCOUNTANT_PERMISSIONS];
    return sanitizeRequestedPermissions(requested);
};

const accountantPathAllowed = (method, path) => {
    const normalizedPath = String(path || '').split('?')[0];
    if (ACCOUNTANT_WRITE_ALLOWLIST.some((pattern) => pattern.test(normalizedPath))) return true;
    if (ACCOUNTANT_BLOCKED_PATHS.some((pattern) => pattern.test(normalizedPath))) return false;
    if (!SAFE_HTTP_METHODS.has(String(method || 'GET').toUpperCase())) return false;
    return true;
};

const adminHrefVisible = (role, href) => {
    if (!isAccountantRole(role)) return true;
    const path = String(href || '').split('?')[0];
    return ACCOUNTANT_ALLOWED_HREFS.includes(path);
};

module.exports = {
    ADMIN_ROLES,
    ADMIN_PERMISSIONS,
    ACCOUNTANT_PERMISSIONS,
    ACCOUNTANT_ALLOWED_HREFS,
    ACCOUNTANT_BLOCKED_PATHS,
    normalizeAdminRole,
    isAccountantRole,
    permissionsForRole,
    sanitizeRequestedPermissions,
    accountantPathAllowed,
    adminHrefVisible,
    allowedPermissionValues
};
