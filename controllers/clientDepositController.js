'use strict';

const User = require('../models/User');
const clientDepositRequestService = require('../services/clientDepositRequestService');

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
        const user = await loadDirectClient(req);
        if (!user) return res.redirect('/client/dashboard?portalError=forbidden');

        return res.render('client/deposits', {
            user,
            account: user,
            accountType: req.session.accountType
        });
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
        return res.status(error.status || 500).json({ success: false, error: error.message || 'تعذر تحميل طلبات الإيداع.' });
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

        req.app.get('io')?.emit('support:ticket-updated', { source: 'client_deposit_request' });
        return res.status(201).json({
            success: true,
            request,
            message: 'تم إرسال طلب الإيداع للإدارة للمراجعة.'
        });
    } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message || 'تعذر إرسال طلب الإيداع.' });
    }
};
