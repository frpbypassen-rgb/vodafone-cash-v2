'use strict';

const ADMIN_ROLES = Object.freeze(['master', 'admin', 'accountant']);

const ADMIN_PERMISSIONS = Object.freeze([
    ['dashboard.read', 'عرض لوحة القيادة'],
    ['transactions.read', 'عرض العمليات'],
    ['transactions.manage', 'إدارة وتوجيه العمليات'],
    ['transactions.resolve_provider', 'حسم نتيجة مزود غير محسومة'],
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
    'accounts.read',
    'executors.read'
]);

const ACCOUNTANT_ALLOWED_HREFS = Object.freeze([
    '/clients',
    '/executors'
]);

const ACCOUNTANT_READ_PATHS = Object.freeze([
    /^\/clients\/?$/,
    /^\/(?:user|company|executor)\/[^/]+\/?$/,
    /^\/executors\/?$/
]);
const ACCOUNTANT_ENROLL_PATHS = Object.freeze({
    GET: Object.freeze(['/admin/accountant-enroll', '/admin/accountant-enroll/options']),
    POST: Object.freeze(['/admin/accountant-enroll/verify'])
});

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
    const verb = String(method || '').toUpperCase();
    if (/^\/logout\/?$/.test(normalizedPath)) return verb === 'GET' || verb === 'POST';
    if (ACCOUNTANT_ENROLL_PATHS[verb]?.includes(normalizedPath)) return true;
    return (verb === 'GET' || verb === 'HEAD')
        && ACCOUNTANT_READ_PATHS.some((pattern) => pattern.test(normalizedPath));
};

const adminHrefVisible = (role, href) => {
    if (!isAccountantRole(role)) return true;
    const path = String(href || '').split('?')[0];
    return ACCOUNTANT_ALLOWED_HREFS.includes(path);
};

const canSubscribeAdminChannel = (session, permission) => {
    if (!session?.isLoggedIn || isAccountantRole(session.adminRole)) return false;
    if (session.adminRole === 'master') return true;
    const permissions = new Set(session.adminPermissions || []);
    return permissions.has('*') || permissions.has(permission);
};

module.exports = {
    ADMIN_ROLES,
    ADMIN_PERMISSIONS,
    ACCOUNTANT_PERMISSIONS,
    ACCOUNTANT_ALLOWED_HREFS,
    ACCOUNTANT_READ_PATHS,
    normalizeAdminRole,
    isAccountantRole,
    permissionsForRole,
    sanitizeRequestedPermissions,
    accountantPathAllowed,
    adminHrefVisible,
    canSubscribeAdminChannel,
    allowedPermissionValues
};
