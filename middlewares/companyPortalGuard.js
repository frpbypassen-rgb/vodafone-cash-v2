'use strict';

const {
    loadCompanyAccess,
    assertCapability,
    canAccessCompanyPage
} = require('../services/companyAccessService');
const { forbiddenRedirectPath } = require('../services/businessPortalService');

const deny = (req, res, code = 'FORBIDDEN', status = 403) => {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(status).json({ success: false, error: code });
    }
    const home = req.companyAccess
        ? forbiddenRedirectPath({
            isCompany: true,
            persona: req.companyAccess.access.accountant
                ? 'accountant'
                : (req.companyAccess.access.manager ? 'manager' : 'employee')
        })
        : '/client/services?portalError=forbidden';
    return res.status(status).redirect(home);
};

const attachCompanyAccess = async (req, res, next) => {
    try {
        req.companyAccess = await loadCompanyAccess(req);
        return next();
    } catch (error) {
        return deny(req, res, error.code || 'FORBIDDEN', error.statusCode || 403);
    }
};

const requireCompanyCapability = (capability) => async (req, res, next) => {
    try {
        if (!req.companyAccess) req.companyAccess = await loadCompanyAccess(req);
        assertCapability(req.companyAccess.access, capability);
        return next();
    } catch (error) {
        return deny(req, res, error.code || 'FORBIDDEN', error.statusCode || 403);
    }
};

const requireCompanyPage = (page) => async (req, res, next) => {
    try {
        if (!req.companyAccess) req.companyAccess = await loadCompanyAccess(req);
        if (!canAccessCompanyPage(req.companyAccess.access, page)) {
            return deny(req, res, 'FORBIDDEN', 403);
        }
        return next();
    } catch (error) {
        return deny(req, res, error.code || 'FORBIDDEN', error.statusCode || 403);
    }
};

module.exports = {
    attachCompanyAccess,
    requireCompanyCapability,
    requireCompanyPage,
    deny
};
