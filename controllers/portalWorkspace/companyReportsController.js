'use strict';
const businessPortalService = require('../../services/businessPortalService');
const { generateAdminReportPdf } = require('../../services/reportPdfService');
const { logAction } = require('../../services/auditService');

exports.downloadCentralCompanyReportPdf = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        if (!workspace.isCompany || !workspace.permissions.canViewReports)
            return res.status(403).send('Forbidden');
        const { input, report } = await businessPortalService.loadCentralCompanyReport(workspace, req.query);
        const pdf = await generateAdminReportPdf(req.app, {
            report,
            generatedAt: new Date(),
            adminName: 'الإدارة المركزية',
        });
        const datePart = String(input.dateValue || '').replace(/[^0-9-]/g, '');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdf.length);
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="central-company-report-${datePart || Date.now()}.pdf"`
        );
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        logAction({
            action: 'CENTRAL_ADMIN_REPORT_PDF_DOWNLOADED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: workspace.entity._id,
            targetModel: 'ClientCompany',
            metadata: { ...input, source: 'admin_report_service' },
            success: true,
            severity: 'info',
        }).catch(() => {});
        return res.end(pdf);
    } catch (error) {
        console.error('[Business Portal] central company PDF failed:', error.message);
        const status = error.message === 'INVALID_REPORT_DATE' ? 400 : error.code === 'PDF_BROWSER_NOT_FOUND' ? 503 : 500;
        return res
            .status(status)
            .send(status === 400 ? 'الفترة المحددة غير صحيحة.' : status === 503 ? 'تعذر تشغيل مولد PDF المركزي حالياً.' : 'تعذر إعداد التقرير المركزي.');
    }
};
