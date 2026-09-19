'use strict';

const CorporatePaymentRequest = require('../models/CorporatePaymentRequest');
const Ledger = require('../models/Ledger');
const { CorporateError } = require('./corporateApprovalService');

const csvEscape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
};

const toCsv = (rows) => {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    return [headers.join(','), ...rows.map((row) => headers.map((key) => csvEscape(row[key])).join(','))].join('\n');
};

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const EXPORT_LIMIT = 500;

const scopedFilter = (context, extra = {}) => {
    const filter = { companyId: context.companyId, ...extra };
    if (!context.permissions.canViewAllOps) {
        filter.requesterId = context.actor._id;
    }
    return filter;
};

const loadOperations = async (context, query = {}) => {
    const filter = scopedFilter(context);
    if (query.status) filter.status = query.status;
    const requested = Number(query.limit);
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_LIST_LIMIT));
    const items = await CorporatePaymentRequest.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
    return items;
};

const buildExportRows = async (context, query = {}) => {
    const role = context.role;
    if (role === 'employee' && !context.permissions.canExportOwn) {
        throw new CorporateError('CORPORATE_FORBIDDEN', 'التصدير غير متاح.', 403);
    }
    if (role !== 'employee' && !context.permissions.canExport) {
        throw new CorporateError('CORPORATE_FORBIDDEN', 'التصدير غير متاح لدورك.', 403);
    }

    const requests = await loadOperations(context, { ...query, limit: EXPORT_LIMIT });

    if (role === 'accountant') {
        const ledger = await Ledger.find({
            entityId: context.companyId,
            entityModel: 'ClientCompany'
        }).sort({ createdAt: -1 }).limit(EXPORT_LIMIT).lean();

        const requestRows = requests.map((item) => ({
            section: 'request',
            reference: item.reference,
            status: item.status,
            amount: item.amount,
            originalCurrency: item.originalCurrency || item.currency || 'EGP',
            settledAmount: item.settledAmount || '',
            settledCurrency: item.settledCurrency || 'LYD',
            exchangeRate: item.exchangeRate || '',
            beneficiary: item.beneficiarySnapshot?.name || '',
            requester: item.requesterName,
            approver: item.approverName || '',
            reconciled: item.reconciled ? 'yes' : 'no',
            ledgerTransactionId: item.ledgerTransactionId || '',
            payoutTransactionId: item.payoutTransactionId || '',
            createdAt: item.createdAt?.toISOString?.() || item.createdAt
        }));
        const ledgerRows = ledger.map((entry) => ({
            section: 'ledger',
            reference: entry.transactionId,
            status: entry.type,
            amount: entry.amount,
            beneficiary: '',
            requester: '',
            approver: '',
            reconciled: '',
            ledgerTransactionId: entry.transactionId,
            createdAt: entry.createdAt?.toISOString?.() || entry.createdAt,
            balanceAfter: entry.balanceAfter,
            description: entry.description
        }));
        return {
            filename: `corporate-accountant-${Date.now()}.csv`,
            csv: toCsv([...requestRows, ...ledgerRows]),
            kind: 'accountant-recon'
        };
    }

    if (role === 'manager') {
        const rows = requests.map((item) => ({
            reference: item.reference,
            status: item.status,
            amount: item.amount,
            beneficiary: item.beneficiarySnapshot?.name || '',
            requester: item.requesterName,
            approver: item.approverName || '',
            createdAt: item.createdAt?.toISOString?.() || item.createdAt
        }));
        return {
            filename: `corporate-manager-summary-${Date.now()}.csv`,
            csv: toCsv(rows),
            kind: 'manager-summary'
        };
    }

    const rows = requests.map((item) => ({
        reference: item.reference,
        status: item.status,
        amount: item.amount,
        beneficiary: item.beneficiarySnapshot?.name || '',
        createdAt: item.createdAt?.toISOString?.() || item.createdAt
    }));
    return {
        filename: `corporate-employee-history-${Date.now()}.csv`,
        csv: toCsv(rows),
        kind: 'employee-history'
    };
};

const summarizeDashboard = (requests, company, role) => {
    const pending = requests.filter((item) => item.status === 'pending_approval');
    const executed = requests.filter((item) => item.status === 'executed');
    const rejected = requests.filter((item) => item.status === 'rejected');
    const volume = executed.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    return {
        pendingCount: pending.length,
        executedCount: executed.length,
        rejectedCount: rejected.length,
        volume,
        balance: role === 'employee' ? null : Number(company.balance || 0),
        creditLimit: role === 'employee' ? null : Number(company.creditLimit || 0)
    };
};

module.exports = {
    toCsv,
    scopedFilter,
    loadOperations,
    buildExportRows,
    summarizeDashboard,
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
    EXPORT_LIMIT
};
