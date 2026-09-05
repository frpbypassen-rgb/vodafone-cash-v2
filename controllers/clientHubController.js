'use strict';

const bcrypt = require('bcryptjs');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const { buildHubRenderContext, loadWalletHubAccount } = require('../services/clientHubContextService');
const { logAction } = require('../services/auditService');
const clientWorkspaceController = require('./clientWorkspaceController');

async function renderHubPage(req, res, view, extra = {}) {
    const ctx = await buildHubRenderContext(req);
    if (!ctx) return res.redirect('/login?portal=client');
    return res.render(view, { ...ctx, ...extra });
}

exports.getSettings = async (req, res) => {
    const loaded = await loadWalletHubAccount(req);
    if (!loaded) {
        return clientWorkspaceController.renderPage('settings')(req, res);
    }
    const ctx = await buildHubRenderContext(req);
    if (!ctx) return res.redirect('/login?portal=client');
    const section = String(req.query.section || 'profile').trim();
    const allowed = ['profile', 'security', 'notifications', 'appearance', 'documents'];
    return res.render('client/hub/settings', {
        ...ctx,
        activeSection: allowed.includes(section) ? section : 'profile',
        settingsSuccess: req.query.settingsSuccess || '',
        settingsError: req.query.settingsError || ''
    });
};

exports.getAccount = async (req, res) => {
    const tab = String(req.query.tab || 'operations').trim();
    const allowed = ['operations', 'deposits', 'deposits-new', 'deposits-pending', 'deposits-accepted', 'deposits-rejected', 'summary', 'export'];
    return renderHubPage(req, res, 'client/hub/account', {
        activeTab: allowed.includes(tab) ? tab : 'operations'
    });
};

exports.getTransfers = async (req, res) => {
    return renderHubPage(req, res, 'client/hub/transfers', {
        pickService: String(req.query.service || '').trim()
    });
};

exports.redirectLegacyReports = async (req, res) => {
    const ctx = await loadWalletHubAccount(req);
    if (!ctx) return res.redirect('/client/reports');
    const qs = new URLSearchParams(req.query);
    qs.set('tab', qs.get('tab') || 'operations');
    return res.redirect(`/client/account?${qs.toString()}`);
};

exports.redirectLegacyDeposits = async (req, res) => {
    const ctx = await loadWalletHubAccount(req);
    if (!ctx) return res.redirect('/client/deposits');
    return res.redirect('/client/account?tab=deposits-new');
};

exports.postChangePassword = async (req, res) => {
    const loaded = await loadWalletHubAccount(req);
    if (!loaded) return res.redirect('/login?portal=client');

    const { account, isSubAccount } = loaded;
    const Model = isSubAccount ? SubAccount : User;
    const actor = await Model.findById(account._id);
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    const passwordConfirm = String(req.body.passwordConfirm || '');

    const fail = (code) => res.redirect(`/client/settings?section=security&settingsError=${code}`);

    if (!actor || !await bcrypt.compare(currentPassword, actor.webPassword || '')) {
        return fail('current_password');
    }
    if (newPassword.length < 8 || newPassword !== passwordConfirm) {
        return fail('new_password');
    }

    actor.webPassword = newPassword;
    await actor.save();
    await logAction({
        action: 'USER_PASSWORD_CHANGED',
        req,
        performedById: actor._id,
        performedByModel: isSubAccount ? 'SubAccount' : 'User',
        performedByName: actor.name,
        targetId: actor._id,
        targetModel: isSubAccount ? 'SubAccount' : 'User',
        result: 'ناجح',
        metadata: { selfService: true, portal: 'client_hub' }
    });
    return res.redirect('/client/settings?section=security&settingsSuccess=password');
};
