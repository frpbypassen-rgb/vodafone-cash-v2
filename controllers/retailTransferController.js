'use strict';
const { buildHubRenderContext } = require('../services/clientHubContextService');
const { SERVICE_CATALOG, STATUS_META, findServiceByToken } = require('../services/portalWorkspace/catalog');
const { canPostPortalTransfer } = require('../services/portalWorkspace/access');
const Transaction = require('../models/Transaction');
const business = require('./clientWorkspaceController');
const { parseTransferMessage } = require('../utils/smartTransferParser');

const customerOwnership = (ctx) => {
    if (ctx.isSubAccount && ctx.account._id) return { subAccountId: ctx.account._id };
    const identifier = ctx.account.phone || ctx.account.webUsername;
    if (!identifier) throw new Error('CUSTOMER_IDENTITY_REQUIRED');
    return { userId: identifier, companyId: null, subAccountId: null };
};

function presentation(ctx, page, token) {
    const service = findServiceByToken(token);
    const canTransfer = canPostPortalTransfer(ctx.accountType, ctx.account);
    return {
        ...ctx,
        page,
        workspace: {
            type: 'customer',
            isCompany: false,
            isAgent: false,
            isRetail: true,
            entity: ctx.account,
            actor: ctx.account,
            permissions: { canTransfer, canViewBalance: true, canInternalTransfer: canTransfer },
        },
        serviceCatalog: SERVICE_CATALOG.map((item) => ({
            ...item,
            rate: Number(ctx.serviceRates[item.key] || 0),
        })),
        servicePage: { selectedService: service?.key || 'vodafone', isolated: true },
        selectedService: service,
        statusMeta: STATUS_META,
        transferHub: { suggestedReasons: [], recentOperations: [] },
    };
}

const renderPage = (page) => async (req, res, next) => {
    try {
        const ctx = await buildHubRenderContext(req);
        if (!ctx) return business.renderPage(page)(req, res, next);
        const data = presentation(ctx, page, req.params?.serviceKey || req.query?.service);
        if (page === 'services' && req.query?.service) {
            const service = findServiceByToken(req.query.service);
            if (service) return res.redirect('/client/services/' + service.slug);
        }
        if (page === 'service_workbench' && !data.selectedService)
            return res.status(404).send('الخدمة غير موجودة.');
        if (page !== 'services' && !data.workspace.permissions.canTransfer)
            return res.status(403).send('لا يملك الحساب صلاحية إنشاء التحويلات.');
        if (page === 'service_workbench') {
            data.transferHub.recentOperations = await Transaction.find({
                ...customerOwnership(ctx),
                transferType: data.selectedService.key,
                status: { $nin: ['deposit', 'deposit_pending', 'deduction'] },
            })
                .select('customId status amount accountName vodafoneNumber accountNumber createdAt')
                .sort({ createdAt: -1 })
                .limit(5)
                .lean();
        }
        return res.render('client/retail_transfers', data);
    } catch (error) {
        if (typeof next === 'function') return next(error);
        return res.status(503).send('تعذر تحميل التحويلات. أعد المحاولة.');
    }
};

const parseMessage = async (req, res) => {
    const ctx = await buildHubRenderContext(req);
    if (!ctx) return business.parseSmartTransferMessage(req, res);
    if (!canPostPortalTransfer(ctx.accountType, ctx.account))
        return res.status(403).json({ success: false, error: 'لا يملك الحساب صلاحية التحويل.' });
    const message = String(req.body?.message || '').trim();
    if (message.length < 3 || message.length > 2000)
        return res.status(400).json({ success: false, error: 'أدخل رسالة واحدة لا تتجاوز ٢٠٠٠ حرف.' });
    const parsed = parseTransferMessage(message);
    if (parsed.ready && (!parsed.serviceKey || parsed.serviceKey === 'vodafone')) {
        const now = new Date();
        const filter = {
            ...customerOwnership(ctx),
            transferType: 'vodafone',
            vodafoneNumber: parsed.phone,
            amount: parsed.amountEGP,
            createdAt: { $gte: new Date(now.getTime() - 86400000), $lte: now },
        };
        const [pending, completed] = await Promise.all([
            Transaction.exists({ ...filter, status: { $in: ['pending', 'processing', 'accepted'] } }),
            Transaction.exists({ ...filter, status: 'completed' }),
        ]);
        parsed.duplicateCheck = {
            detected: Boolean(pending || completed),
            pending: Boolean(pending),
            completed: Boolean(completed),
            windowHours: 24,
        };
    }
    return res.json({ success: true, parsed });
};
module.exports = { renderPage, parseMessage, presentation, customerOwnership };
