'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middlewares/auth');
const { logAction } = require('../services/auditService');
const {
    exportLiveTransactions,
    getLiveMetrics,
    getTransactionDetail,
    listLiveTransactions
} = require('../services/liveOperationsService');
const { getGeoHeatmap } = require('../services/opsGeoHeatmapService');
const { compareClientBehavior } = require('../services/clientBehaviorComparisonService');

const readAccess = [requireAuth, requirePermission('transactions.read')];
const csvCell = (value) => {
    let text = value == null ? '' : String(value);
    if (/^[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
};
const auditQuery = (req, action, metadata) => logAction({
    action, req,
    performedById: req.session.adminId || null,
    performedByModel: 'Admin',
    performedByName: req.session.adminName || 'الإدارة',
    metadata,
    success: true
});

router.get('/transactions/live', ...readAccess, (req, res) => res.render('live_operations', {
    activePage: 'transactions_live',
    adminName: req.session.adminName,
    csrfToken: res.locals.csrfToken || ''
}));

router.get('/api/admin/ops/geo-heatmap', ...readAccess, async (req, res) => {
    try {
        const heatmap = await getGeoHeatmap(req);
        return res.json({ success: true, ...heatmap });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر تحميل الخريطة الحرارية.' });
    }
});

router.get('/api/admin/ops/behavior-comparison', ...readAccess, async (req, res) => {
    try {
        const type = String(req.query.type || 'user').toLowerCase() === 'company' ? 'company' : 'user';
        const id = String(req.query.id || '').trim();
        const comparison = await compareClientBehavior(req, { id, type });
        if (!comparison) return res.status(404).json({ success: false, error: 'الحساب غير موجود.' });
        return res.json({ success: true, ...comparison });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر تحميل مقارنة السلوك.' });
    }
});

router.get('/api/transactions/live', ...readAccess, async (req, res) => {
    try {
        const [result, metrics] = await Promise.all([listLiveTransactions(req), getLiveMetrics(req)]);
        const hasFilters = ['q', 'status', 'type', 'range', 'minAmount', 'maxAmount', 'from', 'to']
            .some((key) => String(req.query[key] || '').trim());
        if (hasFilters) auditQuery(req, 'TRANSACTION_LIVE_SEARCH', { filters: req.query }).catch(() => {});
        return res.json({ success: true, ...result, metrics, serverTime: new Date().toISOString() });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر تحميل العمليات الحية.' });
    }
});

router.get('/api/transactions/live/:id', ...readAccess, async (req, res) => {
    try {
        const detail = await getTransactionDetail(req, req.params.id);
        if (!detail) return res.status(404).json({ success: false, error: 'العملية غير موجودة.' });
        return res.json({ success: true, ...detail });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر تحميل تفاصيل العملية.' });
    }
});

router.get('/transactions/live/:id/receipt', ...readAccess, async (req, res) => {
    const detail = await getTransactionDetail(req, req.params.id).catch(() => null);
    if (!detail) return res.status(404).send('العملية غير موجودة.');
    return res.render('live_operation_receipt', { detail, printedAt: new Date() });
});

router.get('/api/transactions/live-export.csv', ...readAccess, async (req, res) => {
    try {
        const rows = await exportLiveTransactions(req);
        const header = ['رقم العملية', 'الحالة', 'النوع', 'العميل', 'المستلم', 'المبلغ EGP', 'التكلفة LYD', 'المنفذ', 'وقت الإنشاء'];
        const lines = [header, ...rows.map((row) => [
            row.reference, row.status, row.type, row.customer, row.recipient,
            row.amount, row.costLYD, row.executor, new Date(row.createdAt).toISOString()
        ])].map((line) => line.map(csvCell).join(','));
        await auditQuery(req, 'TRANSACTION_LIVE_EXPORT', { filters: req.query, exportedRows: rows.length });
        const filename = `live-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="${filename}"`);
        return res.send(`\uFEFF${lines.join('\r\n')}`);
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر تصدير البيانات.' });
    }
});

module.exports = router;
