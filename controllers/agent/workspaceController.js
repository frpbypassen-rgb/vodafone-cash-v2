'use strict';

const workspaceService = require('../../services/agentPortalWorkspaceService');

const renderPage = (page) => async (req, res, next) => {
    try {
        const context = await workspaceService.loadPageContext(req, page);
        return res.render('agent/workspace', context);
    } catch (error) {
        if (error.message === 'NOT_BUSINESS_PORTAL' && typeof next === 'function') return next();
        if (error.message === 'FORBIDDEN_PAGE')
            return res.status(403).send('هذه الصفحة غير متاحة لصلاحيات حساب الوكيل.');
        if (['SERVICE_NOT_FOUND', 'CUSTOMER_NOT_FOUND'].includes(error.message))
            return res.status(404).send('المورد المطلوب غير موجود.');
        console.error('[Agent Portal] page failed:', error.message);
        return res.status(error.statusCode || 500).send('تعذر تحميل صفحة الوكيل.');
    }
};

module.exports = { renderPage };
