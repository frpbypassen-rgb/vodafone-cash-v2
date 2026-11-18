'use strict';

const User = require('../models/User');
const { loadWalletHubAccount } = require('../services/clientHubContextService');
const clientDepositRequestService = require('../services/clientDepositRequestService');
const { emitSupportTicketUpdate } = require('../services/supportRealtimeService');

const sendDepositError = (res, error, fallback) => {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : 500;
    const message = status < 500 && typeof error?.message === 'string' && error.message
        ? error.message
        : fallback;
    return res.status(status).json({ success: false, error: message });
};

async function loadDirectClient(req) {
    if (req.session.accountType !== 'user') return null;
    const user = await User.findById(req.session.clientId);
    if (!user || user.status !== 'active' || user.role === 'agent') return null;
    return user;
}

exports.getDepositsPage = async (req, res) => {
    try {
        if (req.session.accountType === 'company') {
            return res.redirect('/client/company/deposits');
        }
        const hub = await loadWalletHubAccount(req);
        if (hub) {
            const tab = hub.isSubAccount ? 'operations' : 'deposits-new';
            return res.redirect(`/client/account?tab=${tab}`);
        }
        const user = await loadDirectClient(req);
        if (!user) return res.redirect('/client/dashboard?portalError=forbidden');

        return res.redirect('/client/account?tab=deposits-new');
    } catch (error) {
        return res.redirect('/client/dashboard');
    }
};

exports.getDepositRequests = async (req, res) => {
    try {
        const user = await loadDirectClient(req);
        if (!user) return res.status(403).json({ success: false, error: 'غير مصرح.' });

        const requests = await clientDepositRequestService.listClientDepositRequests({ client: user });
        return res.json({ success: true, requests, balance: Number(user.balance || 0) });
    } catch (error) {
        return sendDepositError(res, error, 'تعذر تحميل طلبات الإيداع.');
    }
};

exports.postDepositRequest = async (req, res) => {
    try {
        const user = await loadDirectClient(req);
        if (!user) return res.status(403).json({ success: false, error: 'غير مصرح.' });

        const request = await clientDepositRequestService.createClientDepositRequest({
            client: user,
            amount: req.body?.amount,
            note: req.body?.note
        });

        emitSupportTicketUpdate(req, { source: 'client_deposit_request' });
        return res.status(201).json({
            success: true,
            request,
            message: 'تم إرسال طلب الإيداع للإدارة للمراجعة.'
        });
    } catch (error) {
        return sendDepositError(res, error, 'تعذر إرسال طلب الإيداع.');
    }
};
