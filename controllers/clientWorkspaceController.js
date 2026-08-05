'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const businessPortalService = require('../services/businessPortalService');
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
const { updateBalanceWithLedger, isMongoTransactionFallbackError } = require('../services/walletService');
const { notifyBalanceAdjustment } = require('../services/clientNotificationService');
const { createDepositReceiptProof } = require('../services/depositReceiptService');
const { buildClientReceiptImages } = require('../services/clientReceiptService');
const { logAction } = require('../services/auditService');

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
    const session = await mongoose.startSession();
    try {
        session.startTransaction();
        const result = await callback(session);
        await session.commitTransaction();
        return result;
    } catch (error) {
        try { await session.abortTransaction(); } catch (_) {}
        if (isMongoTransactionFallbackError(error)) return callback(null);
        throw error;
    } finally {
        session.endSession();
    }
};

exports.renderPage = (page) => async (req, res, next) => {
    try {
        const context = await businessPortalService.loadPageContext(req, page);
        return res.render('client/workspace', context);
    } catch (error) {
        if (error.message === 'NOT_BUSINESS_PORTAL' && typeof next === 'function') return next();
        if (error.message === 'FORBIDDEN_PAGE') return res.status(403).redirect('/client/dashboard?portalError=forbidden');
        console.error(`[Business Portal] ${page} render failed:`, error.message);
        return res.redirect('/client/logout');
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
        const customMargin = Math.max(0, Number(req.body.customMargin) || 0);
        const creditLimit = Math.max(0, Number(req.body.creditLimit) || 0);

        if (name.length < 3 || !/^\+?[0-9]{8,15}$/.test(phone) || webPassword.length < 8) {
            return redirectWithMessage(res, '/client/customers', 'customerError', 'invalid');
        }
        await assertIdentityAvailable({ webUsername, phone });

        const customer = await SubAccount.create({
            masterType: workspace.masterType,
            masterId: workspace.masterId,
            name,
            phone,
            webUsername,
            webPassword,
            customMargin,
            creditLimit,
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

const nextSettlementId = async () => {
    const counter = await Counter.findOneAndUpdate(
        { name: 'portal_customer_settlement' },
        { $inc: { value: 1 } },
        { upsert: true, new: true }
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
        const operation = req.body.operation === 'withdraw' ? 'withdraw' : 'deposit';
        const note = cleanText(req.body.note, 240);
        if (!Number.isFinite(amount) || amount <= 0) {
            return redirectWithMessage(res, '/client/customers', 'customerError', 'amount');
        }
        const transactionId = await nextSettlementId();
        const delta = operation === 'deposit' ? amount : -amount;
        const adjustment = await runDbTransaction(async (session) => {
            const balanceResult = await updateBalanceWithLedger(
                'SubAccount',
                customer._id,
                delta,
                operation === 'deposit' ? 'DEPOSIT' : 'DEDUCTION',
                transactionId,
                note || (operation === 'deposit' ? `تمويل العميل ${customer.name}` : `سحب من رصيد العميل ${customer.name}`),
                { minBalance: 0, allowNegative: true, ...(session ? { session } : {}) }
            );

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
                adminNotes: operation === 'deposit' ? 'تمويل عميل تابع' : 'سحب من عميل تابع',
                balanceAdjustment: {
                    entityModel: 'SubAccount',
                    entityId: customer._id,
                    delta,
                    reversible: true
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

            return { transaction, balanceAfter: balanceResult.balanceAfter };
        });

        await notifyBalanceAdjustment({
            accountModel: 'SubAccount',
            account: customer,
            amount: delta,
            balanceAfter: adjustment.balanceAfter,
            customId: transactionId,
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
            metadata: { amount, transactionId, portal: workspace.type }
        });

        return redirectWithMessage(res, '/client/customers', 'customerSuccess', operation);
    } catch (error) {
        console.error('[Business Portal] customer balance failed:', error.message);
        const code = error.message === 'FORBIDDEN'
            ? 'forbidden'
            : error.message === 'INSUFFICIENT_BALANCE'
                ? 'funds'
                : error.message === 'ACCOUNT_NOT_FOUND'
                    ? 'notfound'
                    : 'server';
        return redirectWithMessage(res, '/client/customers', 'customerError', code);
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
        const transaction = await Transaction.findOne({ $and: [ownership, { _id: req.params.id }] }).lean();
        if (!transaction) return res.status(404).json({ success: false, error: 'العملية غير موجودة.' });
        const receiptImages = buildClientReceiptImages(transaction);

        return res.json({
            success: true,
            transaction: {
                id: transaction._id,
                customId: transaction.customId,
                status: transaction.status,
                statusLabel: businessPortalService.STATUS_META[transaction.status]?.label || transaction.status,
                transferType: transaction.transferType,
                serviceLabel: businessPortalService.SERVICE_CATALOG.find((service) => service.key === transaction.transferType)?.label || transaction.transferType,
                amount: transaction.amount,
                costLYD: transaction.costLYD,
                exchangeRate: transaction.exchangeRate,
                destination: transaction.vodafoneNumber || transaction.accountNumber,
                accountName: transaction.accountName,
                accountNumber: transaction.accountNumber,
                serviceDetails: transaction.serviceDetails || {},
                notes: transaction.notes || '',
                employeeName: transaction.employeeName || '',
                customerName: transaction.subAccountName || '',
                cancellationNumber: transaction.cancellationNumber || '',
                cancellationReason: transaction.cancellationReason || '',
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

const csvValue = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

exports.exportReportCsv = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        if (!workspace.permissions.canViewReports) return res.status(403).send('Forbidden');
        const report = await businessPortalService.loadReports(workspace, req.query);
        const headers = ['البند', 'إجمالي العمليات', 'الناجحة', 'قيد التنفيذ', 'الملغية', 'إجمالي EGP', 'إجمالي LYD', 'الإيداعات', 'الخصومات', 'آخر حركة'];
        const lines = [headers.map(csvValue).join(',')];
        report.reportRows.forEach((row) => {
            lines.push([
                row.key,
                row.totalCount,
                row.completedCount,
                row.pendingCount,
                row.cancelledCount,
                row.totalEGP,
                row.totalLYD,
                row.deposits,
                row.deductions,
                row.lastActivity ? new Date(row.lastActivity).toISOString() : ''
            ].map(csvValue).join(','));
        });
        const fileName = `portal-report-${report.reportScope}-${Date.now()}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        return res.send(`\uFEFF${lines.join('\n')}`);
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
