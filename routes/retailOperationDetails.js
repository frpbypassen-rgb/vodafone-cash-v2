'use strict';
const router = require('express').Router();
const { requireClientAuth } = require('../middlewares/clientPortalAuth');
const { resolve } = require('../services/customerNotificationContext');
const service = require('../services/retailOperationDetailsService');
const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');
const pdfLimiter = require('../utils/requestRateLimit')({
    windowMs: 60000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.session.accountType}:${req.session.clientId}`,
    message: { error: 'يرجى الانتظار دقيقة قبل تحميل تقرير آخر.' },
});
let activePdfRenders = 0;
router.get('/api/retail-reports/download.pdf', requireClientAuth, pdfLimiter, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    let claimed = false;
    try {
        const ctx = await resolve(req);
        if (activePdfRenders >= 2)
            return res.status(503).json({ error: 'مولد التقارير مشغول. حاول بعد قليل.' });
        activePdfRenders++;
        claimed = true;
        // Only the period comes from the browser; owner and tenant come from the session.
        const input = Object.fromEntries(
            ['dateType', 'dateValue', 'dateFrom', 'dateTo'].map((key) => [key, req.query[key]])
        );
        const { filters, start, end } = require('../services/retailReportsService').normalizeFilters(input);
        const report = await require('../services/customerDailyStatementService').loadPeriodStatement(ctx, {
            start,
            end,
            dateType: filters.dateType,
            dateValue: filters.dateValue,
            dateFrom: filters.dateFrom,
            dateTo: filters.dateTo,
        });
        const pdf = await require('../services/reportPdfService').generateAdminReportPdf(req.app, {
            report,
            generatedAt: new Date(),
            adminName: 'كشف حساب العميل',
        });
        const label =
            filters.dateType === 'range' ? `${filters.dateFrom}-${filters.dateTo}` : filters.dateValue;
        res.set({
            'Content-Type': 'application/pdf',
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': `attachment; filename="account-statement-${label.replace(/[^\d-]/g, '')}.pdf"`,
        });
        return res.send(pdf);
    } catch (error) {
        const status =
            error.statusCode ||
            (error.code === 'PDF_BROWSER_NOT_FOUND' ? 503 : error.message === 'REPORT_TOO_LARGE' ? 413 : 500);
        const message =
            error.message === 'REPORT_TOO_LARGE'
                ? 'التقرير كبير جدًا. اختر فترة أقصر.'
                : [400, 422].includes(status)
                  ? 'الفترة المحددة غير صالحة.'
                  : status === 403
                    ? 'غير متاح لهذا الحساب.'
                    : status === 503
                      ? 'مولد PDF غير متاح حاليًا. حاول لاحقًا.'
                      : 'تعذر تحميل التقرير. أعد المحاولة.';
        return res.status(status).json({ error: message });
    } finally {
        if (claimed) activePdfRenders--;
    }
});
router.get('/api/retail-reports', requireClientAuth, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
        const ctx = await resolve(req);
        res.json(await require('../services/retailReportsService').list(ctx, req.query));
    } catch (error) {
        res.status(error.statusCode || 500).json({
            error: error.statusCode ? error.message : 'تعذر تحميل التقرير. أعد المحاولة.',
        });
    }
});
router.use('/api/retail-transactions', requireClientAuth, (_req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
});
router.get('/api/retail-transactions/:id', async (req, res) => {
    try {
        const ctx = await resolve(req);
        const tx = await service.findOwn(ctx, req.params.id);
        res.json({ success: true, transaction: service.present(tx, ctx.actorModel) });
    } catch (error) {
        res.status(error.statusCode || 500).json({
            error: error.statusCode ? error.message : 'تعذر تحميل تفاصيل العملية. أعد المحاولة.',
        });
    }
});
router.get('/api/retail-transactions/:id/proof/:index', async (req, res) => {
    try {
        const ctx = await resolve(req);
        const tx = await service.findOwn(ctx, req.params.id);
        const id = service.proof(tx, req.params.index);
        await streamProofImage(proofSourceUrl(id), res);
    } catch (error) {
        if (!res.headersSent) res.status(error.statusCode || 500).json({ error: 'تعذر تحميل صورة الإثبات.' });
    }
});
module.exports = router;
