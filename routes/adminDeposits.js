'use strict';

const express = require('express');
const Transaction = require('../models/Transaction');
const SupportTicket = require('../models/SupportTicket');
const { requireAuth } = require('../middlewares/auth');
const { escapeRegex } = require('../middlewares/sanitize');
const { systemDateRange } = require('../config/systemTime');
const { adminAccountScope } = require('../utils/tenantScope');
const { adminHrefVisible } = require('../config/adminRoles');
const {
    DEPOSIT_PARTIES,
    buildAdminDepositQuery,
    classifyDepositParty,
    companySupportDepositRows,
    normalizeFundingStatus,
    normalizeParty
} = require('../services/adminDepositLedgerService');

const router = express.Router();

const PARTY_LABELS = {
    all: 'كل الإيداعات',
    company: 'إيداعات الشركات',
    executor: 'إيداعات التنفيذ',
    client: 'إيداعات العملاء'
};

const ACTIVE_PAGES = {
    all: 'admin_deposits',
    company: 'admin_deposits_company',
    executor: 'admin_deposits_executor',
    client: 'admin_deposits_client'
};

const mergeDeposits = (rows) => {
    const seen = new Set();
    const merged = [];
    rows.forEach((row) => {
        const key = String(row._id || row.customId || '');
        if (!key || seen.has(key)) return;
        seen.add(key);
        merged.push(row);
    });
    const rank = { deposit_pending: 0, deposit: 1, deduction: 2 };
    return merged.sort((left, right) => {
        const statusDelta = (rank[left.status] ?? 9) - (rank[right.status] ?? 9);
        if (statusDelta) return statusDelta;
        return new Date(right.createdAt || 0) - new Date(left.createdAt || 0);
    });
};

router.get('/transactions/deposits', requireAuth, async (req, res) => {
    try {
        const party = normalizeParty(req.query.party);
        const status = normalizeFundingStatus(req.query.status);
        const search = String(req.query.search || '').trim().slice(0, 80);
        const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fromDate || '') ? req.query.fromDate : '';
        const toDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.toDate || '') ? req.query.toDate : '';
        const query = buildAdminDepositQuery({
            party,
            status,
            scope: adminAccountScope(req)
        });
        const createdAt = (fromDate || toDate) ? systemDateRange(fromDate, toDate) : null;
        if (createdAt) query.createdAt = createdAt;
        if (search) {
            const safeSearch = escapeRegex(search);
            query.$and = [
                ...(Array.isArray(query.$and) ? query.$and : []),
                {
                    $or: [
                        { customId: { $regex: safeSearch, $options: 'i' } },
                        { companyName: { $regex: safeSearch, $options: 'i' } },
                        { employeeName: { $regex: safeSearch, $options: 'i' } },
                        { executorName: { $regex: safeSearch, $options: 'i' } },
                        { notes: { $regex: safeSearch, $options: 'i' } }
                    ]
                }
            ];
        }

        const pendingQuery = status && status !== 'deposit_pending'
            ? null
            : { ...query, status: 'deposit_pending' };
        const [pendingRows, recentRows, supportTickets] = await Promise.all([
            pendingQuery
                ? Transaction.find(pendingQuery).sort({ createdAt: -1 }).limit(100).lean()
                : Promise.resolve([]),
            Transaction.find(query).sort({ createdAt: -1 }).limit(150).lean(),
            (party === 'company' || party === 'all')
                ? SupportTicket.find({
                    entityType: 'client_company',
                    'messages.text': { $regex: 'طلب إيداع رصيد' }
                }).select('ticketId name phone status messages updatedAt createdAt entityType').sort({ updatedAt: -1 }).limit(40).lean()
                : Promise.resolve([])
        ]);

        const deposits = mergeDeposits([...pendingRows, ...recentRows]).map((row) => ({
            ...row,
            party: classifyDepositParty(row)
        }));
        const supportDeposits = supportTickets
            .flatMap((ticket) => companySupportDepositRows(ticket))
            .filter((row) => !status || row.status === status)
            .slice(0, 40);

        return res.render('admin_deposits', {
            activePage: ACTIVE_PAGES[party],
            adminName: req.session.adminName,
            party,
            parties: DEPOSIT_PARTIES,
            partyLabels: PARTY_LABELS,
            deposits,
            supportDeposits,
            filters: { party, status, search, fromDate, toDate },
            query: req.query,
            canReviewSupport: adminHrefVisible(req.session.adminRole, '/support')
        });
    } catch (error) {
        console.error('[adminDeposits] failed:', error.message);
        return res.status(500).send('تعذر تحميل إيداعات الإدارة');
    }
});

module.exports = router;
