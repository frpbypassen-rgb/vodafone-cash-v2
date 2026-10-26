'use strict';
const { resolveAgentPermissions } = require('./agentPortalPolicy');
const STAFF_PERMISSION_OPTIONS = Object.freeze([
    { key: 'canTransfer', label: 'تنفيذ التحويلات' },
    { key: 'canViewBalance', label: 'عرض الرصيد المالي', hint: 'السجل المالي يحتاج أيضًا عرض جميع العمليات.' },
    { key: 'canViewAllTransactions', label: 'عرض جميع العمليات' },
    { key: 'canViewAllReports', label: 'عرض جميع التقارير' },
    { key: 'canManageCustomers', label: 'إدارة العملاء', hint: 'إنشاء وتمويل وإيقاف حسابات العملاء.' },
    { key: 'canManageStaff', label: 'إنشاء وإدارة الموظفين', hint: 'صلاحية إدارية لإدارة حسابات الفريق.' }
]);
const checked = value => ['on', 'true', '1'].includes(String(value || '').toLowerCase());
const permissionsError = code => Object.assign(new Error(code), { code });
const buildStaffPermissions = (body, actor, role) => {
    if (!['basic', 'custom'].includes(body.permissionsMode)) throw permissionsError('INVALID_PERMISSIONS');
    const base = resolveAgentPermissions({ role });
    const permissions = Object.fromEntries(STAFF_PERMISSION_OPTIONS.map(({ key }) => [key,
        body.permissionsMode === 'basic' ? base[key] === true : checked(body[`permission_${key}`])
    ]));
    if (role === 'accountant') permissions.canTransfer = false;
    const grantor = resolveAgentPermissions(actor);
    if (STAFF_PERMISSION_OPTIONS.some(({ key }) => permissions[key] && !grantor[key])) throw permissionsError('PERMISSION_ESCALATION');
    return permissions;
};
const canEditStaffPermissions = (actor, target) => {
    const access = resolveAgentPermissions(actor);
    const targetAccess = resolveAgentPermissions(target);
    return access.canManageStaff && String(actor._id) !== String(target._id) && target.role !== 'owner' && target.role !== 'agent'
        && (access.owner || STAFF_PERMISSION_OPTIONS.every(({ key }) => !targetAccess[key] || access[key]));
};
module.exports = { STAFF_PERMISSION_OPTIONS, buildStaffPermissions, canEditStaffPermissions };
