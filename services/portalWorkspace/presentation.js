'use strict';

const { safeNumber } = require('./primitives');

const resolvePortalHomeHref = (workspace) => {
    if (!workspace?.isCompany) return '/client/dashboard?home=1';
    if (workspace.persona === 'accountant') return '/client/finance';
    return '/client/services';
};

const forbiddenRedirectPath = (workspace) => {
    const home = resolvePortalHomeHref(workspace);
    return `${home}${home.includes('?') ? '&' : '?'}portalError=forbidden`;
};

const buildLowBalanceAlert = (workspace) => {
    if (!workspace?.isCompany || workspace.permissions?.canViewBalance !== true) return null;
    const balance = safeNumber(workspace.entity.balance);
    const creditLimit = safeNumber(workspace.entity.creditLimit);
    if (balance < 0) {
        return {
            tone: 'danger',
            title: 'الرصيد تحت الصفر',
            copy: `رصيد ${workspace.entity.name} حالياً ${balance.toFixed(2)} LYD. راجع الإيداع أو كشف الحساب قبل تنفيذ عمليات جديدة.`,
        };
    }
    if (creditLimit > 0 && balance <= creditLimit * 0.1) {
        return {
            tone: 'warning',
            title: 'الرصيد يقترب من الحد',
            copy: `المتبقي ${balance.toFixed(2)} LYD من حد ${creditLimit.toFixed(2)} LYD. يُفضّل تمويل الحساب من طلب الإيداع.`,
        };
    }
    if (creditLimit <= 0 && balance < 50) {
        return {
            tone: 'warning',
            title: 'الرصيد منخفض',
            copy: `الرصيد الحالي ${balance.toFixed(2)} LYD. أرسل طلب إيداع حتى لا تتوقف عمليات الفريق.`,
        };
    }
    return null;
};

module.exports = { resolvePortalHomeHref, forbiddenRedirectPath, buildLowBalanceAlert };
