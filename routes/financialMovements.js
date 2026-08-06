'use strict';

const express = require('express');
const router = express.Router();
const Ledger = require('../models/Ledger');
const Transaction = require('../models/Transaction');
const { requireAuth } = require('../middlewares/auth');
const { escapeRegex } = require('../middlewares/sanitize');
const { systemDayEnd, systemDayStart } = require('../config/systemTime');

const MOVEMENT_TYPES = ['DEPOSIT', 'DEDUCTION', 'TRANSFER', 'COMMISSION', 'REFUND', 'REVERSAL'];
const ENTITY_MODELS = ['User', 'ClientCompany', 'ClientBot', 'SubAccount', 'ExecutorBot', 'ExecutorGroup'];
const SORT_FIELDS = new Set(['createdAt', 'amount', 'balanceBefore', 'balanceAfter', 'type', 'entityModel']);

const parseDateRange = (query) => {
    const range = {};
    if (query.fromDate) {
        const from = systemDayStart(query.fromDate);
        if (from) range.$gte = from;
    }
    if (query.toDate) {
        const to = systemDayEnd(query.toDate);
        if (to) range.$lte = to;
    }
    return Object.keys(range).length ? range : null;
};

const buildLedgerFilter = async (query) => {
    const filter = {};
    const dateRange = parseDateRange(query);
    if (dateRange) filter.createdAt = dateRange;

    if (MOVEMENT_TYPES.includes(query.type)) filter.type = query.type;
    if (ENTITY_MODELS.includes(query.entityModel)) filter.entityModel = query.entityModel;

    const minAmount = Number(query.minAmount);
    const maxAmount = Number(query.maxAmount);
    if (Number.isFinite(minAmount) || Number.isFinite(maxAmount)) {
        filter.amount = {};
        if (Number.isFinite(minAmount)) filter.amount.$gte = minAmount;
        if (Number.isFinite(maxAmount)) filter.amount.$lte = maxAmount;
    }

    if (query.direction === 'in') filter.amount = { ...(filter.amount || {}), $gt: 0 };
    if (query.direction === 'out') filter.amount = { ...(filter.amount || {}), $lt: 0 };

    const search = String(query.search || '').trim();
    if (search) {
        const safe = escapeRegex(search);
        const txMatches = await Transaction.find({
            $or: [
                { customId: { $regex: safe, $options: 'i' } },
                { companyName: { $regex: safe, $options: 'i' } },
                { employeeName: { $regex: safe, $options: 'i' } },
                { vodafoneNumber: { $regex: safe, $options: 'i' } },
                { accountNumber: { $regex: safe, $options: 'i' } },
                { cancellationNumber: { $regex: safe, $options: 'i' } }
            ]
        }).select('customId').limit(300).lean();

        const txIds = txMatches.map((tx) => tx.customId).filter(Boolean);
        filter.$or = [
            { transactionId: { $regex: safe, $options: 'i' } },
            { description: { $regex: safe, $options: 'i' } }
        ];
        if (txIds.length) filter.$or.push({ transactionId: { $in: txIds } });
    }

    return filter;
};

const enrichMovements = async (ledgers) => {
    const txIds = [...new Set(ledgers.map((item) => item.transactionId).filter(Boolean))];
    const txs = await Transaction.find({ customId: { $in: txIds } })
        .select('customId status amount costLYD companyName employeeName vodafoneNumber transferType cancellationNumber cancellationReason executorName proofImage proofImages createdAt updatedAt')
        .lean();
    const txMap = new Map(txs.map((tx) => [tx.customId, tx]));

    return ledgers.map((ledger) => ({
        ...ledger,
        transaction: txMap.get(ledger.transactionId) || null
    }));
};

const summarize = async (filter) => {
    const [summary] = await Ledger.aggregate([
        { $match: filter },
        {
            $group: {
                _id: null,
                count: { $sum: 1 },
                totalIn: { $sum: { $cond: [{ $gt: ['$amount', 0] }, '$amount', 0] } },
                totalOut: { $sum: { $cond: [{ $lt: ['$amount', 0] }, { $abs: '$amount' }, 0] } },
                net: { $sum: '$amount' },
                maxMovement: { $max: '$amount' },
                minMovement: { $min: '$amount' }
            }
        }
    ]);

    const byType = await Ledger.aggregate([
        { $match: filter },
        { $group: { _id: '$type', count: { $sum: 1 }, net: { $sum: '$amount' } } },
        { $sort: { count: -1 } }
    ]);

    return {
        count: summary?.count || 0,
        totalIn: summary?.totalIn || 0,
        totalOut: summary?.totalOut || 0,
        net: summary?.net || 0,
        maxMovement: summary?.maxMovement || 0,
        minMovement: summary?.minMovement || 0,
        byType
    };
};

const csvEscape = (value) => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

router.get('/financial-movements', requireAuth, async (req, res) => {
    try {
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const limit = Math.min(200, Math.max(25, Number.parseInt(req.query.limit, 10) || 50));
        const sortField = SORT_FIELDS.has(req.query.sortBy) ? req.query.sortBy : 'createdAt';
        const sortDir = req.query.sortDir === 'asc' ? 1 : -1;
        const filter = await buildLedgerFilter(req.query);

        const [total, ledgers, stats] = await Promise.all([
            Ledger.countDocuments(filter),
            Ledger.find(filter).sort({ [sortField]: sortDir }).skip((page - 1) * limit).limit(limit).lean(),
            summarize(filter)
        ]);

        const movements = await enrichMovements(ledgers);
        const pages = Math.max(1, Math.ceil(total / limit));

        res.render('financial_movements', {
            activePage: 'financial_movements',
            adminName: req.session.adminName,
            movements,
            stats,
            filters: req.query,
            movementTypes: MOVEMENT_TYPES,
            entityModels: ENTITY_MODELS,
            pagination: { page, pages, total, limit, sortField, sortDir }
        });
    } catch (error) {
        console.error('[financial-movements] error:', error.message);
        res.status(500).send('تعذر تحميل الحركات المالية');
    }
});

router.get('/financial-movements/export.csv', requireAuth, async (req, res) => {
    try {
        const filter = await buildLedgerFilter(req.query);
        const ledgers = await Ledger.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
        const movements = await enrichMovements(ledgers);

        const headers = [
            'date',
            'ledger_id',
            'transaction_id',
            'type',
            'entity_model',
            'entity_id',
            'amount',
            'balance_before',
            'balance_after',
            'debit_account',
            'credit_account',
            'description',
            'transaction_status',
            'client',
            'target_number',
            'executor',
            'cancellation_number'
        ];

        const rows = movements.map((item) => [
            item.createdAt ? new Date(item.createdAt).toISOString() : '',
            item._id,
            item.transactionId,
            item.type,
            item.entityModel,
            item.entityId,
            item.amount,
            item.balanceBefore,
            item.balanceAfter,
            item.debitAccount,
            item.creditAccount,
            item.description,
            item.transaction?.status,
            item.transaction?.companyName || item.transaction?.employeeName,
            item.transaction?.vodafoneNumber,
            item.transaction?.executorName,
            item.transaction?.cancellationNumber
        ]);

        const csv = [headers, ...rows]
            .map((row) => row.map(csvEscape).join(','))
            .join('\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="financial_movements_${Date.now()}.csv"`);
        res.send(`\uFEFF${csv}`);
    } catch (error) {
        res.status(500).send('EXPORT_FAILED');
    }
});

module.exports = router;
