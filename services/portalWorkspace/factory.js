'use strict';

const buildWorkspaceResult = ({ type, actor, entity, actorModel, entityModel, permissions }) => {
    const persona = permissions.accountant ? 'accountant' : permissions.manager ? 'manager' : 'employee';
    const roleLabel =
        type === 'company'
            ? permissions.owner
                ? 'مدير الشركة'
                : permissions.manager
                  ? 'مدير تشغيل'
                  : permissions.accountant
                    ? 'محاسب'
                    : 'موظف'
            : permissions.owner
              ? 'مدير الوكيل'
              : permissions.manager
                ? 'مدير تشغيل'
                : permissions.accountant
                  ? 'محاسب'
                  : 'موظف';

    return {
        type,
        isCompany: type === 'company',
        isAgent: type === 'agent',
        actor,
        entity,
        actorModel,
        entityModel,
        persona,
        roleLabel,
        entityLabel: type === 'company' ? 'الشركة' : 'الوكيل',
        portalLabel:
            type === 'company' ? 'بوابة الشركات' : permissions.employee ? 'واجهة العميل' : 'بوابة الوكلاء',
        permissions,
        canonicalRole:
            type === 'company'
                ? permissions.canonicalRole ||
                  (permissions.owner ? 'owner' : permissions.accountant ? 'accountant' : 'employee')
                : undefined,
        masterType: type === 'company' ? 'company' : 'user',
        masterId: entity._id,
        forceToday: permissions.employee && !(type === 'agent' && permissions.canViewAllReports),
    };
};

module.exports = { buildWorkspaceResult };
