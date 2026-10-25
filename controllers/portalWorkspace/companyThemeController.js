const { redirectWithMessage } = require('./common');
('use strict');
const { loadCompanyAccess } = require('../../services/companyAccessService');
const { normalizeCompanyTheme, buildThemePreferenceUpdate } = require('../../utils/companyPortalTheme');
const ClientEmployee = require('../../models/ClientEmployee');

exports.postCompanyTheme = async (req, res) => {
    try {
        const ctx = await loadCompanyAccess(req);
        const theme = normalizeCompanyTheme(req.body?.theme);
        if (!theme) {
            if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                return res.status(400).json({ success: false, error: 'INVALID_THEME' });
            }
            return redirectWithMessage(res, '/client/settings', 'settingsError', 'theme');
        }
        req.session.companyTheme = theme;
        await ClientEmployee.updateOne(
            { _id: ctx.account._id, companyId: ctx.companyId },
            { $set: buildThemePreferenceUpdate(theme) }
        );
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.json({ success: true, theme });
        }
        return redirectWithMessage(res, req.body.returnTo || '/client/settings', 'settingsSuccess', 'theme');
    } catch (error) {
        const status = error.statusCode || 403;
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(status).json({ success: false, error: error.code || 'FORBIDDEN' });
        }
        return redirectWithMessage(res, '/client/settings', 'settingsError', 'forbidden');
    }
};
