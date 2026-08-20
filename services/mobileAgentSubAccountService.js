'use strict';

const mongoose = require('mongoose');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const Employee = require('../models/Employee');
const SubAccount = require('../models/SubAccount');
const Transaction = require('../models/Transaction');
const { updateBalanceWithLedger } = require('./walletService');
const { buildMarginStorage } = require('../utils/agencyPricing');
const { recordCustomerSettlement } = require('./agencyJournalService');
const { logAction } = require('./auditService');
const { sendMobileError } = require('../mappers/mobileErrorMapper');
const {
    toSubAccountListItemDto,
    toSubAccountDetailsDto,
    toAgentOverviewDto,
    toSubAccountSettlementDto,
    toSubAccountTransactionDto
} = require('../mappers/mobileAgentSubAccountMapper');
const {
    decodeOpaqueId,
    buildRequestFingerprint
} = require('../utils/mobileOpaqueId');
const {
    normalizeCreditLimit,
    assertCreditLimitCanCoverBalance
} = require('./agencyCreditLimitService');

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalizeNumber = (value) => Number(Number(value || 0).toFixed(3));
const withSession = (query, session) =>
    query && typeof query.session === 'function' ? query.session(session) : query;

const checkAgentAuth = async (req, res) => {
    const { userId, accountType } = req.user;

    if (accountType !== 'client_user') {
        sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        return null;
    }

    const agent = await User.findById(userId);
    if (!agent || agent.role !== 'agent') {
        sendMobileError(res, 403, 'FORBIDDEN', 'غير مصرح لغير الوكلاء', req.correlationId);
        return null;
    }

    if (agent.status !== 'active') {
        sendMobileError(res, 403, 'FORBIDDEN', 'حساب الوكيل غير نشط', req.correlationId);
        return null;
    }

    return agent;
};

const decodeSubAccountParam = (req, res) => {
    try {
        return decodeOpaqueId('sub_account', req.params.id);
    } catch (_) {
        sendMobileError(res, 400, 'INVALID_RESOURCE_ID', 'معرف المورد غير صالح', req.correlationId);
        return null;
    }
};

const getOwnedSubAccount = async (agent, subAccountId, session) => {
    const sub = await withSession(SubAccount.findById(subAccountId), session);
    if (!sub || sub.masterType !== 'user' || String(sub.masterId) !== String(agent._id)) {
        return null;
    }
    return sub;
};

const createSubAccountFingerprintPayload = (agentId, body) => ({
    masterType: 'user',
    masterId: String(agentId),
    username: String(body.username || '').trim(),
    name: String(body.name || '').trim(),
    phone: String(body.phone || '').trim(),
    password: String(body.password || ''),
    customMargin: normalizeNumber(body.customMargin),
    marginPiasters: Number.isFinite(Number(body.marginPiasters)) ? Math.round(Number(body.marginPiasters)) : undefined,
    creditLimit: normalizeNumber(body.creditLimit)
});

const existingSubAccountMatchesPayload = (sub, agentId, body) => {
    const requestedPricing = buildMarginStorage(body);
    return Boolean(
        sub &&
        sub.masterType === 'user' &&
        String(sub.masterId) === String(agentId) &&
        String(sub.webUsername || '').trim() === String(body.username || '').trim() &&
        String(sub.name || '').trim() === String(body.name || '').trim() &&
        String(sub.phone || '').trim() === String(body.phone || '').trim() &&
        normalizeNumber(sub.customMargin) === normalizeNumber(requestedPricing.customMargin) &&
        normalizeNumber(sub.creditLimit) === normalizeNumber(body.creditLimit)
    );
};

const settlementFingerprintPayload = (agentId, subAccountId, body) => ({
    agentId: String(agentId),
    subAccountId: String(subAccountId),
    type: String(body.type || '').trim(),
    amount: normalizeNumber(body.amount),
    notes: String(body.notes || '').trim()
});

const getOverview = async (req, res) => {
    try {
        const agent = await checkAgentAuth(req, res);
        if (!agent) return;

        const subAccounts = await SubAccount.find({ masterType: 'user', masterId: agent._id });
        return res.json({
            success: true,
            ...toAgentOverviewDto(agent, subAccounts),
            serverTime: new Date().toISOString()
        });
    } catch (_) {
        return sendMobileError(res, 500, 'SERVER_ERROR', 'خطأ داخلي بالسيرفر', req.correlationId);
    }
};

const getSubAccounts = async (req, res) => {
    try {
        const agent = await checkAgentAuth(req, res);
        if (!agent) return;

        const filter = { masterType: 'user', masterId: agent._id };
        if (req.query.status) filter.status = req.query.status;

        const rawSearch = String(req.query.search || '').trim();
        if (rawSearch) {
            const search = escapeRegExp(rawSearch.slice(0, 80));
            filter.$or = [
                { name: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } },
                { webUsername: { $regex: search, $options: 'i' } },
                { accountCode: { $regex: search, $options: 'i' } }
            ];
        }

        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
        const total = await SubAccount.countDocuments(filter);
        const totalPages = Math.ceil(total / limit);

        const list = await SubAccount.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit);

        return res.json({
            success: true,
            page,
            limit,
            total,
            totalPages,
            hasMore: page < totalPages,
            data: list.map(toSubAccountListItemDto),
            serverTime: new Date().toISOString()
        });
    } catch (_) {
        return sendMobileError(res, 500, 'SERVER_ERROR', 'خطأ داخلي بالسيرفر', req.correlationId);
    }
};

const getSubAccountDetails = async (req, res) => {
    try {
        const agent = await checkAgentAuth(req, res);
        if (!agent) return;

        const subAccountId = decodeSubAccountParam(req, res);
        if (!subAccountId) return;

        const sub = await getOwnedSubAccount(agent, subAccountId);
        if (!sub) {
            return sendMobileError(res, 404, 'SUB_ACCOUNT_NOT_FOUND', 'الحساب التابع غير موجود أو غير تابع لك', req.correlationId);
        }

        return res.json({
            success: true,
            subAccount: toSubAccountDetailsDto(sub),
            serverTime: new Date().toISOString()
        });
    } catch (_) {
        return sendMobileError(res, 500, 'SERVER_ERROR', 'خطأ داخلي بالسيرفر', req.correlationId);
    }
};

const createSubAccount = async (req, res) => {
    try {
        const agent = await checkAgentAuth(req, res);
        if (!agent) return;

        const { username, name, phone, password, customMargin, marginPiasters, creditLimit } = req.body;
        const idempotencyKey = req.headers['idempotency-key'];
        const creationPayload = createSubAccountFingerprintPayload(agent._id, req.body);
        const creationFingerprint = buildRequestFingerprint('agent_sub_account_create', creationPayload);

        const existingByKey = await SubAccount.findOne({ creationIdempotencyKey: idempotencyKey });
        if (existingByKey) {
            if (
                existingByKey.masterType === 'user' &&
                String(existingByKey.masterId) === String(agent._id) &&
                existingByKey.creationIdempotencyFingerprint === creationFingerprint
            ) {
                return res.status(200).json({
                    success: true,
                    message: 'تم استرجاع نتيجة إنشاء الحساب التابع بنفس مفتاح منع التكرار',
                    subAccount: toSubAccountDetailsDto(existingByKey),
                    serverTime: new Date().toISOString()
                });
            }
            return sendMobileError(res, 409, 'IDEMPOTENCY_CONFLICT', 'مفتاح منع التكرار مستخدم لطلب مختلف', req.correlationId);
        }

        const existingSub = await SubAccount.findOne({ webUsername: username });
        if (existingSub) {
            const isTrueReplay =
                existingSub.creationIdempotencyFingerprint === creationFingerprint ||
                (!existingSub.creationIdempotencyFingerprint && existingSubAccountMatchesPayload(existingSub, agent._id, req.body));

            if (isTrueReplay && existingSub.masterType === 'user' && String(existingSub.masterId) === String(agent._id)) {
                return res.status(200).json({
                    success: true,
                    message: 'تم استرجاع الحساب التابع الموجود مسبقاً بنجاح (Idempotent)',
                    subAccount: toSubAccountDetailsDto(existingSub),
                    serverTime: new Date().toISOString()
                });
            }

            return sendMobileError(res, 409, 'USERNAME_ALREADY_EXISTS', 'اسم المستخدم مسجل بالفعل ولا يطابق نفس طلب الإنشاء', req.correlationId);
        }

        const taken = await Promise.all([
            User.findOne({ webUsername: username }),
            ClientEmployee.findOne({ webUsername: username }),
            Employee.findOne({ webUsername: username })
        ]);
        if (taken.some(Boolean)) {
            return sendMobileError(res, 409, 'USERNAME_ALREADY_EXISTS', 'اسم المستخدم مسجل بالفعل في المنظومة', req.correlationId);
        }

        const normalizedCreditLimit = normalizeCreditLimit(creditLimit);
        const pricing = buildMarginStorage({ marginPiasters, customMargin });
        const sub = await SubAccount.create({
            masterType: 'user',
            masterId: agent._id,
            tenantId: (req.tenant && req.tenant._id) || agent.tenantId || undefined,
            name,
            phone,
            webUsername: username,
            webPassword: password,
            creationIdempotencyKey: idempotencyKey,
            creationIdempotencyFingerprint: creationFingerprint,
            ...pricing,
            creditLimit: normalizedCreditLimit,
            creditLimitUpdatedAt: normalizedCreditLimit > 0 ? new Date() : undefined,
            creditLimitUpdatedBy: normalizedCreditLimit > 0 ? agent.name : undefined,
            creditLimitUpdatedByModel: normalizedCreditLimit > 0 ? 'User' : undefined,
            creditLimitUpdatedById: normalizedCreditLimit > 0 ? agent._id : undefined,
            status: 'active'
        });

        await logAction({
            action: 'SUB_ACCOUNT_CREATED',
            req,
            performedById: agent._id,
            performedByModel: 'User',
            performedByName: agent.name,
            targetId: sub._id,
            targetModel: 'SubAccount',
            newData: { name: sub.name, webUsername: sub.webUsername, customMargin: sub.customMargin, creditLimit: sub.creditLimit },
            metadata: { idempotencyKey, creationFingerprint }
        });

        return res.status(201).json({
            success: true,
            message: 'تم إنشاء الحساب التابع بنجاح',
            subAccount: toSubAccountDetailsDto(sub),
            serverTime: new Date().toISOString()
        });
    } catch (error) {
        if (error && error.code === 11000) {
            return sendMobileError(res, 409, 'IDEMPOTENCY_CONFLICT', 'طلب الإنشاء مكرر أو متعارض', req.correlationId);
        }
        if (error && error.code === 'INVALID_CREDIT_LIMIT') {
            return sendMobileError(res, 400, 'INVALID_CREDIT_LIMIT', 'حد المديونية يجب أن يكون رقماً موجباً أو صفراً.', req.correlationId);
        }
        return sendMobileError(res, 500, 'SERVER_ERROR', 'خطأ داخلي أثناء إنشاء الحساب التابع', req.correlationId);
    }
};

const updateCreditLimit = async (req, res) => {
    try {
        const agent = await checkAgentAuth(req, res);
        if (!agent) return;

        const subAccountId = decodeSubAccountParam(req, res);
        if (!subAccountId) return;

        const sub = await getOwnedSubAccount(agent, subAccountId);
        if (!sub) {
            return sendMobileError(res, 404, 'SUB_ACCOUNT_NOT_FOUND', 'الحساب التابع غير موجود أو غير تابع لك', req.correlationId);
        }

        const newLimit = normalizeCreditLimit(req.body.creditLimit, { required: true });
        assertCreditLimitCanCoverBalance({ balance: sub.balance, creditLimit: newLimit });
        if (Number(sub.creditLimit || 0) === newLimit) {
            return res.status(200).json({
                success: true,
                message: 'تم تحديث الحد التأميني (Idempotent)',
                subAccount: toSubAccountDetailsDto(sub),
                serverTime: new Date().toISOString()
            });
        }

        const oldLimit = sub.creditLimit;
        sub.creditLimit = newLimit;
        sub.creditLimitUpdatedAt = new Date();
        sub.creditLimitUpdatedBy = agent.name;
        sub.creditLimitUpdatedByModel = 'User';
        sub.creditLimitUpdatedById = agent._id;
        await sub.save();

        await logAction({
            action: 'SUB_ACCOUNT_LIMIT_UPDATED',
            req,
            performedById: agent._id,
            performedByModel: 'User',
            performedByName: agent.name,
            targetId: sub._id,
            targetModel: 'SubAccount',
            oldData: { creditLimit: oldLimit },
            newData: { creditLimit: sub.creditLimit },
            metadata: { idempotencyKey: req.headers['idempotency-key'] }
        });

        return res.json({
            success: true,
            message: 'تم تحديث الحد التأميني بنجاح',
            subAccount: toSubAccountDetailsDto(sub),
            serverTime: new Date().toISOString()
        });
    } catch (error) {
        if (error && error.code === 'INVALID_CREDIT_LIMIT') {
            return sendMobileError(res, 400, 'INVALID_CREDIT_LIMIT', 'حد المديونية يجب أن يكون رقماً موجباً أو صفراً.', req.correlationId);
        }
        if (error && error.code === 'CREDIT_LIMIT_BELOW_OUTSTANDING_DEBT') {
            return sendMobileError(res, 409, 'CREDIT_LIMIT_BELOW_OUTSTANDING_DEBT', 'لا يمكن خفض حد المديونية إلى أقل من الدين الحالي للعميل.', req.correlationId);
        }
        return sendMobileError(res, 500, 'SERVER_ERROR', 'خطأ داخلي أثناء تحديث الحد التأميني', req.correlationId);
    }
};

const updateStatus = async (req, res) => {
    try {
        const agent = await checkAgentAuth(req, res);
        if (!agent) return;

        const subAccountId = decodeSubAccountParam(req, res);
        if (!subAccountId) return;

        const sub = await getOwnedSubAccount(agent, subAccountId);
        if (!sub) {
            return sendMobileError(res, 404, 'SUB_ACCOUNT_NOT_FOUND', 'الحساب التابع غير موجود أو غير تابع لك', req.correlationId);
        }

        const newStatus = req.body.status;
        if (sub.status === newStatus) {
            return res.status(200).json({
                success: true,
                message: 'تم تحديث حالة الحساب التابع (Idempotent)',
                subAccount: toSubAccountDetailsDto(sub),
                serverTime: new Date().toISOString()
            });
        }

        const oldStatus = sub.status;
        sub.status = newStatus;
        await sub.save();

        await logAction({
            action: 'SUB_ACCOUNT_STATUS_UPDATED',
            req,
            performedById: agent._id,
            performedByModel: 'User',
            performedByName: agent.name,
            targetId: sub._id,
            targetModel: 'SubAccount',
            oldData: { status: oldStatus },
            newData: { status: sub.status },
            metadata: { idempotencyKey: req.headers['idempotency-key'] }
        });

        return res.json({
            success: true,
            message: 'تم تحديث حالة الحساب التابع بنجاح',
            subAccount: toSubAccountDetailsDto(sub),
            serverTime: new Date().toISOString()
        });
    } catch (_) {
        return sendMobileError(res, 500, 'SERVER_ERROR', 'خطأ داخلي أثناء تحديث حالة الحساب', req.correlationId);
    }
};

const executeSettlement = async (req, res) => {
    let session;
    try {
        const agent = await checkAgentAuth(req, res);
        if (!agent) return;

        const subAccountId = decodeSubAccountParam(req, res);
        if (!subAccountId) return;

        const { type, amount, notes } = req.body;
        const val = parseFloat(amount);
        const category = type === 'deposit' ? 'customer_payment' : 'customer_payout';
        const paymentMethod = ['cash', 'bank', 'wallet', 'other'].includes(req.body.paymentMethod)
            ? req.body.paymentMethod
            : 'cash';
        const externalReference = String(req.body.externalReference || '').trim().slice(0, 100);
        const idempotencyKey = req.headers['idempotency-key'];
        const idempotencyFingerprint = buildRequestFingerprint(
            'agent_sub_account_settlement',
            settlementFingerprintPayload(agent._id, subAccountId, req.body)
        );

        session = await mongoose.startSession();
        session.startTransaction();

        const sub = await getOwnedSubAccount(agent, subAccountId, session);
        if (!sub) {
            await session.abortTransaction();
            session.endSession();
            session = null;
            return sendMobileError(res, 404, 'SUB_ACCOUNT_NOT_FOUND', 'الحساب التابع غير موجود أو غير تابع لك', req.correlationId);
        }

        const existingTx = await withSession(Transaction.findOne({ idempotencyKey }), session);
        if (existingTx) {
            if (
                existingTx.idempotencyFingerprint === idempotencyFingerprint &&
                String(existingTx.subAccountId || '') === String(sub._id)
            ) {
                await session.abortTransaction();
                session.endSession();
                session = null;
                return res.status(200).json({
                    success: true,
                    message: 'تم استرجاع التسوية المنجزة مسبقاً بنفس مفتاح منع التكرار',
                    ...toSubAccountSettlementDto(existingTx, sub),
                    serverTime: new Date().toISOString()
                });
            }

            await session.abortTransaction();
            session.endSession();
            session = null;
            return sendMobileError(res, 409, 'IDEMPOTENCY_CONFLICT', 'مفتاح منع التكرار مستخدم لتسوية مختلفة', req.correlationId);
        }

        const txId = `SET-${Date.now().toString().slice(-6)}`;
        await updateBalanceWithLedger(
            'SubAccount',
            sub._id,
            type === 'deposit' ? val : -val,
            type === 'deposit' ? 'DEPOSIT' : 'DEDUCTION',
            txId,
            type === 'deposit' ? `تمويل نقطة بيع (${sub.name})` : `سحب رصيد من نقطة بيع (${sub.name})`,
            { minBalance: 0, allowNegative: true, session }
        );

        const updatedSub = await withSession(SubAccount.findById(sub._id), session);
        const adminNotes = type === 'deposit' ? `تمويل نقطة بيع (${sub.name})` : `سحب رصيد من نقطة بيع (${sub.name})`;
        const created = await Transaction.create([{
            customId: txId,
            subAccountId: sub._id,
            subAccountName: sub.name,
            userId: agent.phone || agent.webUsername,
            amount: val,
            costLYD: 0,
            status: type === 'deposit' ? 'deposit' : 'deduction',
            notes: notes || '',
            customerNotes: notes || '',
            adminNotes,
            companyName: 'تسوية وكيل',
            employeeName: agent.name,
            idempotencyKey,
            idempotencyFingerprint,
            balanceAdjustment: {
                entityModel: 'SubAccount',
                entityId: sub._id,
                delta: type === 'deposit' ? val : -val,
                reversible: true
            },
            settlementDetails: {
                category,
                paymentMethod,
                externalReference,
                statement: notes || '',
                settledBy: agent.name
            }
        }], { session });
        const newTx = Array.isArray(created) ? created[0] : created;

        await recordCustomerSettlement({
            transactionId: txId,
            subAccount: sub,
            category,
            amount: val,
            delta: type === 'deposit' ? val : -val,
            idempotencyKey,
            actor: { _id: agent._id, model: 'User', name: agent.name },
            metadata: { paymentMethod, externalReference, notes: notes || '' }
        }, session);

        await session.commitTransaction();
        session.endSession();
        session = null;

        await logAction({
            action: 'SUB_ACCOUNT_SETTLED',
            req,
            performedById: agent._id,
            performedByModel: 'User',
            performedByName: agent.name,
            targetId: sub._id,
            targetModel: 'SubAccount',
            newData: { amount: val, type, txId },
            metadata: { idempotencyKey, idempotencyFingerprint }
        });

        return res.json({
            success: true,
            message: 'تم تسجيل التسوية بنجاح',
            ...toSubAccountSettlementDto(newTx, updatedSub),
            serverTime: new Date().toISOString()
        });
    } catch (error) {
        if (session) {
            try {
                await session.abortTransaction();
                session.endSession();
            } catch (_) {}
        }

        if (error && error.message === 'INSUFFICIENT_BALANCE') {
            return sendMobileError(res, 400, 'SUB_INSUFFICIENT_BALANCE', 'رصيد الحساب التابع غير كافٍ لإتمام عملية السحب', req.correlationId);
        }

        return sendMobileError(res, 500, 'SERVER_ERROR', 'خطأ داخلي أثناء معالجة التسوية المالية للرصيد', req.correlationId);
    }
};

const getTransactions = async (req, res) => {
    try {
        const agent = await checkAgentAuth(req, res);
        if (!agent) return;

        const subAccountId = decodeSubAccountParam(req, res);
        if (!subAccountId) return;

        const sub = await getOwnedSubAccount(agent, subAccountId);
        if (!sub) {
            return sendMobileError(res, 404, 'SUB_ACCOUNT_NOT_FOUND', 'الحساب التابع غير موجود أو غير تابع لك', req.correlationId);
        }

        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
        const filter = { subAccountId: sub._id };
        const total = await Transaction.countDocuments(filter);
        const totalPages = Math.ceil(total / limit);

        const list = await Transaction.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit);

        return res.json({
            success: true,
            page,
            limit,
            total,
            totalPages,
            hasMore: page < totalPages,
            transactions: list.map(toSubAccountTransactionDto),
            serverTime: new Date().toISOString()
        });
    } catch (_) {
        return sendMobileError(res, 500, 'SERVER_ERROR', 'خطأ داخلي أثناء جلب كشف حساب العمليات', req.correlationId);
    }
};

module.exports = {
    getOverview,
    getSubAccounts,
    getSubAccountDetails,
    createSubAccount,
    updateCreditLimit,
    updateStatus,
    executeSettlement,
    getTransactions
};
