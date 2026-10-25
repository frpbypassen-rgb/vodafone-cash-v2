'use strict';
const express = require('express');

const router = express.Router();

const User = require('../../models/User');

const ClientEmployee = require('../../models/ClientEmployee');

const SubAccount = require('../../models/SubAccount');

const AgentEmployee = require('../../models/AgentEmployee');

const { normalizeCompanyTheme } = require('../../utils/companyPortalTheme');

const { normalizeClientTheme, buildClientThemePreferenceUpdate } = require('../../utils/clientPortalTheme');

const { requireClientAuth } = require('../../middlewares/clientPortalAuth');

router.post('/api/theme', requireClientAuth, async (req, res) => {
    if (req.session.accountType === 'company') {
        const theme = normalizeCompanyTheme(req.body?.theme);
        if (!theme) {
            return res.status(400).json({ success: false, error: 'INVALID_THEME' });
        }
        req.session.companyTheme = theme;
        try {
            await ClientEmployee.updateOne(
                { _id: req.session.clientId, companyId: { $exists: true } },
                { $set: { 'preferences.companyTheme': theme } }
            );
        } catch (_error) {
            /* session still holds the preference */
        }
        return res.json({ success: true, theme });
    }
    const theme = normalizeClientTheme(req.body?.theme);
    if (!theme) {
        return res.status(400).json({ success: false, error: 'INVALID_THEME' });
    }
    req.session.clientTheme = theme;
    const Model =
        req.session.accountType === 'agent_staff'
            ? AgentEmployee
            : req.session.accountType === 'sub_client'
              ? SubAccount
              : User;
    try {
        await Model.updateOne(
            { _id: req.session.clientId },
            { $set: buildClientThemePreferenceUpdate(theme) }
        );
    } catch (_error) {
        /* session still holds the preference */
    }
    return res.json({ success: true, theme });
});

module.exports = router;
