const { cleanText } = require('./common');
('use strict');
const businessPortalService = require('../../services/businessPortalService');
const { loadWalletHubAccount, buildHubRenderContext } = require('../../services/clientHubContextService');
const Transaction = require('../../models/Transaction');
const { presentClientVisibleReceipts } = require('../../services/clientReceiptService');
const { assertCompanyOwnsProofTransaction } = require('../../services/clientProofAccessService');
const { customerNoteFromTransaction } = require('../../utils/transactionNotes');
const { sanitizeStatementText } = require('../../utils/accountStatementPrivacy');
const { parseTransferMessage } = require('../../utils/smartTransferParser');
const { findCompanyDuplicate } = require('../../services/smartTransferReviewService');
const { logAction } = require('../../services/auditService');
const businessPortalAssistantService = require('../../services/businessPortalAssistantService');

exports.renderPage = (page) => async (req, res, next) => {
    if (req.session?.accountType !== 'company')
        return require('../agent/workspaceController').renderPage(page)(req, res, next);
    try {
        const context = await businessPortalService.loadPageContext(req, page);
        return res.render('company/workspace', context);
    } catch (error) {
        if (error.message === 'NOT_BUSINESS_PORTAL' && typeof next === 'function') return next();
        if (error.message === 'FORBIDDEN_PAGE') {
            return businessPortalService.redirectForbiddenPage(req, res);
        }
        if (error.message === 'SERVICE_NOT_FOUND') return res.redirect('/client/services');
        if (error.message === 'CUSTOMER_NOT_FOUND')
            return res.status(404).redirect('/client/customers?customerError=notfound');
        console.error(`[Business Portal] ${page} render failed:`, error.message);
        return res.redirect('/client/logout');
    }
};

exports.getCurrentRates = async (req, res) => {
    try {
        const hub = await loadWalletHubAccount(req);
        if (hub) {
            const context = await buildHubRenderContext(req);
            res.set('Cache-Control', 'no-store');
            return res.json({
                success: true,
                serviceRates: context?.serviceRates || {},
                updatedAt: null,
            });
        }
        const workspace = await businessPortalService.resolveWorkspace(req);
        const { serviceRates, ratesUpdatedAt } = await businessPortalService.getSettingsAndRates(
            workspace,
            req.app
        );
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, serviceRates, updatedAt: ratesUpdatedAt || null });
    } catch (error) {
        const statusCode = error.statusCode === 401 ? 401 : 500;
        console.error('[Business Portal] current rates failed:', error.message);
        return res.status(statusCode).json({
            success: false,
            error: statusCode === 401 ? 'انتهت الجلسة. سجل الدخول مرة أخرى.' : 'تعذر تحديث أسعار الصرف.',
        });
    }
};

exports.getTransactionDetails = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        const ownership = await businessPortalService.ownershipFilter(workspace, 'details');
        const conditions = [ownership, { _id: req.params.id }];
        if (workspace.forceToday) {
            const range = businessPortalService.resolveDateRange({}, { forceToday: true });
            conditions.push({ createdAt: { $gte: range.start, $lte: range.end } });
        }
        const transaction = await Transaction.findOne({ $and: conditions }).lean();
        if (!transaction) return res.status(404).json({ success: false, error: 'العملية غير موجودة.' });
        if (workspace.isCompany) {
            assertCompanyOwnsProofTransaction(
                {
                    companyId: workspace.entity._id,
                    status: workspace.actor.status || 'active',
                },
                transaction
            );
        }
        const receipts = presentClientVisibleReceipts(transaction);
        const service = businessPortalService.SERVICE_CATALOG.find(
            (item) => item.key === transaction.transferType
        );

        return res.json({
            success: true,
            transaction: {
                id: transaction._id,
                customId: transaction.customId,
                status: transaction.status,
                statusLabel:
                    businessPortalService.STATUS_META[transaction.status]?.label || transaction.status,
                transferType: transaction.transferType,
                serviceLabel: service?.label || transaction.transferType,
                amount: transaction.amount,
                amountCurrencyLabel:
                    transaction.serviceDetails?.amountCurrency === 'XOF'
                        ? 'سيفا'
                        : service?.amountCurrencyLabel || 'EGP',
                costLYD: transaction.costLYD,
                exchangeRate: transaction.exchangeRate,
                rateDirection:
                    transaction.serviceDetails?.rateDirection || service?.rateDirection || 'lyd_to_source',
                destination: transaction.vodafoneNumber || transaction.accountNumber,
                accountName: transaction.accountName,
                accountNumber: transaction.accountNumber,
                serviceDetails: transaction.serviceDetails || {},
                notes: customerNoteFromTransaction(transaction),
                customerNotes: customerNoteFromTransaction(transaction),
                employeeName: transaction.employeeName || '',
                customerName: transaction.subAccountName || '',
                cancellationNumber: transaction.cancellationNumber || '',
                cancellationReason: sanitizeStatementText(
                    transaction.cancellationReason,
                    transaction.cancellationReason ? 'تم إلغاء العملية' : ''
                ),
                createdAt: transaction.createdAt,
                updatedAt: transaction.updatedAt,
                hasProof: receipts.hasProof,
                receiptImages: receipts.receiptImages,
                hasIdentityImage: Boolean(transaction.idCardImage),
            },
        });
    } catch (error) {
        console.error('[Business Portal] transaction details failed:', error.message);
        return res.status(500).json({ success: false, error: 'تعذر تحميل تفاصيل العملية.' });
    }
};

exports.parseSmartTransferMessage = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        if (!workspace.permissions.canTransfer) {
            return res.status(403).json({ success: false, error: 'ليس لديك صلاحية إنشاء التحويلات.' });
        }

        const message = cleanText(req.body.message, 2000);
        if (message.length < 3) {
            return res.status(400).json({ success: false, error: 'أدخل رسالة التحويل أولاً.' });
        }

        const parsed = parseTransferMessage(message);
        parsed.duplicateCheck = await findCompanyDuplicate(workspace, parsed);
        return res.json({ success: true, parsed });
    } catch (error) {
        const statusCode = error.statusCode === 401 ? 401 : 500;
        console.error('[Business Portal] smart transfer parse failed:', error.message);
        return res.status(statusCode).json({
            success: false,
            error: statusCode === 401 ? 'انتهت الجلسة. سجل الدخول مرة أخرى.' : 'تعذر تحليل رسالة التحويل.',
        });
    }
};

exports.askBusinessAssistant = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        const question = cleanText(req.body.question, 800);
        const intent = businessPortalAssistantService.classifyQuestion(question);
        const result = await businessPortalAssistantService.answer({ workspace, question });
        // Never retain the question text: it may contain a private number or a
        // secret. The audit trail stores only the safe intent classification.
        logAction({
            action: 'BUSINESS_ASSISTANT_QUERY',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: workspace.entity._id,
            targetModel: workspace.entityModel,
            metadata: { portal: workspace.type, intent, safeMode: true },
            success: true,
            severity: intent === 'blocked_sensitive' ? 'warning' : 'info',
        }).catch(() => {});
        return res.json(result);
    } catch (error) {
        const statusCode = error.statusCode === 401 ? 401 : 500;
        console.error('[Business Portal] assistant query failed:', error.message);
        return res.status(statusCode).json({
            success: false,
            error:
                statusCode === 401
                    ? 'انتهت الجلسة. سجل الدخول مرة أخرى.'
                    : 'تعذر تشغيل المساعد الآن. حاول مرة أخرى.',
        });
    }
};
