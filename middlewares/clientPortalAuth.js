'use strict';

const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');
const { tenantMode } = require('./tenantResolver');

const matchesTenant = (req, account) =>
    tenantMode() !== 'multi' ||
    Boolean(req.tenant?._id && String(account?.tenantId || '') === String(req.tenant._id));

const wantsJson = (req) =>
    req.xhr ||
    String(req.path || '').startsWith('/api/') ||
    String(req.headers?.accept || '').includes('application/json');

const endUnauthorizedClientSession = (req, res) => {
    const sendUnauthorized = () => {
        if (wantsJson(req)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        return res.redirect('/login?portal=client');
    };

    if (!req.session) return sendUnauthorized();
    // A browser can keep an old client tab open while the same cookie is now
    // authenticated as an administrator or executor. Client background polls
    // must never destroy that other portal's valid session. Only destroy a
    // session that actually claims to be a client session and then fails the
    // account/status validation above.
    if (!req.session.isClientLoggedIn || !req.session.clientId) return sendUnauthorized();
    return req.session.destroy(sendUnauthorized);
};

const isActiveClientSession = async (req) => {
    if (!req.session?.isClientLoggedIn || !req.session.clientId) return false;

    if (req.session.accountType === 'company') {
        const employee = await ClientEmployee.findById(req.session.clientId)
            .select('status companyId sessionVersion mustChangePassword')
            .lean();
        if (!employee || employee.status !== 'active') return false;
        if (Number(employee.sessionVersion || 0) !== Number(req.session.clientSessionVersion || 0)) {
            return false;
        }

        const company = await ClientCompany.findById(employee.companyId).select('status').lean();
        req.companyMustChangePassword = employee.mustChangePassword === true;
        req.companyEmployee = employee;
        return Boolean(company && company.status === 'active');
    }

    if (req.session.accountType === 'sub_client') {
        const subAccount = await SubAccount.findById(req.session.clientId)
            .select('status sessionVersion')
            .lean();
        if (!subAccount || subAccount.status !== 'active') return false;
        return Number(subAccount.sessionVersion || 0) === Number(req.session.clientSessionVersion || 0);
    }

    if (req.session.accountType === 'agent_staff') {
        const employee = await AgentEmployee.findById(req.session.clientId)
            .select('status agentId sessionVersion tenantId')
            .lean();
        if (!employee || employee.status !== 'active') return false;
        if (!matchesTenant(req, employee)) return false;
        if (Number(employee.sessionVersion || 0) !== Number(req.session.clientSessionVersion || 0))
            return false;

        const agent = await User.findById(employee.agentId).select('status role tenantId').lean();
        return Boolean(
            agent && agent.status === 'active' && agent.role === 'agent' && matchesTenant(req, agent)
        );
    }

    const user = await User.findById(req.session.clientId).select('status sessionVersion tenantId').lean();
    if (!user || user.status !== 'active') return false;
    if (!matchesTenant(req, user)) return false;
    return Number(user.sessionVersion || 0) === Number(req.session.clientSessionVersion || 0);
};

const requireClientAuth = async (req, res, next) => {
    try {
        // The mandatory MFA page uses one shared completion flow. If an
        // executor reaches the customer fallback URL after enrolment, return
        // it to its own dashboard instead of ending the valid session.
        if (req.session?.isExecutorLoggedIn && req.session?.executorId) {
            if (wantsJson(req)) return endUnauthorizedClientSession(req, res);
            return res.redirect('/executor-portal/dashboard');
        }
        if (req.session?.mfaEnrollmentRequired) {
            if (wantsJson(req))
                return res.status(403).json({
                    success: false,
                    code: 'MFA_ENROLLMENT_REQUIRED',
                    error: 'أكمل إعداد التحقق الإضافي قبل متابعة العمل.',
                });
            return res.redirect('/security/mfa-enroll');
        }
        if (!(await isActiveClientSession(req))) return endUnauthorizedClientSession(req, res);
        if (req.session.accountType === 'company' && req.companyMustChangePassword) {
            const path = String(req.path || '');
            const allowed =
                path === '/security' ||
                path === '/settings/password' ||
                path === '/logout' ||
                path === '/profile-photo';
            if (!allowed) {
                if (wantsJson(req)) {
                    return res.status(403).json({ success: false, error: 'MUST_CHANGE_PASSWORD' });
                }
                return res.redirect('/client/security?settingsError=must_change');
            }
        }
        return next();
    } catch (_error) {
        return endUnauthorizedClientSession(req, res);
    }
};

module.exports = { requireClientAuth, isActiveClientSession, endUnauthorizedClientSession };
