'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const businessPortalService = require('../services/businessPortalService');
const centralReportService = require('../services/centralReportService');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const Transaction = require('../models/Transaction');
const Counter = require('../models/Counter');
const { assignGeneratedAccountCode, CODE_LENGTHS } = require('../services/accountCodeService');
const {
    updateBalanceWithLedger,
    isMongoTransactionFallbackError,
    requiresMongoTransactions,
    financialTransactionsUnavailableError
} = require('../services/walletService');
const { notifyBalanceAdjustment } = require('../services/clientNotificationService');
const { createDepositReceiptProof } = require('../services/depositReceiptService');
const { buildClientReceiptImages } = require('../services/clientReceiptService');
const { logAction } = require('../services/auditService');
const { customerNoteFromTransaction } = require('../utils/transactionNotes');
const { sanitizeStatementText } = require('../utils/accountStatementPrivacy');
const { parseTransferMessage } = require('../utils/smartTransferParser');
const businessPortalAssistantService = require('../services/businessPortalAssistantService');
const { buildMarginStorage } = require('../utils/agencyPricing');
const { SERVICE_RATE_KEYS } = require('../utils/rateHelper');
const { recordCustomerSettlement } = require('../services/agencyJournalService');
const AgencyJournal = require('../models/AgencyJournal');
const {
    normalizeCreditLimit,
    assertCreditLimitCanCoverBalance
} = require('../services/agencyCreditLimitService');

const USERNAME_DOMAIN = '@ahram.com';

const checked = (value) => ['1', 'true', 'on', 'yes'].includes(String(value || '').toLowerCase());
const cleanText = (value, maxLength = 160) => String(value || '').trim().slice(0, maxLength);

const normalizeUsername = (rawUsername) => {
    const base = cleanText(rawUsername, 64).toLowerCase();
    const username = base.includes('@') ? base : `${base}${USERNAME_DOMAIN}`;
    if (!/^[a-z0-9_]{3,40}@ahram\.com$/.test(username)) throw new Error('INVALID_USERNAME');
    return username;
};

const assertIdentityAvailable = async ({ webUsername, phone }) => {
    const usernameQueries = [
        ClientEmployee.exists({ webUsername }),
        AgentEmployee.exists({ webUsername }),
        User.exists({ webUsername }),
        SubAccount.exists({ webUsername }),
        Employee.exists({ webUsername }),
        Admin.exists({ webUsername })
    ];
    const phoneQueries = phone ? [
        ClientEmployee.exists({ phone }),
        AgentEmployee.exists({ phone }),
        User.exists({ phone }),
        SubAccount.exists({ phone }),
        Employee.exists({ phone })
    ] : [];
    const matches = await Promise.all([...usernameQueries, ...phoneQueries]);
    if (matches.some(Boolean)) throw new Error('IDENTITY_TAKEN');
};

const redirectWithMessage = (res, path, type, code) => {
    const separator = path.includes('?') ? '&' : '?';
    return res.redirect(`${path}${separator}${type}=${encodeURIComponent(code)}`);
};

const customerOwnerFilter = (workspace, id = null) => ({
    ...(id ? { _id: id } : {}),
    masterType: workspace.masterType,
    masterId: workspace.masterId,
    status: { $ne: 'deleted' }
});

const requireCustomerManager = (workspace) => {
    if (!workspace.permissions.canManageCustomers) {
        const error = new Error('FORBIDDEN');
        error.statusCode = 403;
        throw error;
    }
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
        if (isMongoTransactionFallbackError(error)) {
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

exports.renderPage = (page) => async (req, res, next) => {
    try {
        const context = await businessPortalService.loadPageContext(req, page);
        return res.render('client/workspace', context);
    } catch (error) {
        if (error.message === 'NOT_BUSINESS_PORTAL' && typeof next === 'function') return next();
        if (error.message === 'FORBIDDEN_PAGE') return res.status(403).redirect('/client/dashboard?portalError=forbidden');
        if (error.message === 'CUSTOMER_NOT_FOUND') return res.status(404).redirect('/client/customers?customerError=notfound');
        console.error(`[Business Portal] ${page} render failed:`, error.message);
        return res.redirect('/client/logout');
    }
};

exports.getCurrentRates = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        const { serviceRates } = await businessPortalService.getSettingsAndRates(workspace, req.app);
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, serviceRates, updatedAt: new Date().toISOString() });
    } catch (error) {
        const statusCode = error.statusCode === 401 ? 401 : 500;
        console.error('[Business Portal] current rates failed:', error.message);
        return res.status(statusCode).json({
            success: false,
            error: statusCode === 401 ? 'انتهت الجلسة. سجل الدخول مرة أخرى.' : 'تعذر تحديث أسعار الصرف.'
        });
    }
};

exports.postCreateCustomer = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        requireCustomerManager(workspace);

        const name = cleanText(req.body.name, 120);
        const phone = cleanText(req.body.phone, 32);
        const webPassword = String(req.body.webPassword || '');
        const webUsername = normalizeUsername(req.body.webUsername);
        const pricing = buildMarginStorage({
            marginPiasters: req.body.marginPiasters,
            customMargin: req.body.customMargin
        });
        const creditLimit = normalizeCreditLimit(req.body.creditLimit);

        if (name.length < 3 || !/^\+?[0-9]{8,15}$/.test(phone) || webPassword.length < 8) {
            return redirectWithMessage(res, '/client/customers', 'customerError', 'invalid');
        }
        await assertIdentityAvailable({ webUsername, phone });

        const customer = await SubAccount.create({
            masterType: workspace.masterType,
            masterId: workspace.masterId,
            tenantId: (req.tenant && req.tenant._id) || workspace.actor.tenantId || undefined,
            name,
            phone,
            webUsername,
            webPassword,
            ...pricing,
            creditLimit,
            creditLimitUpdatedAt: creditLimit > 0 ? new Date() : undefined,
            creditLimitUpdatedBy: creditLimit > 0 ? workspace.actor.name : undefined,
            creditLimitUpdatedByModel: creditLimit > 0 ? workspace.actorModel : undefined,
            creditLimitUpdatedById: creditLimit > 0 ? workspace.actor._id : undefined,
            status: 'active'
        });

        await assignGeneratedAccountCode({
            Model: SubAccount,
            modelName: 'SubAccount',
            id: customer._id,
            length: CODE_LENGTHS.subAccount
        });

        await logAction({
            action: 'USER_CREATED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: customer._id,
            targetModel: 'SubAccount',
            result: 'ناجح',
            metadata: { portal: workspace.type, webUsername, phone }
        });

        return redirectWithMessage(res, '/client/customers', 'customerSuccess', 'created');
    } catch (error) {
        const code = error.message === 'IDENTITY_TAKEN'
            ? 'duplicate'
            : error.message === 'INVALID_USERNAME'
                ? 'username'
                : error.code === 'INVALID_CREDIT_LIMIT'
                    ? 'credit_limit'
                    : error.message === 'FORBIDDEN'
                    ? 'forbidden'
                    : 'server';
        console.error('[Business Portal] create customer failed:', error.message);
        return redirectWithMessage(res, '/client/customers', 'customerError', code);
    }
};

exports.postToggleCustomer = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        requireCustomerManager(workspace);
        const customer = await SubAccount.findOne(customerOwnerFilter(workspace, req.params.id));
        if (!customer) return redirectWithMessage(res, '/client/customers', 'customerError', 'notfound');

        customer.status = customer.status === 'active' ? 'banned' : 'active';
        await customer.save();
        await logAction({
            action: 'USER_STATUS_CHANGED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: customer._id,
            targetModel: 'SubAccount',
            result: customer.status,
            metadata: { portal: workspace.type }
        });
        return redirectWithMessage(res, '/client/customers', 'customerSuccess', 'status');
    } catch (error) {
        console.error('[Business Portal] toggle customer failed:', error.message);
        return redirectWithMessage(res, '/client/customers', 'customerError', error.message === 'FORBIDDEN' ? 'forbidden' : 'server');
    }
};

exports.postUpdateCustomerCreditLimit = async (req, res) => {
    let returnPath = '/client/customers';
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        requireCustomerManager(workspace);
        if (!workspace.isAgent) throw new Error('FORBIDDEN');

        const customer = await SubAccount.findOne(customerOwnerFilter(workspace, req.params.id));
        if (!customer) return redirectWithMessage(res, returnPath, 'customerError', 'notfound');

        returnPath = req.body.returnTo === 'customers'
            ? '/client/customers'
            : `/client/customers/${customer._id}`;

        const creditLimit = normalizeCreditLimit(req.body.creditLimit, { required: true });
        assertCreditLimitCanCoverBalance({ balance: customer.balance, creditLimit });

        const oldCreditLimit = Number(customer.creditLimit || 0);
        if (oldCreditLimit === creditLimit) {
            return redirectWithMessage(res, returnPath, 'customerSuccess', 'credit_limit');
        }

        customer.creditLimit = creditLimit;
        customer.creditLimitUpdatedAt = new Date();
        customer.creditLimitUpdatedBy = workspace.actor.name;
        customer.creditLimitUpdatedByModel = workspace.actorModel;
        customer.creditLimitUpdatedById = workspace.actor._id;
        await customer.save();

        await logAction({
            action: 'SUB_ACCOUNT_CREDIT_LIMIT_UPDATED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: customer._id,
            targetModel: 'SubAccount',
            oldData: { creditLimit: oldCreditLimit },
            newData: { creditLimit, minimumBalance: -creditLimit },
            result: 'SUCCESS',
            metadata: {
                portal: workspace.type,
                customerBalance: Number(customer.balance || 0)
            }
        });

        const io = req.app?.get('io');
        if (io) io.emit('update_data');
        return redirectWithMessage(res, returnPath, 'customerSuccess', 'credit_limit');
    } catch (error) {
        const code = error.code === 'INVALID_CREDIT_LIMIT'
            ? 'credit_limit'
            : error.code === 'CREDIT_LIMIT_BELOW_OUTSTANDING_DEBT'
                ? 'limit_below_debt'
                : error.message === 'FORBIDDEN'
                    ? 'forbidden'
                    : 'server';
        console.error('[Business Portal] customer credit limit update failed:', error.message);
        return redirectWithMessage(res, returnPath, 'customerError', code);
    }
};

const nextSettlementId = async (session) => {
    const counter = await Counter.findOneAndUpdate(
        { name: 'portal_customer_settlement' },
        { $inc: { value: 1 } },
        { upsert: true, new: true, ...(session ? { session } : {}) }
    );
    const now = new Date();
    return `SET-${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}-${String(counter.value).padStart(5, '0')}`;
};

exports.postAdjustCustomerBalance = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        requireCustomerManager(workspace);
        const customer = await SubAccount.findOne(customerOwnerFilter(workspace, req.params.id));
        if (!customer) return redirectWithMessage(res, '/client/customers', 'customerError', 'notfound');

        const amount = Number(req.body.amount);
        const aliases = { deposit: 'customer_payment', withdraw: 'customer_payout' };
        const requestedCategory = aliases[req.body.operation] || String(req.body.operation || 'customer_payment');
        const allowedCategories = new Set(['customer_payment', 'customer_payout', 'debt_payment', 'balance_credit', 'balance_debit']);
        const category = allowedCategories.has(requestedCategory) ? requestedCategory : 'customer_payment';
        const creditCategories = new Set(['customer_payment', 'debt_payment', 'balance_credit']);
        const isCredit = creditCategories.has(category);
        const operation = isCredit ? 'deposit' : 'withdraw';
        const note = cleanText(req.body.note, 240);
        const paymentMethod = ['cash', 'bank', 'wallet', 'other'].includes(req.body.paymentMethod)
            ? req.body.paymentMethod
            : 'cash';
        const externalReference = cleanText(req.body.externalReference, 100);
        if (!Number.isFinite(amount) || amount <= 0) {
            return redirectWithMessage(res, '/client/customers', 'customerError', 'amount');
        }
        const delta = operation === 'deposit' ? amount : -amount;
        const adjustment = await runDbTransaction(async (session) => {
            const transactionId = await nextSettlementId(session);
            let balanceApplied = false;
            try {
                const balanceResult = await updateBalanceWithLedger(
                    'SubAccount',
                    customer._id,
                    delta,
                    operation === 'deposit' ? 'DEPOSIT' : 'DEDUCTION',
                    transactionId,
                    note || (operation === 'deposit' ? `تمويل العميل ${customer.name}` : `سحب من رصيد العميل ${customer.name}`),
                    { minBalance: 0, allowNegative: true, ...(session ? { session } : {}) }
                );
                balanceApplied = true;

                const [transaction] = await Transaction.create([{
                customId: transactionId,
                userId: workspace.isAgent ? (workspace.entity.phone || workspace.entity.webUsername) : null,
                companyId: workspace.isCompany ? workspace.entity._id : null,
                companyName: workspace.entity.name,
                employeeName: workspace.actor.name,
                subAccountId: customer._id,
                subAccountName: customer.name,
                isSubAccountTx: true,
                vodafoneNumber: customer.accountCode || customer.phone,
                amount,
                costLYD: 0,
                status: operation === 'deposit' ? 'deposit' : 'deduction',
                notes: note,
                customerNotes: note,
                adminNotes: operation === 'deposit' ? 'تمويل عميل تابع' : 'سحب من عميل تابع',
                balanceAdjustment: {
                    entityModel: 'SubAccount',
                    entityId: customer._id,
                    delta,
                    reversible: true
                },
                settlementDetails: {
                    category,
                    paymentMethod,
                    externalReference,
                    statement: note,
                    settledBy: workspace.actor.name
                }
                }], session ? { session } : {});

            const proofId = createDepositReceiptProof({
                customId: transactionId,
                accountName: customer.name,
                accountCode: customer.accountCode || customer.webUsername || customer.phone || '',
                amount,
                balanceAfter: balanceResult.balanceAfter,
                notes: note,
                createdAt: transaction.createdAt,
                type: operation === 'deposit' ? 'deposit' : 'deduction'
            });
            transaction.proofImage = proofId;
            transaction.proofImages = [proofId];
                await transaction.save(session ? { session } : {});

                await recordCustomerSettlement({
                transactionId,
                subAccount: customer,
                category,
                amount,
                delta,
                actor: {
                    _id: workspace.actor._id,
                    model: workspace.actorModel,
                    name: workspace.actor.name
                },
                metadata: { paymentMethod, externalReference, note }
                }, session);

                return { transaction, transactionId, balanceAfter: balanceResult.balanceAfter };
            } catch (error) {
                if (!session) {
                    await AgencyJournal.deleteMany({ transactionId }).catch(() => {});
                    await Transaction.deleteOne({ customId: transactionId }).catch(() => {});
                    await require('../models/Ledger').deleteMany({ transactionId }).catch(() => {});
                    if (balanceApplied) {
                        await SubAccount.updateOne({ _id: customer._id }, { $inc: { balance: -delta } }).catch(() => {});
                    }
                }
                throw error;
            }
        });

        await notifyBalanceAdjustment({
            accountModel: 'SubAccount',
            account: customer,
            amount: delta,
            balanceAfter: adjustment.balanceAfter,
            customId: adjustment.transactionId,
            notes: note
        }).catch(() => {});
        const io = req.app?.get('io');
        if (io) io.emit('update_data');

        await logAction({
            action: operation === 'deposit' ? 'BALANCE_ADDED' : 'BALANCE_DEDUCTED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: customer._id,
            targetModel: 'SubAccount',
            result: 'ناجح',
            metadata: { amount, transactionId: adjustment.transactionId, portal: workspace.type, category, paymentMethod, externalReference }
        });

        const returnPath = req.body.returnTo === 'profile'
            ? `/client/customers/${customer._id}`
            : '/client/customers';
        return redirectWithMessage(res, returnPath, 'customerSuccess', category);
    } catch (error) {
        console.error('[Business Portal] customer balance failed:', error.message);
        const code = error.message === 'FORBIDDEN'
            ? 'forbidden'
            : error.code === 'FINANCIAL_TRANSACTIONS_UNAVAILABLE'
                ? 'temporarily-unavailable'
            : error.message === 'INSUFFICIENT_BALANCE'
                ? 'funds'
                : error.message === 'ACCOUNT_NOT_FOUND'
                    ? 'notfound'
                    : 'server';
        return redirectWithMessage(res, '/client/customers', 'customerError', code);
    }
};

exports.postUpdateCustomerPricing = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        requireCustomerManager(workspace);
        const customer = await SubAccount.findOne(customerOwnerFilter(workspace, req.params.id));
        if (!customer) return redirectWithMessage(res, '/client/customers', 'customerError', 'notfound');

        const serviceMarginPiasters = SERVICE_RATE_KEYS.reduce((result, serviceKey) => {
            result[serviceKey] = req.body[`margin_${serviceKey}`];
            return result;
        }, {});
        const pricing = buildMarginStorage({
            marginPiasters: req.body.marginPiasters,
            customMargin: req.body.customMargin,
            serviceMarginPiasters
        });
        const oldPricing = {
            marginPiasters: customer.marginPiasters,
            customMargin: customer.customMargin,
            serviceMarginPiasters: customer.serviceMarginPiasters
        };
        customer.marginPiasters = pricing.marginPiasters;
        customer.customMargin = pricing.customMargin;
        customer.serviceMarginPiasters = pricing.serviceMarginPiasters;
        customer.pricingVersion = pricing.pricingVersion;
        customer.marginUpdatedAt = new Date();
        customer.marginUpdatedBy = workspace.actor.name;
        await customer.save();

        await logAction({
            action: 'SETTINGS_UPDATED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: customer._id,
            targetModel: 'SubAccount',
            oldData: oldPricing,
            newData: pricing,
            result: 'ناجح',
            metadata: { portal: workspace.type, section: 'customer_pricing' }
        });

        return redirectWithMessage(res, `/client/customers/${customer._id}`, 'customerSuccess', 'pricing');
    } catch (error) {
        console.error('[Business Portal] customer pricing failed:', error.message);
        return redirectWithMessage(res, '/client/customers', 'customerError', error.message === 'FORBIDDEN' ? 'forbidden' : 'server');
    }
};

exports.postUpdateSettings = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        if (!workspace.permissions.canEditSettings) {
            return redirectWithMessage(res, '/client/settings', 'settingsError', 'forbidden');
        }
        const Model = workspace.isCompany ? ClientCompany : User;
        const entity = await Model.findById(workspace.entity._id);
        if (!entity) return redirectWithMessage(res, '/client/settings', 'settingsError', 'notfound');

        entity.businessProfile = {
            contactName: cleanText(req.body.contactName, 120),
            email: cleanText(req.body.email, 160).toLowerCase(),
            city: cleanText(req.body.city, 80),
            address: cleanText(req.body.address, 240),
            registrationNumber: cleanText(req.body.registrationNumber, 80)
        };
        if (cleanText(req.body.phone, 32)) entity.phone = cleanText(req.body.phone, 32);
        await entity.save();

        await logAction({
            action: 'SETTINGS_UPDATED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: entity._id,
            targetModel: workspace.entityModel,
            result: 'ناجح',
            metadata: { portal: workspace.type, section: 'business_profile' }
        });
        return redirectWithMessage(res, '/client/settings', 'settingsSuccess', 'profile');
    } catch (error) {
        console.error('[Business Portal] settings update failed:', error.message);
        return redirectWithMessage(res, '/client/settings', 'settingsError', 'server');
    }
};

exports.postChangePassword = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        const Model = workspace.actorModel === 'ClientEmployee'
            ? ClientEmployee
            : workspace.actorModel === 'AgentEmployee'
                ? AgentEmployee
                : User;
        const actor = await Model.findById(workspace.actor._id);
        const currentPassword = String(req.body.currentPassword || '');
        const newPassword = String(req.body.newPassword || '');
        const passwordConfirm = String(req.body.passwordConfirm || '');
        if (!actor || !await bcrypt.compare(currentPassword, actor.webPassword || '')) {
            return redirectWithMessage(res, '/client/settings', 'settingsError', 'current_password');
        }
        if (newPassword.length < 8 || newPassword !== passwordConfirm) {
            return redirectWithMessage(res, '/client/settings', 'settingsError', 'new_password');
        }
        actor.webPassword = newPassword;
        await actor.save();
        await logAction({
            action: 'USER_PASSWORD_CHANGED',
            req,
            performedById: actor._id,
            performedByModel: workspace.actorModel,
            performedByName: actor.name,
            targetId: actor._id,
            targetModel: workspace.actorModel,
            result: 'ناجح',
            metadata: { selfService: true, portal: workspace.type }
        });
        return redirectWithMessage(res, '/client/settings', 'settingsSuccess', 'password');
    } catch (error) {
        console.error('[Business Portal] password update failed:', error.message);
        return redirectWithMessage(res, '/client/settings', 'settingsError', 'server');
    }
};

exports.getTransactionDetails = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        const ownership = await businessPortalService.ownershipFilter(workspace);
        const conditions = [ownership, { _id: req.params.id }];
        if (workspace.forceToday) {
            const range = businessPortalService.resolveDateRange({}, { forceToday: true });
            conditions.push({ createdAt: { $gte: range.start, $lte: range.end } });
        }
        const transaction = await Transaction.findOne({ $and: conditions }).lean();
        if (!transaction) return res.status(404).json({ success: false, error: 'العملية غير موجودة.' });
        const receiptImages = buildClientReceiptImages(transaction);
        const service = businessPortalService.SERVICE_CATALOG.find((item) => item.key === transaction.transferType);

        return res.json({
            success: true,
            transaction: {
                id: transaction._id,
                customId: transaction.customId,
                status: transaction.status,
                statusLabel: businessPortalService.STATUS_META[transaction.status]?.label || transaction.status,
                transferType: transaction.transferType,
                serviceLabel: service?.label || transaction.transferType,
                amount: transaction.amount,
                amountCurrencyLabel: transaction.serviceDetails?.amountCurrency === 'XOF'
                    ? 'سيفا'
                    : (service?.amountCurrencyLabel || 'EGP'),
                costLYD: transaction.costLYD,
                exchangeRate: transaction.exchangeRate,
                rateDirection: transaction.serviceDetails?.rateDirection || service?.rateDirection || 'lyd_to_source',
                destination: transaction.vodafoneNumber || transaction.accountNumber,
                accountName: transaction.accountName,
                accountNumber: transaction.accountNumber,
                serviceDetails: transaction.serviceDetails || {},
                notes: customerNoteFromTransaction(transaction),
                customerNotes: customerNoteFromTransaction(transaction),
                employeeName: transaction.employeeName || '',
                customerName: transaction.subAccountName || '',
                cancellationNumber: transaction.cancellationNumber || '',
                cancellationReason: sanitizeStatementText(transaction.cancellationReason, transaction.cancellationReason ? 'تم إلغاء العملية' : ''),
                createdAt: transaction.createdAt,
                updatedAt: transaction.updatedAt,
                hasProof: receiptImages.length > 0,
                receiptImages,
                hasIdentityImage: Boolean(transaction.idCardImage)
            }
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

        return res.json({ success: true, parsed: parseTransferMessage(message) });
    } catch (error) {
        const statusCode = error.statusCode === 401 ? 401 : 500;
        console.error('[Business Portal] smart transfer parse failed:', error.message);
        return res.status(statusCode).json({
            success: false,
            error: statusCode === 401 ? 'انتهت الجلسة. سجل الدخول مرة أخرى.' : 'تعذر تحليل رسالة التحويل.'
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
            severity: intent === 'blocked_sensitive' ? 'warning' : 'info'
        }).catch(() => {});
        return res.json(result);
    } catch (error) {
        const statusCode = error.statusCode === 401 ? 401 : 500;
        console.error('[Business Portal] assistant query failed:', error.message);
        return res.status(statusCode).json({
            success: false,
            error: statusCode === 401 ? 'انتهت الجلسة. سجل الدخول مرة أخرى.' : 'تعذر تشغيل المساعد الآن. حاول مرة أخرى.'
        });
    }
};

exports.exportReportCsv = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        if (!workspace.permissions.canViewReports) return res.status(403).send('Forbidden');
        const report = await businessPortalService.loadReports(workspace, req.query);
        const artifact = report.centralReport || centralReportService.buildArtifact({ workspace, report });
        const fileName = `central-${report.reportScope}-${artifact.reportId}.csv`;
        await logAction({
            action: 'CENTRAL_REPORT_DOWNLOADED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: workspace.entity._id,
            targetModel: workspace.entityModel,
            metadata: {
                reportId: artifact.reportId,
                checksum: artifact.checksum,
                scope: report.reportScope,
                period: report.filters?.label || '',
                source: artifact.source
            },
            success: true,
            severity: 'info'
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        return res.send(centralReportService.buildCsv({ workspace, report, artifact }));
    } catch (error) {
        console.error('[Business Portal] CSV export failed:', error.message);
        return res.status(500).send('تعذر تصدير التقرير.');
    }
};

exports.helpers = {
    normalizeUsername,
    cleanText,
    checked
};
