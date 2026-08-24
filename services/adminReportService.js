'use strict';

const AuditLog = require('../models/AuditLog');
const ClientCompany = require('../models/ClientCompany');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Ledger = require('../models/Ledger');
const SubAccount = require('../models/SubAccount');
const { findReportTransactions } = require('./unifiedReportService');
const User = require('../models/User');
const { systemDateKey } = require('../config/systemTime');
const { buildReportSummary } = require('../utils/adminReportCalculations');
const {
    EXECUTOR_LEDGER_MODELS,
    sanitizeAccountStatementReport
} = require('../utils/accountStatementPrivacy');
const { ensureDailySettlements } = require('./settlementService');

const REPORT_CHANGE_ACTIONS = [
    'TRANSACTION_RATE_EDITED',
    'TRANSACTION_DATA_EDITED',
    'TRANSACTION_CANCELLED_BY_ADMIN',
    'TRANSACTION_EXECUTOR_CHANGED',
    'BALANCE_ADJUSTMENT_VOIDED'
];

const ACTION_LABELS = {
    TRANSACTION_RATE_EDITED: 'تعديل سعر الصرف',
    TRANSACTION_DATA_EDITED: 'تعديل بيانات الحركة',
    TRANSACTION_CANCELLED_BY_ADMIN: 'إلغاء الحركة',
    TRANSACTION_EXECUTOR_CHANGED: 'تغيير منفذ العملية',
    BALANCE_ADJUSTMENT_VOIDED: 'إلغاء إيداع أو خصم'
};

const validDateParts = (year, month, day = 1) => {
    const date = new Date(year, month - 1, day);
    if (
        date.getFullYear() !== year
        || date.getMonth() !== month - 1
        || date.getDate() !== day
    ) return null;
    return date;
};

const getDateRange = (dateType, dateValue) => {
    const now = new Date();
    if (dateType === 'day') {
        const match = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const start = match && validDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
        if (!start) throw new Error('INVALID_REPORT_DATE');
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setHours(23, 59, 59, 999);
        return { start, end, dateType: 'day', dateValue };
    }

    const fallback = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const normalizedValue = dateType === 'month' ? String(dateValue || fallback) : fallback;
    const match = normalizedValue.match(/^(\d{4})-(\d{2})$/);
    const start = match && validDateParts(Number(match[1]), Number(match[2]), 1);
    if (!start) throw new Error('INVALID_REPORT_DATE');
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
    return { start, end, dateType: 'month', dateValue: normalizedValue };
};

const dateKey = (value) => {
    return systemDateKey(value);
};

const compactText = (value, max = 220) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

const toStringId = (value) => value == null ? '' : String(value);

const buildStatementLedgerQuery = (transactionIds = [], isExecutor = false) => ({
    transactionId: { $in: transactionIds },
    entityModel: isExecutor
        ? { $in: EXECUTOR_LEDGER_MODELS }
        : { $nin: EXECUTOR_LEDGER_MODELS }
});

const buildScopeMetadata = (transaction = {}) => ({
    companyId: toStringId(transaction.companyId),
    userId: toStringId(transaction.userId),
    subAccountId: toStringId(transaction.subAccountId),
    executorGroupId: toStringId(transaction.executorGroupId),
    employeeName: transaction.employeeName || '',
    executorName: transaction.executorName || ''
});

const resolveReportScope = async ({ mainCategory, subId, subType = 'all' }) => {
    if (!mainCategory || !subId) throw new Error('REPORT_SCOPE_REQUIRED');

    const baseQuery = {};
    const entityInfo = {
        name: '---',
        phone: '---',
        username: '---',
        joinDate: null,
        status: '---'
    };
    const auditScope = { mainCategory, subId: String(subId), subType: subType || 'all', identifiers: [] };
    let isExecutor = false;

    if (mainCategory === 'direct_client') {
        const user = await User.findById(subId).lean();
        if (!user) throw new Error('REPORT_ENTITY_NOT_FOUND');
        Object.assign(entityInfo, {
            name: user.name || '---',
            phone: user.phone || '---',
            username: user.webUsername || '---',
            joinDate: user.createdAt,
            status: 'عميل فردي مباشر'
        });
        const identifiers = [String(user._id), user.phone, user.webUsername].filter(Boolean);
        baseQuery.$or = [
            { userId: { $in: identifiers } },
            { employeeName: user.name, companyName: { $regex: /عميل فردي/ } }
        ];
        baseQuery.companyId = null;
        baseQuery.isSubAccountTx = { $ne: true };
        auditScope.identifiers = identifiers;
    } else if (mainCategory === 'company') {
        const company = await ClientCompany.findById(subId).lean();
        if (!company) throw new Error('REPORT_ENTITY_NOT_FOUND');
        baseQuery.companyId = subId;
        Object.assign(entityInfo, {
            name: company.name || '---',
            phone: company.phone || '---',
            username: company.webUsername || '---',
            joinDate: company.createdAt,
            status: 'شركة'
        });
        if (subType && subType !== 'all') {
            baseQuery.employeeName = subType;
            entityInfo.name = subType;
            entityInfo.status = `موظف شركة (${company.name || '---'})`;
        }
    } else if (mainCategory === 'agent') {
        const master = await User.findById(subId).lean() || await ClientCompany.findById(subId).lean();
        if (!master) throw new Error('REPORT_ENTITY_NOT_FOUND');
        if (!subType || subType === 'all') {
            const agentSubs = await SubAccount.find({ masterId: subId }).select('_id').lean();
            const subIds = agentSubs.map((sub) => sub._id);
            const identifiers = [String(master._id), master.phone, master.webUsername].filter(Boolean);
            baseQuery.$or = [
                { subAccountId: { $in: subIds } },
                { userId: { $in: identifiers }, isSubAccountTx: { $ne: true } },
                { companyId: subId, isSubAccountTx: { $ne: true } }
            ];
            Object.assign(entityInfo, {
                name: master.name || '---',
                phone: master.phone || '---',
                username: master.webUsername || '---',
                joinDate: master.createdAt,
                status: 'وكالة'
            });
            auditScope.identifiers = identifiers;
            auditScope.subAccountIds = subIds.map(String);
        } else {
            const subAccount = await SubAccount.findById(subType).lean();
            if (!subAccount || String(subAccount.masterId) !== String(subId)) throw new Error('REPORT_ENTITY_NOT_FOUND');
            baseQuery.subAccountId = subType;
            Object.assign(entityInfo, {
                name: subAccount.name || '---',
                phone: subAccount.phone || '---',
                username: subAccount.webUsername || '---',
                joinDate: subAccount.createdAt,
                status: `عميل تابع لوكالة (${master.name || '---'})`
            });
        }
    } else if (mainCategory === 'executor' || mainCategory === 'api_executor') {
        const group = await ExecutorGroup.findById(subId).lean();
        if (!group) throw new Error('REPORT_ENTITY_NOT_FOUND');
        isExecutor = true;
        baseQuery.executorGroupId = subId;
        Object.assign(entityInfo, {
            name: group.name || '---',
            phone: group.phone || '---',
            username: group.webUsername || '---',
            joinDate: group.createdAt,
            status: mainCategory === 'api_executor' ? 'منفذ API' : 'شركة تنفيذ'
        });
        if (mainCategory === 'executor') {
            const manager = await Employee.findOne({ groupId: subId, role: 'manager' }).lean();
            if (manager) {
                entityInfo.phone = manager.phone || entityInfo.phone;
                entityInfo.username = manager.webUsername || entityInfo.username;
            }
            if (subType && subType !== 'all') {
                baseQuery.executorName = subType;
                entityInfo.name = subType;
                entityInfo.status = `منفذ مالي (${group.name || '---'})`;
            }
        }
    } else {
        throw new Error('INVALID_REPORT_SCOPE');
    }

    return { auditScope, baseQuery, entityInfo, isExecutor };
};

const scopeMatchesMetadata = (auditScope, metadata = {}) => {
    if (!auditScope) return false;
    if (auditScope.mainCategory === 'direct_client') {
        return auditScope.identifiers.includes(toStringId(metadata.userId));
    }
    if (auditScope.mainCategory === 'company') {
        return toStringId(metadata.companyId) === auditScope.subId
            && (auditScope.subType === 'all' || metadata.employeeName === auditScope.subType);
    }
    if (auditScope.mainCategory === 'agent') {
        if (auditScope.subType !== 'all') return toStringId(metadata.subAccountId) === auditScope.subType;
        return auditScope.subAccountIds?.includes(toStringId(metadata.subAccountId))
            || auditScope.identifiers.includes(toStringId(metadata.userId))
            || toStringId(metadata.companyId) === auditScope.subId;
    }
    if (auditScope.mainCategory === 'executor' || auditScope.mainCategory === 'api_executor') {
        return toStringId(metadata.executorGroupId) === auditScope.subId
            && (auditScope.subType === 'all' || metadata.executorName === auditScope.subType);
    }
    return false;
};

const changedFieldsSummary = (oldData = {}, newData = {}) => {
    const labels = {
        amount: 'المبلغ',
        costLYD: 'القيمة بالدينار',
        exchangeRate: 'سعر الصرف',
        createdAt: 'تاريخ الحركة',
        status: 'الحالة',
        executorName: 'المنفذ'
    };
    const changes = Object.keys(labels).filter((key) => (
        oldData[key] !== undefined
        && newData[key] !== undefined
        && String(oldData[key]) !== String(newData[key])
    )).map((key) => `${labels[key]}: ${oldData[key]} ← ${newData[key]}`);
    return changes.join('، ');
};

const buildPostCloseChanges = ({ transactions, settlements, auditLogs, auditScope, start, end }) => {
    const closeByDay = new Map(settlements.map((settlement) => [
        dateKey(settlement.period?.start),
        new Date(settlement.closedAt || settlement.approvedAt || settlement.createdAt)
    ]));
    const transactionById = new Map(transactions.map((transaction) => [toStringId(transaction._id), transaction]));
    const transactionByCustomId = new Map(transactions.map((transaction) => [transaction.customId, transaction]));
    const notes = [];
    const auditedTransactions = new Set();

    auditLogs.forEach((audit) => {
        const transaction = transactionById.get(toStringId(audit.targetId))
            || transactionByCustomId.get(audit.metadata?.transactionId);
        const metadata = { ...(transaction ? buildScopeMetadata(transaction) : {}), ...(audit.metadata || {}) };
        if (!transaction && !scopeMatchesMetadata(auditScope, metadata)) return;

        const affectedDate = audit.oldData?.createdAt
            || audit.metadata?.originalCreatedAt
            || transaction?.createdAt
            || audit.newData?.createdAt;
        const affected = new Date(affectedDate);
        if (Number.isNaN(affected.getTime()) || affected < start || affected > end) return;
        const closedAt = closeByDay.get(dateKey(affected));
        const changedAt = new Date(audit.createdAt);
        if (!closedAt || Number.isNaN(changedAt.getTime()) || changedAt <= closedAt) return;

        const transactionId = audit.metadata?.transactionId || transaction?.customId || toStringId(audit.targetId);
        auditedTransactions.add(transactionId);
        notes.push({
            transactionId,
            affectedDay: dateKey(affected),
            closedAt,
            changedAt,
            actor: audit.performedByName || 'الإدارة',
            action: ACTION_LABELS[audit.action] || audit.action,
            details: compactText(changedFieldsSummary(audit.oldData, audit.newData)
                || audit.metadata?.reason
                || transaction?.adminNotes
                || 'تم تعديل الحركة بعد الإقفال المالي.')
        });
    });

    transactions.forEach((transaction) => {
        const transactionId = transaction.customId || toStringId(transaction._id);
        if (auditedTransactions.has(transactionId)) return;
        const affectedDay = dateKey(transaction.createdAt);
        const closedAt = closeByDay.get(affectedDay);
        const changedAt = new Date(transaction.updatedAt || transaction.createdAt);
        if (!closedAt || Number.isNaN(changedAt.getTime()) || changedAt <= closedAt) return;
        notes.push({
            transactionId,
            affectedDay,
            closedAt,
            changedAt,
            actor: transaction.cancelledBy || 'الإدارة أو النظام',
            action: 'تغيير مالي بعد الإقفال',
            details: compactText(transaction.adminNotes || transaction.cancellationReason || `الحالة الحالية: ${transaction.status}`)
        });
    });

    return notes.sort((left, right) => right.changedAt - left.changedAt);
};

const loadAuditLogs = async ({ transactions, auditScope, start, end, settlements }) => {
    if (!settlements.length) return [];
    const transactionIds = transactions.map((transaction) => transaction._id).filter(Boolean);
    const customIds = transactions.map((transaction) => transaction.customId).filter(Boolean);
    const earliestClose = settlements.reduce((earliest, settlement) => {
        const value = new Date(settlement.closedAt || settlement.approvedAt || settlement.createdAt);
        return !earliest || value < earliest ? value : earliest;
    }, null);
    const alternatives = [
        { 'metadata.originalCreatedAt': { $gte: start, $lte: end } },
        { 'metadata.newCreatedAt': { $gte: start, $lte: end } }
    ];
    if (transactionIds.length) alternatives.push({ targetId: { $in: transactionIds } });
    if (customIds.length) alternatives.push({ 'metadata.transactionId': { $in: customIds } });

    const logs = await AuditLog.find({
        action: { $in: REPORT_CHANGE_ACTIONS },
        createdAt: { $gte: earliestClose },
        $or: alternatives
    }).sort({ createdAt: -1 }).lean();

    return logs.filter((audit) => {
        if (transactionIds.some((id) => toStringId(id) === toStringId(audit.targetId))) return true;
        if (customIds.includes(audit.metadata?.transactionId)) return true;
        return scopeMatchesMetadata(auditScope, audit.metadata);
    });
};

const loadAdminReport = async (input = {}) => {
    const range = getDateRange(input.dateType, input.dateValue);
    const scope = await resolveReportScope(input);
    const previousQuery = { ...scope.baseQuery, createdAt: { $lt: range.start } };
    const currentQuery = { ...scope.baseQuery, createdAt: { $gte: range.start, $lte: range.end } };

    const [previousTransactions, currentTransactions, settlements] = await Promise.all([
        findReportTransactions(previousQuery, { select: 'status amount costLYD' }),
        findReportTransactions(currentQuery, { sort: { createdAt: -1 } }),
        ensureDailySettlements(range.start, range.end)
    ]);

    const calculated = buildReportSummary({
        previousTransactions,
        currentTransactions,
        isExecutor: scope.isExecutor
    });
    const transactionCustomIds = currentTransactions.map((transaction) => transaction.customId).filter(Boolean);
    const ledgerQuery = buildStatementLedgerQuery(transactionCustomIds, scope.isExecutor);
    const [movements, auditLogs] = await Promise.all([
        transactionCustomIds.length
            ? Ledger.find(ledgerQuery)
                .sort({ createdAt: -1 })
                .lean()
            : [],
        loadAuditLogs({
            transactions: currentTransactions,
            auditScope: scope.auditScope,
            start: range.start,
            end: range.end,
            settlements
        })
    ]);

    const closedDayChanges = buildPostCloseChanges({
        transactions: currentTransactions,
        settlements,
        auditLogs,
        auditScope: scope.auditScope,
        start: range.start,
        end: range.end
    });
    const closedDays = settlements.map((settlement) => ({
        day: dateKey(settlement.period?.start),
        closedAt: settlement.closedAt || settlement.approvedAt || settlement.createdAt,
        closedBy: settlement.closedByName || settlement.approvedByName || 'الإقفال المالي الآلي'
    })).sort((left, right) => left.day.localeCompare(right.day));

    return sanitizeAccountStatementReport({
        success: true,
        entityInfo: scope.entityInfo,
        range,
        scope: {
            mainCategory: input.mainCategory,
            subId: input.subId,
            subType: input.subType || 'all'
        },
        ...calculated,
        movements,
        closedDayChanges,
        closure: {
            closedDays,
            closedDayCount: closedDays.length,
            hasPostCloseChanges: closedDayChanges.length > 0,
            status: closedDays.length ? 'closed' : 'open'
        }
    });
};

module.exports = {
    ACTION_LABELS,
    REPORT_CHANGE_ACTIONS,
    buildStatementLedgerQuery,
    buildPostCloseChanges,
    buildScopeMetadata,
    dateKey,
    getDateRange,
    loadAdminReport,
    resolveReportScope,
    scopeMatchesMetadata
};
