const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const Settings = require('../models/Settings');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const ClientEmployee = require('../models/ClientEmployee');
const SubAccount = require('../models/SubAccount');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const {
    updateBalanceWithLedger,
    isMongoTransactionFallbackError,
    requiresMongoTransactions,
    financialTransactionsUnavailableError
} = require('../services/walletService');
const { createClientNotifications, notifyBalanceAdjustment } = require('../services/clientNotificationService');
const { createDepositReceiptProof } = require('../services/depositReceiptService');
const { voidBalanceAdjustment } = require('../services/balanceAdjustmentService');
const { logAction } = require('../services/auditService');
const { loadAdminAccountDirectory } = require('../services/adminAccountDirectoryService');
const {
    SERVICE_RATE_KEYS,
    COMPANY_RATE_INPUT_FIELDS,
    COMPANY_RATE_MODES,
    getAdminRateServices,
    getCompanyRateConfig,
    buildCompanyRateOffsets
} = require('../utils/rateHelper');
const {
    CODE_LENGTHS,
    expectedUserCodeLength,
    validateAccountCode,
    ensureAccountCodeAvailable,
    reserveAccountCode,
    releaseAccountCodeReservation
} = require('../services/accountCodeService');
const {
    buildIntegrationDocumentData,
    generateAccountIntegrationPdf,
    resolvePublicApiOrigin
} = require('../services/accountIntegrationPdfService');

const accountCodeErrorQuery = (error) => {
    if (error.message === 'ACCOUNT_CODE_DUPLICATE') return 'duplicate';
    if (error.message.startsWith('ACCOUNT_CODE_INVALID_')) return 'invalid';
    return 'error';
};

const visibleAccountFilter = { status: { $ne: 'deleted' } };

const createIntegrationApiKey = () => crypto.randomBytes(24).toString('hex');

const ensureIntegrationApiKey = async (account, field) => {
    if (account[field]) return account[field];

    for (let attempt = 0; attempt < 3; attempt += 1) {
        account[field] = createIntegrationApiKey();
        try {
            await account.save();
            return account[field];
        } catch (error) {
            if (error && error.code === 11000 && attempt < 2) continue;
            throw error;
        }
    }

    throw new Error('INTEGRATION_KEY_PROVISION_FAILED');
};

const safeIntegrationFileReference = (value) => String(value || 'account')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 40) || 'account';

const sendIntegrationDocument = async (req, res, { account, accountType }) => {
    const apiKey = await ensureIntegrationApiKey(account, accountType === 'agent' ? 'apiToken' : 'token');
    const settings = await Settings.findOne({}).lean() || {};
    const documentData = buildIntegrationDocumentData({
        account,
        accountType,
        apiKey,
        apiOrigin: resolvePublicApiOrigin(req),
        serviceRates: getCompanyRateConfig(account, settings).effectiveRates,
        generatedAt: new Date()
    });
    const pdf = await generateAccountIntegrationPdf(req.app, documentData);
    const fileReference = safeIntegrationFileReference(documentData.account.accountCode);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.length);
    res.setHeader('Content-Disposition', `attachment; filename="api-integration-${accountType}-${fileReference}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');

    await logAction({
        action: 'MERCHANT_API_DOCUMENT_EXPORTED',
        req,
        performedById: req.session.adminId,
        performedByModel: 'Admin',
        performedByName: req.session.adminName || req.session.adminUsername || 'الإدارة',
        targetId: account._id,
        targetModel: accountType === 'agent' ? 'User' : 'ClientCompany',
        result: 'نجاح',
        metadata: {
            accountType,
            accountName: account.name,
            accountCode: documentData.account.accountCode,
            apiBasePath: documentData.api.basePath
        }
    }).catch(() => {});

    return res.end(pdf);
};

const saveAccountCode = async ({ Model, modelName, id, code, expectedLength }) => {
    const normalized = String(code || '').trim();
    const current = { modelName, id };
    const existing = await Model.findById(id).select('accountCode').lean();
    if (!existing) throw new Error('ACCOUNT_NOT_FOUND');

    if (!normalized) {
        await Model.findByIdAndUpdate(id, { $unset: { accountCode: 1 } });
        await releaseAccountCodeReservation(current);
        return;
    }

    const validCode = validateAccountCode(normalized, expectedLength);
    await ensureAccountCodeAvailable(validCode, current);
    await reserveAccountCode(validCode, current);

    try {
        await Model.findByIdAndUpdate(id, { accountCode: validCode }, { runValidators: true });
    } catch (error) {
        if (existing.accountCode) {
            await reserveAccountCode(existing.accountCode, current).catch(() => {});
        } else {
            await releaseAccountCodeReservation(current).catch(() => {});
        }
        throw error;
    }
};

const deleteMetadata = (req) => ({
    deletedAt: new Date(),
    deletedBy: req.session.adminId || req.session.adminName || 'admin'
});

const releaseSubAccountCodes = async (subAccounts) => {
    await Promise.all(subAccounts.map((sub) => (
        releaseAccountCodeReservation({ modelName: 'SubAccount', id: sub._id }).catch(() => {})
    )));
};

const deletedAccountUpdate = (req) => ({
    $set: { status: 'deleted', refreshToken: null, ...deleteMetadata(req) },
    $unset: { accountCode: 1, agentCode: 1, otpCode: 1, otpExpires: 1 }
});

const createManualAdjustmentId = (amount) => {
    const prefix = amount > 0 ? 'DEP' : 'DED';
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

const runDbTransaction = async (callback) => {
    let session;
    try {
        session = await mongoose.startSession();
        session.startTransaction();
        const result = await callback(session);
        await session.commitTransaction();
        return result;
    } catch (error) {
        if (session) {
            try { await session.abortTransaction(); } catch (_) {}
        }
        const message = error.message || '';
        if (
            isMongoTransactionFallbackError(error) ||
            (message.includes('Transaction') && message.includes('not supported'))
        ) {
            if (requiresMongoTransactions()) {
                throw financialTransactionsUnavailableError(error);
            }
            return callback(null);
        }
        if (!session && requiresMongoTransactions()) {
            throw financialTransactionsUnavailableError(error);
        }
        throw error;
    } finally {
        if (session) session.endSession();
    }
};

const balanceErrorQuery = (error) => {
    if (error.message === 'INSUFFICIENT_BALANCE') return 'insufficient';
    if (error.message === 'ACCOUNT_NOT_FOUND') return 'notfound';
    return 'failed';
};

const attachBalanceAdjustmentReceipt = async ({ tx, account, amount, balanceAfter, notes, session }) => {
    if (!tx || !account) return null;

    const proofId = createDepositReceiptProof({
        customId: tx.customId,
        accountName: account.name || account.webUsername || account.phone || 'Client account',
        accountCode: account.accountCode || account.webUsername || account.phone || '',
        amount: Math.abs(amount),
        balanceAfter,
        notes,
        createdAt: tx.createdAt,
        type: amount >= 0 ? 'deposit' : 'deduction'
    });

    tx.proofImage = proofId;
    tx.proofImages = [proofId];
    await tx.save(session ? { session } : {});
    return proofId;
};

const reversibleSettlementIds = async ({ transactions, entityModel, entityId }) => {
    const candidates = transactions
        .filter((tx) => ['deposit', 'deduction'].includes(tx.status) && tx.customId)
        .map((tx) => tx.customId);
    if (!candidates.length) return [];

    const ledgers = await Ledger.find({
        transactionId: { $in: candidates },
        entityModel,
        entityId,
        type: { $in: ['DEPOSIT', 'DEDUCTION'] }
    }).select('transactionId').lean();
    return [...new Set(ledgers.map((entry) => entry.transactionId))];
};

router.get('/clients', requireAuth, async (req, res) => {
    try {
        const directory = await loadAdminAccountDirectory(
            { User, ClientCompany, SubAccount },
            req.query
        );
        res.render('clients', {
            ...directory,
            query: req.query,
            isMaster: req.session.adminRole === 'master'
        });
    } catch (e) {
        console.error('[clients] خطأ في جلب بيانات العملاء:', e.message);
        res.status(500).send('خطأ داخلي في الخادم');
    }
});

router.get('/user/:id', requireAuth, async (req, res) => {
    const user = await User.findOne({ _id: req.params.id, ...visibleAccountFilter });
    if (!user) return res.redirect('/clients?section=users&deleteError=notfound');
    const transactions = await Transaction.find({ userId: user.phone || user.webUsername, companyId: null }).sort({ createdAt: -1 }).limit(50);
    const reversibleSettlements = await reversibleSettlementIds({ transactions, entityModel: 'User', entityId: user._id });
    const hasSubAccounts = await SubAccount.exists({ masterType: 'user', masterId: user._id, ...visibleAccountFilter });
    res.render('user_details', {
        user,
        transactions,
        reversibleSettlements,
        accountCodeLength: expectedUserCodeLength(user, Boolean(hasSubAccounts)),
        query: req.query,
        isMaster: req.session.adminRole === 'master'
    });
});

router.get('/company/:id', requireAuth, async (req, res) => {
    const company = await ClientCompany.findOne({ _id: req.params.id, ...visibleAccountFilter });
    if (!company) return res.redirect('/clients?section=companies&deleteError=notfound');
    const [transactions, settings] = await Promise.all([
        Transaction.find({ companyId: company._id }).sort({ createdAt: -1 }).limit(50),
        Settings.findOne({}).lean()
    ]);
    const reversibleSettlements = await reversibleSettlementIds({ transactions, entityModel: 'ClientCompany', entityId: company._id });
    res.render('company_details', {
        company,
        transactions,
        reversibleSettlements,
        accountCodeLength: CODE_LENGTHS.company,
        rateServices: getAdminRateServices(),
        companyRateConfig: getCompanyRateConfig(company, settings || {}),
        query: req.query,
        isMaster: req.session.adminRole === 'master'
    });
});

router.get('/company/:id/integration-guide.pdf', requireAuth, requireMaster, async (req, res) => {
    try {
        const company = await ClientCompany.findOne({ _id: req.params.id, ...visibleAccountFilter });
        if (!company) return res.status(404).send('الحساب غير موجود.');
        return await sendIntegrationDocument(req, res, { account: company, accountType: 'company' });
    } catch (error) {
        console.error('[clients/company-integration-guide] failed:', error.message);
        if (error.code === 'PDF_BROWSER_NOT_FOUND') {
            return res.status(503).send('تعذر إنشاء ملف PDF لعدم وجود متصفح للطباعة على الخادم.');
        }
        return res.status(500).send('تعذر إنشاء وثيقة الربط.');
    }
});

router.get('/user/:id/integration-guide.pdf', requireAuth, requireMaster, async (req, res) => {
    try {
        const agent = await User.findOne({
            _id: req.params.id,
            role: 'agent',
            ...visibleAccountFilter
        }).select('+apiToken');
        if (!agent) return res.status(404).send('حساب الوكيل غير موجود.');
        return await sendIntegrationDocument(req, res, { account: agent, accountType: 'agent' });
    } catch (error) {
        console.error('[clients/agent-integration-guide] failed:', error.message);
        if (error.code === 'PDF_BROWSER_NOT_FOUND') {
            return res.status(503).send('تعذر إنشاء ملف PDF لعدم وجود متصفح للطباعة على الخادم.');
        }
        return res.status(500).send('تعذر إنشاء وثيقة الربط.');
    }
});

router.post('/user/:id/add-balance', requireAuth, async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        const notes = req.body.notes ? req.body.notes.trim() : '';
        if (!Number.isFinite(amount) || amount === 0) return res.redirect(`/user/${req.params.id}?balanceError=invalid`);

        const { user, tx, balanceAfter } = await runDbTransaction(async (session) => {
            const accountQuery = User.findById(req.params.id);
            const account = session ? await accountQuery.session(session) : await accountQuery;
            if (!account) throw new Error('ACCOUNT_NOT_FOUND');

            const customId = createManualAdjustmentId(amount);
            const type = amount > 0 ? 'DEPOSIT' : 'DEDUCTION';
            const status = amount > 0 ? 'deposit' : 'deduction';
            const description = `${amount > 0 ? 'Admin deposit' : 'Admin deduction'} for user ${account.name || account.webUsername || account.phone}`;

            const balanceOptions = { minBalance: 0, allowNegative: true };
            if (session) balanceOptions.session = session;
            const balanceResult = await updateBalanceWithLedger('User', account._id, amount, type, customId, description, balanceOptions);

            const [createdTx] = await Transaction.create([{
                userId: account.phone || account.webUsername,
                amount: Math.abs(amount),
                costLYD: 0,
                vodafoneNumber: '01000000000',
                status,
                customId,
                companyName: 'عميل فردي',
                employeeName: amount > 0 ? 'الإدارة (إيداع)' : 'الإدارة (خصم)',
                notes,
                balanceAdjustment: {
                    entityModel: 'User',
                    entityId: account._id,
                    delta: amount,
                    reversible: true
                }
            }], session ? { session } : {});

            await attachBalanceAdjustmentReceipt({
                tx: createdTx,
                account,
                amount,
                balanceAfter: balanceResult.balanceAfter,
                notes,
                session
            });

            return { user: account, tx: createdTx, balanceAfter: balanceResult.balanceAfter };
        });

        await notifyBalanceAdjustment({
            accountModel: 'User',
            account: user,
            amount,
            balanceAfter,
            customId: tx.customId,
            notes
        }).catch(() => {});
        const io = req.app && req.app.get('io');
        if (io) io.emit('update_data');

        return res.redirect(`/user/${user._id}?balanceSaved=${amount > 0 ? 'deposit' : 'deduction'}`);
    } catch (e) {
        console.error('[clients/add-balance:user] failed:', e.stack || e.message);
        return res.redirect(`/user/${req.params.id}?balanceError=${balanceErrorQuery(e)}`);
    }
});

router.post('/user/:id/toggle-status', requireAuth, requireMaster, async (req, res) => {
    const user = await User.findById(req.params.id); user.status = user.status === 'active' ? 'banned' : 'active'; await user.save(); res.redirect(`/user/${user._id}`);
});

router.post('/user/:id/delete', requireAuth, requireMaster, async (req, res) => {
    try {
        const user = await User.findOne({ _id: req.params.id, ...visibleAccountFilter }).select('_id role');
        if (!user) return res.redirect('/clients?section=users&deleteError=notfound');
        const returnSection = user.role === 'agent' ? 'agents' : 'users';

        const subAccounts = await SubAccount.find({ masterType: 'user', masterId: user._id, ...visibleAccountFilter }).select('_id').lean();
        await releaseAccountCodeReservation({ modelName: 'User', id: user._id });
        await releaseSubAccountCodes(subAccounts);

        await User.updateOne({ _id: user._id }, deletedAccountUpdate(req), { strict: false });
        if (subAccounts.length) {
            await SubAccount.updateMany(
                { _id: { $in: subAccounts.map((sub) => sub._id) } },
                deletedAccountUpdate(req),
                { strict: false }
            );
        }

        res.redirect(`/clients?section=${returnSection}&deleted=1`);
    } catch (error) {
        console.error('[clients/delete-user] خطأ في حذف حساب العميل:', error.message);
        res.redirect('/clients?section=users&deleteError=1');
    }
});

router.post('/user/:id/change-level', requireAuth, requireMaster, async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { tier: parseInt(req.body.tier) }); res.redirect(`/user/${req.params.id}`);
});

router.post('/user/:id/update-limit', requireAuth, requireMaster, async (req, res) => {
    try { const limit = Math.abs(parseFloat(req.body.creditLimit) || 0); await User.findByIdAndUpdate(req.params.id, { creditLimit: limit }); res.redirect(`/user/${req.params.id}`); } catch (e) { res.redirect('/clients?section=users'); }
});

router.post('/user/:id/update-account-code', requireAuth, requireMaster, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        const hasSubAccounts = await SubAccount.exists({ masterType: 'user', masterId: user._id });
        await saveAccountCode({
            Model: User,
            modelName: 'User',
            id: req.params.id,
            code: req.body.accountCode,
            expectedLength: expectedUserCodeLength(user, Boolean(hasSubAccounts))
        });
        if (user.role === 'agent') {
            const normalizedCode = String(req.body.accountCode || '').trim();
            if (normalizedCode) {
                await User.findByIdAndUpdate(req.params.id, { agentCode: normalizedCode }, { strict: false });
            } else {
                await User.findByIdAndUpdate(req.params.id, { $unset: { agentCode: 1 } }, { strict: false });
            }
        }
        res.redirect(`/user/${req.params.id}?codeSaved=1`);
    } catch (error) {
        res.redirect(`/user/${req.params.id}?codeError=${accountCodeErrorQuery(error)}`);
    }
});

router.post('/company/:id/add-balance', requireAuth, async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        const notes = req.body.notes ? req.body.notes.trim() : '';
        if (!Number.isFinite(amount) || amount === 0) return res.redirect(`/company/${req.params.id}?balanceError=invalid`);

        const { company, tx, balanceAfter } = await runDbTransaction(async (session) => {
            const accountQuery = ClientCompany.findById(req.params.id);
            const account = session ? await accountQuery.session(session) : await accountQuery;
            if (!account) throw new Error('ACCOUNT_NOT_FOUND');

            const customId = createManualAdjustmentId(amount);
            const type = amount > 0 ? 'DEPOSIT' : 'DEDUCTION';
            const status = amount > 0 ? 'deposit' : 'deduction';
            const description = `${amount > 0 ? 'Admin deposit' : 'Admin deduction'} for company ${account.name || account._id}`;

            const balanceOptions = { minBalance: 0, allowNegative: true };
            if (session) balanceOptions.session = session;
            const balanceResult = await updateBalanceWithLedger('ClientCompany', account._id, amount, type, customId, description, balanceOptions);

            const [createdTx] = await Transaction.create([{
                userId: 'admin',
                companyId: account._id,
                amount: Math.abs(amount),
                costLYD: 0,
                vodafoneNumber: '01000000000',
                status,
                customId,
                companyName: account.name,
                employeeName: amount > 0 ? 'الإدارة (إيداع)' : 'الإدارة (خصم)',
                notes,
                balanceAdjustment: {
                    entityModel: 'ClientCompany',
                    entityId: account._id,
                    delta: amount,
                    reversible: true
                }
            }], session ? { session } : {});

            await attachBalanceAdjustmentReceipt({
                tx: createdTx,
                account,
                amount,
                balanceAfter: balanceResult.balanceAfter,
                notes,
                session
            });

            return { company: account, tx: createdTx, balanceAfter: balanceResult.balanceAfter };
        });

        await notifyBalanceAdjustment({
            accountModel: 'ClientCompany',
            account: company,
            amount,
            balanceAfter,
            customId: tx.customId,
            notes
        }).catch(() => {});
        const io = req.app && req.app.get('io');
        if (io) io.emit('update_data');

        return res.redirect(`/company/${company._id}?balanceSaved=${amount > 0 ? 'deposit' : 'deduction'}`);
    } catch (e) {
        console.error('[clients/add-balance:company] failed:', e.stack || e.message);
        return res.redirect(`/company/${req.params.id}?balanceError=${balanceErrorQuery(e)}`);
    }
});

router.post('/transaction/:id/void-balance-adjustment', requireAuth, async (req, res) => {
    try {
        const performedBy = req.session.adminName || req.session.adminUsername || 'الإدارة';
        const result = await voidBalanceAdjustment({
            transactionId: req.params.id,
            performedBy,
            reason: req.body.reason || 'حذف التسوية من الإدارة'
        });
        const originalStatus = result.transaction.balanceAdjustment?.originalStatus;
        const originalLabel = originalStatus === 'deposit' ? 'الإيداع' : 'الخصم';

        await createClientNotifications({
            accountModel: result.entityModel,
            account: result.account,
            title: `إلغاء ${originalLabel}`,
            message: `تم إلغاء حركة ${originalLabel} رقم ${result.transaction.customId}. الرصيد الحالي: ${Number(result.balanceAfter).toFixed(2)} LYD. رقم الإلغاء: ${result.voidNumber}.`,
            type: 'system_alert',
            txId: result.transaction.customId,
            metadata: {
                voidNumber: result.voidNumber,
                reversalDelta: result.reversalDelta,
                balanceAfter: result.balanceAfter
            }
        }).catch(() => {});

        await logAction({
            action: 'BALANCE_ADJUSTMENT_VOIDED',
            req,
            performedById: req.session.adminId,
            performedByModel: 'Admin',
            performedByName: performedBy,
            targetId: result.entityId,
            targetModel: result.entityModel,
            oldData: { status: originalStatus, balance: result.balanceBefore },
            newData: { status: 'cancelled_by_admin', balance: result.balanceAfter },
            result: 'ناجح',
            metadata: {
                transactionId: result.transaction.customId,
                voidNumber: result.voidNumber,
                reversalDelta: result.reversalDelta,
                originalCreatedAt: result.transaction.createdAt,
                companyId: result.transaction.companyId ? String(result.transaction.companyId) : '',
                userId: result.transaction.userId ? String(result.transaction.userId) : '',
                subAccountId: result.transaction.subAccountId ? String(result.transaction.subAccountId) : '',
                employeeName: result.transaction.employeeName || ''
            }
        });

        const io = req.app?.get('io');
        if (io) io.emit('update_data');

        if (result.entityModel === 'User') return res.redirect(`/user/${result.entityId}?settlementVoided=1`);
        if (result.entityModel === 'ClientCompany') return res.redirect(`/company/${result.entityId}?settlementVoided=1`);
        return res.redirect('/transactions?filterType=deposit_deduction&settlementVoided=1');
    } catch (error) {
        console.error('[clients/void-balance-adjustment] failed:', error.stack || error.message);
        const knownErrors = {
            ADJUSTMENT_NOT_FOUND: 'notfound',
            ADJUSTMENT_ALREADY_VOIDED: 'already',
            ADJUSTMENT_NOT_REVERSIBLE: 'unsupported',
            ADJUSTMENT_LEDGER_NOT_FOUND: 'unsupported',
            ADJUSTMENT_VOID_CONFLICT: 'conflict'
        };
        return res.redirect(`/transactions?filterType=deposit_deduction&voidError=${knownErrors[error.message] || 'failed'}`);
    }
});

router.post('/company/:id/update-rate', requireAuth, requireMaster, async (req, res) => {
    try {
        const company = await ClientCompany.findOne({ _id: req.params.id, ...visibleAccountFilter }).lean();
        if (!company) return res.redirect('/clients?section=companies&rateError=notfound');

        const settings = await Settings.findOne({}).lean() || {};
        const oldConfig = getCompanyRateConfig(company, settings);
        const legacyRate = Number(req.body.exchangeRate);
        const mode = req.body.rateMode === COMPANY_RATE_MODES.CUSTOM
            || (req.body.rateMode === undefined && Number.isFinite(legacyRate) && legacyRate > 0)
            ? COMPANY_RATE_MODES.CUSTOM
            : COMPANY_RATE_MODES.GENERAL;
        let rateOffsets = SERVICE_RATE_KEYS.reduce((offsets, serviceKey) => {
            offsets[serviceKey] = 0;
            return offsets;
        }, {});
        let effectiveRates = oldConfig.generalRates;

        if (mode === COMPANY_RATE_MODES.CUSTOM) {
            const desiredRates = {};
            const hasServiceInputs = SERVICE_RATE_KEYS.some((serviceKey) => (
                req.body[COMPANY_RATE_INPUT_FIELDS[serviceKey]] !== undefined
            ));

            SERVICE_RATE_KEYS.forEach((serviceKey) => {
                const submitted = Number(req.body[COMPANY_RATE_INPUT_FIELDS[serviceKey]]);
                if (hasServiceInputs) {
                    desiredRates[serviceKey] = submitted;
                } else if (Number.isFinite(legacyRate) && legacyRate > 0) {
                    const commonOffset = legacyRate - oldConfig.generalRates.vodafone;
                    desiredRates[serviceKey] = oldConfig.generalRates[serviceKey] + commonOffset;
                }
            });

            const invalidRate = SERVICE_RATE_KEYS.some((serviceKey) => (
                !Number.isFinite(desiredRates[serviceKey]) || desiredRates[serviceKey] <= 0
            ));
            if (invalidRate) return res.redirect(`/company/${req.params.id}?rateError=invalid#company-pricing`);

            rateOffsets = buildCompanyRateOffsets(company, settings, desiredRates);
            effectiveRates = SERVICE_RATE_KEYS.reduce((rates, serviceKey) => {
                rates[serviceKey] = Number(desiredRates[serviceKey].toFixed(2));
                return rates;
            }, {});
        }

        await ClientCompany.findByIdAndUpdate(req.params.id, {
            $set: {
                rateMode: mode,
                rateOffsets,
                exchangeRate: mode === COMPANY_RATE_MODES.CUSTOM ? effectiveRates.vodafone : 0,
                rateUpdatedAt: new Date(),
                rateUpdatedBy: req.session.adminName || req.session.adminId || 'admin'
            }
        }, { runValidators: true });

        await logAction({
            action: 'COMPANY_RATES_UPDATED',
            req,
            performedById: req.session.adminId,
            performedByModel: 'Admin',
            performedByName: req.session.adminName || 'الإدارة',
            targetId: company._id,
            targetModel: 'ClientCompany',
            oldData: { mode: oldConfig.mode, rates: oldConfig.effectiveRates },
            newData: { mode, rates: effectiveRates },
            metadata: { companyName: company.name, followsGeneralRates: mode === COMPANY_RATE_MODES.GENERAL }
        });

        const io = req.app?.get('io');
        if (io) {
            io.emit('exchange_rates_updated', { source: 'company', companyId: String(company._id) });
            io.emit('update_data');
        }
        res.redirect(`/company/${req.params.id}?rateUpdated=1#company-pricing`);
    } catch (e) {
        console.error('[clients/update-company-rate] failed:', e.message);
        res.redirect(`/company/${req.params.id}?rateError=failed#company-pricing`);
    }
});

router.post('/company/:id/toggle-status', requireAuth, requireMaster, async (req, res) => {
    const comp = await ClientCompany.findById(req.params.id); comp.status = comp.status === 'active' ? 'inactive' : 'active'; await comp.save(); res.redirect(`/company/${comp._id}`);
});

router.post('/company/:id/delete', requireAuth, requireMaster, async (req, res) => {
    try {
        const company = await ClientCompany.findOne({ _id: req.params.id, ...visibleAccountFilter }).select('_id');
        if (!company) return res.redirect('/clients?section=companies&deleteError=notfound');

        const subAccounts = await SubAccount.find({ masterType: 'company', masterId: company._id, ...visibleAccountFilter }).select('_id').lean();
        await releaseAccountCodeReservation({ modelName: 'ClientCompany', id: company._id });
        await releaseSubAccountCodes(subAccounts);

        await ClientCompany.updateOne({ _id: company._id }, deletedAccountUpdate(req), { strict: false });
        await ClientEmployee.updateMany(
            { companyId: company._id, status: { $ne: 'deleted' } },
            {
                $set: { status: 'deleted', ...deleteMetadata(req) },
                $unset: { otpCode: 1, otpExpires: 1 }
            },
            { strict: false }
        );
        if (subAccounts.length) {
            await SubAccount.updateMany(
                { _id: { $in: subAccounts.map((sub) => sub._id) } },
                deletedAccountUpdate(req),
                { strict: false }
            );
        }

        res.redirect('/clients?section=companies&deleted=1');
    } catch (error) {
        console.error('[clients/delete-company] خطأ في حذف حساب الشركة:', error.message);
        res.redirect('/clients?section=companies&deleteError=1');
    }
});

router.post('/company/:id/change-level', requireAuth, requireMaster, async (req, res) => {
    await ClientCompany.findByIdAndUpdate(req.params.id, { tier: parseInt(req.body.tier) }); res.redirect(`/company/${req.params.id}`);
});

router.post('/company/:id/update-limit', requireAuth, requireMaster, async (req, res) => {
    try { const limit = Math.abs(parseFloat(req.body.creditLimit) || 0); await ClientCompany.findByIdAndUpdate(req.params.id, { creditLimit: limit }); res.redirect(`/company/${req.params.id}`); } catch (e) { res.redirect('/clients?section=companies'); }
});

router.post('/company/:id/update-account-code', requireAuth, requireMaster, async (req, res) => {
    try {
        await saveAccountCode({
            Model: ClientCompany,
            modelName: 'ClientCompany',
            id: req.params.id,
            code: req.body.accountCode,
            expectedLength: CODE_LENGTHS.company
        });
        res.redirect(`/company/${req.params.id}?codeSaved=1`);
    } catch (error) {
        res.redirect(`/company/${req.params.id}?codeError=${accountCodeErrorQuery(error)}`);
    }
});

router.post('/sub-account/:id/update-account-code', requireAuth, requireMaster, async (req, res) => {
    try {
        await saveAccountCode({
            Model: SubAccount,
            modelName: 'SubAccount',
            id: req.params.id,
            code: req.body.accountCode,
            expectedLength: CODE_LENGTHS.subAccount
        });
        res.redirect('/clients?section=subaccounts&codeSaved=1');
    } catch (error) {
        res.redirect(`/clients?section=subaccounts&codeError=${accountCodeErrorQuery(error)}`);
    }
});

router.post('/sub-account/:id/delete', requireAuth, requireMaster, async (req, res) => {
    try {
        const subAccount = await SubAccount.findOne({ _id: req.params.id, ...visibleAccountFilter }).select('_id');
        if (!subAccount) return res.redirect('/clients?section=subaccounts&deleteError=notfound');

        await releaseAccountCodeReservation({ modelName: 'SubAccount', id: subAccount._id });
        await SubAccount.updateOne({ _id: subAccount._id }, deletedAccountUpdate(req), { strict: false });

        res.redirect('/clients?section=subaccounts&deleted=1');
    } catch (error) {
        console.error('[clients/delete-sub-account] خطأ في حذف حساب عميل الوكيل:', error.message);
        res.redirect('/clients?section=subaccounts&deleteError=1');
    }
});

module.exports = router;
