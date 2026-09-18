'use strict';

const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const CompanyProfile = require('../models/CompanyProfile');
const {
    resolveCorporateRole,
    permissionsForRole,
    resolveApprovalLimit,
    isCorporatePortalEnabled,
    sameCompany
} = require('../services/corporateRoleService');

const wantsJson = (req) => (
    Boolean(req.xhr)
    || String(req.headers?.accept || '').includes('application/json')
    || String(req.originalUrl || '').startsWith('/api/corporate')
);

const deny = (req, res, status, code, message) => {
    if (wantsJson(req)) {
        return res.status(status).json({ success: false, code, error: message });
    }
    if (status === 401) return res.redirect('/login?portal=client');
    return res.status(status).render('access_denied', {
        requiredPermission: code,
        message
    });
};

const loadCorporateContext = async (req) => {
    if (!req.session?.isClientLoggedIn || !req.session.clientId) {
        const error = new Error('CORPORATE_UNAUTHORIZED');
        error.statusCode = 401;
        error.code = 'CORPORATE_UNAUTHORIZED';
        throw error;
    }
    if (req.session.accountType !== 'company') {
        const error = new Error('CORPORATE_FORBIDDEN');
        error.statusCode = 403;
        error.code = 'CORPORATE_NOT_COMPANY_SESSION';
        throw error;
    }

    const actor = await ClientEmployee.findById(req.session.clientId);
    if (!actor || actor.status !== 'active') {
        const error = new Error('CORPORATE_UNAUTHORIZED');
        error.statusCode = 401;
        error.code = 'CORPORATE_INVALID_ACTOR';
        throw error;
    }

    const company = await ClientCompany.findById(actor.companyId);
    if (!company || company.status !== 'active') {
        const error = new Error('CORPORATE_FORBIDDEN');
        error.statusCode = 403;
        error.code = 'CORPORATE_INVALID_COMPANY';
        throw error;
    }

    const profile = await CompanyProfile.findOne({ companyId: company._id });
    if (!isCorporatePortalEnabled({ actor, company, profile })) {
        const error = new Error('CORPORATE_FORBIDDEN');
        error.statusCode = 403;
        error.code = 'CORPORATE_PORTAL_DISABLED';
        throw error;
    }

    const role = resolveCorporateRole(actor);
    const permissions = permissionsForRole(role);
    const approvalLimit = resolveApprovalLimit(actor, profile || company.corporatePortal || {});

    return {
        actor,
        company,
        profile,
        role,
        permissions,
        approvalLimit,
        companyId: company._id,
        tenantId: (req.tenant && req.tenant._id) || actor.tenantId || company.tenantId || undefined
    };
};

const requireCorporateAuth = async (req, res, next) => {
    try {
        req.corporate = await loadCorporateContext(req);
        return next();
    } catch (error) {
        const status = error.statusCode || 403;
        const code = error.code || 'CORPORATE_FORBIDDEN';
        const message = status === 401
            ? 'غير مصرح بالوصول، يرجى تسجيل الدخول.'
            : 'ليس لديك صلاحية للوصول إلى بوابة الشركات.';
        return deny(req, res, status, code, message);
    }
};

const requireCorporateRole = (roles = []) => (req, res, next) => {
    const allowed = Array.isArray(roles) ? roles : [roles];
    const current = req.corporate?.role;
    if (!current || !allowed.includes(current)) {
        return deny(req, res, 403, 'CORPORATE_ROLE_DENIED', 'هذا المسار غير متاح لدورك الحالي.');
    }
    return next();
};

const requireCorporatePermission = (permission) => (req, res, next) => {
    if (req.corporate?.permissions?.[permission] === true) return next();
    return deny(req, res, 403, 'CORPORATE_PERMISSION_DENIED', 'ليس لديك الصلاحية المطلوبة.');
};

const requireSameCompany = (req, res, next) => {
    const scopedId = req.corporate?.companyId;
    if (!scopedId) {
        return deny(req, res, 403, 'CORPORATE_COMPANY_MISSING', 'تعذر تحديد شركة الجلسة.');
    }

    const candidates = [
        req.params.companyId,
        req.body?.companyId,
        req.query?.companyId
    ].filter((value) => value !== undefined && value !== null && String(value).trim() !== '');

    if (candidates.some((value) => !sameCompany(value, scopedId))) {
        return deny(req, res, 403, 'CORPORATE_COMPANY_MISMATCH', 'لا يمكن الوصول إلى بيانات شركة أخرى.');
    }

    req.corporate.companyId = scopedId;
    return next();
};

const allowCorporateCamera = (_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(self)');
    return next();
};

const detectCorporateView = (req) => {
    const forced = String(req.query.view || '').toLowerCase();
    if (forced === 'mobile' || forced === 'desktop') {
        if (req.session) req.session.corporateView = forced;
        return forced;
    }
    if (req.session?.corporateView === 'mobile' || req.session?.corporateView === 'desktop') {
        return req.session.corporateView;
    }
    const ua = String(req.headers['user-agent'] || '');
    return /mobile|android|iphone|ipad|ipod|phone/i.test(ua) ? 'mobile' : 'desktop';
};

module.exports = {
    loadCorporateContext,
    requireCorporateAuth,
    requireCorporateRole,
    requireCorporatePermission,
    requireSameCompany,
    allowCorporateCamera,
    detectCorporateView,
    wantsJson
};
