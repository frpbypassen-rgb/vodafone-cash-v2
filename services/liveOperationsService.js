'use strict';

const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const AuditLog = require('../models/AuditLog');
const Ledger = require('../models/Ledger');
const SubAccount = require('../models/SubAccount');
const User = require('../models/User');
const ExecutorGroup = require('../models/ExecutorGroup');
const { hasPermission } = require('../middlewares/auth');
const { buildLifecycle } = require('./transactionLifecycleView');
const { getTransferPricingDefinition } = require('../utils/transferPricing');
const { systemDateKey, systemDateRange } = require('../config/systemTime');
const { tenantScope } = require('../utils/tenantScope');
const { applyAdminTxPrivacy } = require('./adminAccountVisibilityService');

const ALLOWED_STATUSES = new Set([
    'pending', 'processing', 'accepted', 'completed', 'rejected',
    'deposit_pending', 'deposit', 'deduction', 'cancelled_by_admin'
]);
const STATUS_GROUPS = {
    success: ['completed', 'deposit', 'deduction'],
    failed: ['rejected'],
    pending: ['pending', 'processing', 'accepted', 'deposit_pending'],
    cancelled: ['cancelled_by_admin']
};
const SORT_FIELDS = new Set(['createdAt', 'updatedAt', 'amount', 'status', 'completedAt']);
const CASH_TRANSFER_TYPES = ['vodafone', 'post_account', 'post_card', 'bank_account', 'sefa_niger', 'bankak_sudan'];
const DIRECT_TRANSFER_TYPES = new Set([...CASH_TRANSFER_TYPES, 'balance_transfer']);
const DEFAULT_LARGE_AMOUNT = 10_000;
const DISPLAY_PROJECTION = [
    'customId', 'status', 'amount', 'costLYD', 'exchangeRate', 'transferType',
    'userId', 'companyId', 'subAccountId', 'companyName', 'employeeName',
    'subAccountName', 'accountName', 'vodafoneNumber', 'accountNumber',
    'serviceDetails.clientPhone', 'serviceDetails.destinationLabel',
    'executorName', 'executorGroupName', 'assignedExecutorName', 'createdAt',
    'updatedAt', 'completedAt', 'executorReceivedAt', 'assignedExecutorAt',
    'cancelledAt', 'cancellationReason', 'cancellationNumber', 'apiResultData'
].join(' ');

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clamp = (value, minimum, maximum, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.floor(number))) : fallback;
};
const asDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const resolveStatusFilter = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (STATUS_GROUPS[raw]) return { $in: STATUS_GROUPS[raw] };
    return ALLOWED_STATUSES.has(raw) ? raw : null;
};

const statusValues = (filter) => {
    if (!filter) return null;
    if (typeof filter === 'string') return [filter];
    return Array.isArray(filter.$in) ? filter.$in : null;
};

const applyTypeFilter = (query, rawType) => {
    const type = String(rawType || '').trim();
    if (!type) return;
    if (type === 'deposit' || type === 'deduction') {
        const required = type === 'deposit' ? ['deposit', 'deposit_pending'] : ['deduction'];
        const existing = statusValues(query.status);
        const matching = existing ? existing.filter((value) => required.includes(value)) : required;
        query.status = { $in: matching };
        return;
    }
    if (type === 'cash_transfer') {
        query.transferType = { $in: CASH_TRANSFER_TYPES };
        return;
    }
    const normalized = type === 'internal_transfer' ? 'balance_transfer' : type;
    if (DIRECT_TRANSFER_TYPES.has(normalized)) query.transferType = normalized;
};

const resolveTimeRange = (query = {}, now = new Date()) => {
    const range = String(query.range || '24h');
    if (range === 'all') return null;
    if (range === '1h') return { $gte: new Date(now.getTime() - 60 * 60 * 1000), $lte: now };
    if (range === 'custom') {
        const from = asDate(query.from);
        const to = asDate(query.to);
        if (from && to && from <= to) return { $gte: from, $lte: to };
    }
    return { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000), $lte: now };
};

const buildLiveQuery = (req, now = new Date()) => {
    const query = applyAdminTxPrivacy({ ...tenantScope(req) });
    const status = resolveStatusFilter(req.query?.status);
    if (status) query.status = status;
    applyTypeFilter(query, req.query?.type);
    const createdAt = resolveTimeRange(req.query, now);
    if (createdAt) query.createdAt = createdAt;
    const minimum = Number(req.query?.minAmount);
    const maximum = Number(req.query?.maxAmount);
    if (Number.isFinite(minimum) || Number.isFinite(maximum)) {
        query.amount = {};
        if (Number.isFinite(minimum)) query.amount.$gte = Math.max(0, minimum);
        if (Number.isFinite(maximum)) query.amount.$lte = Math.max(0, maximum);
    }
    const search = String(req.query?.q || '').trim().slice(0, 100);
    if (search) {
        const safe = escapeRegex(search);
        query.$or = [
            { customId: { $regex: safe, $options: 'i' } },
            { vodafoneNumber: { $regex: safe, $options: 'i' } },
            { accountNumber: { $regex: safe, $options: 'i' } },
            { 'serviceDetails.clientPhone': { $regex: safe, $options: 'i' } },
            { companyName: { $regex: safe, $options: 'i' } },
            { employeeName: { $regex: safe, $options: 'i' } },
            { accountName: { $regex: safe, $options: 'i' } },
            { 'settlementDetails.externalReference': { $regex: safe, $options: 'i' } }
        ];
    }
    return query;
};

const safeApiError = (transaction) => {
    const source = transaction.apiResultData || {};
    const raw = source.error || source.Error || source.message || source.Message || source.errorMessage;
    if (!raw && transaction.status !== 'rejected') return null;
    return {
        code: String(source.code || source.Code || source.statusCode || 'TRANSFER_FAILED').slice(0, 80),
        message: String(raw || transaction.cancellationReason || 'لم تكتمل العملية. راجع سجل الأحداث.').slice(0, 500)
    };
};

const riskThreshold = () => Math.max(1, Number(process.env.LIVE_OPERATIONS_LARGE_AMOUNT) || DEFAULT_LARGE_AMOUNT);
const transactionRecipient = (transaction) => transaction.vodafoneNumber
    || transaction.accountNumber
    || transaction.serviceDetails?.clientPhone
    || '---';
const transactionCustomer = (transaction) => transaction.companyName
    || transaction.employeeName
    || transaction.accountName
    || 'عميل غير محدد';

const mapLiveTransaction = (transaction, audit = null) => {
    const largeAmount = Number(transaction.amount || 0) >= riskThreshold();
    const newDevice = Boolean(audit?.metadata?.newDevice || audit?.metadata?.deviceTrusted === false);
    return {
        id: String(transaction._id),
        reference: transaction.customId,
        status: transaction.status,
        type: transaction.transferType,
        amount: Number(transaction.amount || 0),
        amountCurrency: getTransferPricingDefinition(transaction.transferType).amountCurrencyCode,
        costLYD: Number(transaction.costLYD || 0),
        exchangeRate: Number(transaction.exchangeRate || 0),
        customer: transactionCustomer(transaction),
        recipient: transactionRecipient(transaction),
        executor: transaction.executorName || transaction.assignedExecutorName || transaction.executorGroupName || 'غير محدد',
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
        completedAt: transaction.completedAt,
        durationMs: transaction.completedAt && transaction.createdAt
            ? Math.max(0, new Date(transaction.completedAt) - new Date(transaction.createdAt))
            : null,
        error: safeApiError(transaction),
        security: {
            flagged: largeAmount || newDevice,
            largeAmount,
            newDevice,
            ip: audit?.ipAddress || '',
            deviceType: audit?.deviceType || '',
            location: audit?.location || null
        }
    };
};

const auditMapForTransactions = async (transactions) => {
    if (!transactions.length) return new Map();
    const ids = transactions.map((item) => item._id);
    const refs = transactions.map((item) => item.customId).filter(Boolean);
    const audits = await AuditLog.find({
        action: 'TRANSFER_CREATED',
        $or: [{ targetId: { $in: ids } }, { 'metadata.transactionId': { $in: refs } }]
    }).sort({ createdAt: -1 }).lean();
    const map = new Map();
    audits.forEach((audit) => {
        const keys = [audit.targetId, audit.metadata?.transactionId].filter(Boolean).map(String);
        keys.forEach((key) => { if (!map.has(key)) map.set(key, audit); });
    });
    return map;
};

const listLiveTransactions = async (req) => {
    const page = clamp(req.query?.page, 1, 100_000, 1);
    const limit = clamp(req.query?.limit, 10, 100, 40);
    const sortField = SORT_FIELDS.has(String(req.query?.sort)) ? String(req.query.sort) : 'createdAt';
    const sortDirection = String(req.query?.direction) === 'asc' ? 1 : -1;
    const query = buildLiveQuery(req);
    const [total, transactions] = await Promise.all([
        Transaction.countDocuments(query).maxTimeMS(5_000),
        Transaction.find(query).select(DISPLAY_PROJECTION).sort({ [sortField]: sortDirection, _id: -1 })
            .skip((page - 1) * limit).limit(limit).maxTimeMS(5_000).lean()
    ]);
    const audits = await auditMapForTransactions(transactions);
    return {
        rows: transactions.map((item) => mapLiveTransaction(item, audits.get(String(item._id)) || audits.get(item.customId))),
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
    };
};

const exportLiveTransactions = async (req, limit = 10_000) => {
    const query = buildLiveQuery(req);
    const rows = await Transaction.find(query).select(DISPLAY_PROJECTION).sort({ createdAt: -1, _id: -1 })
        .limit(Math.min(10_000, Math.max(1, Number(limit) || 10_000))).maxTimeMS(15_000).lean();
    return rows.map((item) => mapLiveTransaction(item));
};

const getLiveMetrics = async (req, now = new Date()) => {
    const todayRange = systemDateRange(systemDateKey(now), systemDateKey(now));
    const base = applyAdminTxPrivacy({ ...tenantScope(req), ...(todayRange ? { createdAt: todayRange } : {}) });
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const [summary, recent] = await Promise.all([
        Transaction.aggregate([
            { $match: base },
            { $group: {
                _id: null,
                total: { $sum: 1 },
                liquidity: { $sum: { $ifNull: ['$amount', 0] } },
                successful: { $sum: { $cond: [{ $in: ['$status', STATUS_GROUPS.success] }, 1, 0] } },
                pending: { $sum: { $cond: [{ $in: ['$status', STATUS_GROUPS.pending] }, 1, 0] } },
                completedDurationTotal: { $sum: { $cond: [
                    { $and: [{ $eq: ['$status', 'completed'] }, { $ne: ['$completedAt', null] }] },
                    { $subtract: ['$completedAt', '$createdAt'] }, 0
                ] } },
                completedWithDuration: { $sum: { $cond: [
                    { $and: [{ $eq: ['$status', 'completed'] }, { $ne: ['$completedAt', null] }] }, 1, 0
                ] } }
            } }
        ]),
        Transaction.aggregate([
            { $match: applyAdminTxPrivacy({ ...tenantScope(req), createdAt: { $gte: fiveMinutesAgo, $lte: now } }) },
            { $group: {
                _id: null, total: { $sum: 1 },
                failed: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } }
            } }
        ])
    ]);
    const row = summary[0] || {};
    const window = recent[0] || {};
    const successRate = row.total ? (Number(row.successful || 0) / row.total) * 100 : 100;
    const failureRate5m = window.total ? (Number(window.failed || 0) / window.total) * 100 : 0;
    return {
        total: Number(row.total || 0),
        liquidity: Number(row.liquidity || 0),
        successRate,
        pending: Number(row.pending || 0),
        averageDurationMs: row.completedWithDuration
            ? Number(row.completedDurationTotal || 0) / Number(row.completedWithDuration)
            : 0,
        failureRate5m,
        alert: failureRate5m > 5 && Number(window.total || 0) >= 5
    };
};

function loadSourceAccount(transaction, scope) {
    if (transaction.subAccountId) return SubAccount.findOne({ ...scope, _id:transaction.subAccountId }).select('masterType').lean();
    if (transaction.companyId || (transaction.clientActorModel && transaction.clientActorModel !== 'User')) return Promise.resolve(null);
    const identity = transaction.clientActorId || transaction.userId;
    if (!identity) return Promise.resolve(null);
    const lookup = mongoose.isValidObjectId(identity) ? { _id:identity } : { phone:identity };
    return User.findOne({ ...scope, ...lookup }).select('role name').lean();
}

const getTransactionDetail = async (req, id) => {
    if (!mongoose.isValidObjectId(id)) return null;
    const scope = tenantScope(req);
    const transaction = await Transaction.findOne(applyAdminTxPrivacy({ _id: id, ...scope }))
        .select(`+clientActorId +clientActorModel +routingHistory ${DISPLAY_PROJECTION} isSubAccountTx tenantId executorGroupId operatorId assignedExecutorName routedByAdminName routedAt cancelledBy cancellationNumber`).lean();
    if (!transaction) return null;
    const canReadFinance = hasPermission(req.session, 'reports.read');
    const limit = 200;
    const auditTargets = [{ targetId:{ $in:[transaction._id, String(transaction._id)] } }];
    if (transaction.customId) auditTargets.push(
        { 'metadata.transactionId':transaction.customId, targetModel:{ $in:['Transaction', null] } },
        { 'metadata.customId':transaction.customId, targetModel:{ $in:['Transaction', null] } }
    );
    const [auditRows, ledgerRows, account] = await Promise.all([
        AuditLog.find({ ...scope, $or:auditTargets }).sort({ createdAt:1, _id:1 }).limit(limit + 1)
            .select('action success performedByName performedByModel ipAddress userAgent deviceType location createdAt oldData.executorName oldData.assignedExecutorName oldData.routedByAdminName newData.executorName metadata.executorName metadata.routedByAdminName metadata.lifecycleRecorded').lean(),
        canReadFinance && transaction.customId
            ? Ledger.find({ ...scope, transactionId:transaction.customId }).sort({ createdAt:1, _id:1 }).limit(limit + 1)
                .select('entityId entityModel type amount currency settledCurrency balanceBefore balanceAfter createdAt').lean()
            : Promise.resolve([]),
        loadSourceAccount(transaction, scope)
    ]);
    const audits = auditRows.slice(0, limit);
    const ledgers = ledgerRows.slice(0, limit);
    const executorIds = ledgers.filter(row => ['ExecutorGroup','ExecutorBot'].includes(row.entityModel) && row.entityId).map(row => row.entityId);
    const executorAccounts = executorIds.length
        ? await ExecutorGroup.find({ ...scope, _id:{ $in:executorIds } }).select('name').lean() : [];
    const lifecycle = buildLifecycle(transaction, {
        audits, ledgers, account, executorNames:new Map(executorAccounts.map(row => [String(row._id), row.name])), canReadFinance,
        auditTruncated:auditRows.length > limit, financeTruncated:ledgerRows.length > limit
    });
    const creationAudit = audits.find((item) => item.action === 'TRANSFER_CREATED') || audits[0] || null;
    return {
        transaction: mapLiveTransaction(transaction, creationAudit),
        parties: {
            sender: transactionCustomer(transaction),
            senderActor: transaction.employeeName || 'المدير',
            recipient: transactionRecipient(transaction)
        },
        lifecycle,
        timeline: lifecycle.events.map(event => ({ ...event, state: ['cancelled', 'rejected'].includes(event.kind) ? 'error' : 'done' })),
        error: safeApiError(transaction),
        audit: creationAudit ? {
            ip: creationAudit.ipAddress || '', deviceType: creationAudit.deviceType || '',
            userAgent: creationAudit.userAgent || '', location: creationAudit.location || null
        } : null
    };
};

module.exports = {
    ALLOWED_STATUSES, STATUS_GROUPS, applyTypeFilter, buildLiveQuery, exportLiveTransactions, getLiveMetrics,
    getTransactionDetail, listLiveTransactions, mapLiveTransaction, resolveTimeRange, riskThreshold
};
