'use strict';
const businessPortalService = require('../../services/businessPortalService');
const centralReportService = require('../../services/centralReportService');
const { logAction } = require('../../services/auditService');
const { createCentralAgentReportPdf } = require('../../services/agentCentralReportService');

exports.downloadCentralAgentReportPdf = async (req,res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        const {input,pdf} = await createCentralAgentReportPdf(workspace,req.query);
        await logAction({action:'CENTRAL_ADMIN_REPORT_PDF_DOWNLOADED',req,performedById:workspace.actor._id,performedByModel:workspace.actorModel,performedByName:workspace.actor.name,targetId:workspace.entity._id,targetModel:'User',metadata:{...input,source:'admin_report_service'},success:true,severity:'info'});
        res.setHeader('Content-Type','application/pdf');
        res.setHeader('Content-Length',pdf.length);
        res.setHeader('Content-Disposition',`attachment; filename="central-agent-report-${String(input.dateValue).replace(/[^0-9-]/g,'_')}.pdf"`);
        res.setHeader('Cache-Control','private, no-store, max-age=0');
        return res.end(pdf);
    } catch(error) {
        const status = error.statusCode === 403 ? 403 : error.message === 'INVALID_REPORT_DATE' ? 400 : error.code === 'PDF_BROWSER_NOT_FOUND' ? 503 : 500;
        return res.status(status).send(status===403?'لا تملك صلاحية تنزيل كشف الوكالة الشامل.':status===400?'الفترة المحددة غير صحيحة.':'تعذر إعداد كشف الإدارة الشامل حاليًا.');
    }
};

exports.exportReportCsv = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        if (!workspace.permissions.canViewReports) return res.status(403).send('Forbidden');
        const report = await businessPortalService.loadReports(workspace, req.query);
        const artifact = report.centralReport || centralReportService.buildArtifact({ workspace, report });
        const fileName = `central-${report.reportScope}-${artifact.reportId}.csv`;
        await logAction({
            action: 'CENTRAL_REPORT_DOWNLOADED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: workspace.entity._id,
            targetModel: workspace.entityModel,
            metadata: {
                reportId: artifact.reportId,
                checksum: artifact.checksum,
                scope: report.reportScope,
                period: report.filters?.label || '',
                source: artifact.source,
            },
            success: true,
            severity: 'info',
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        return res.send(centralReportService.buildCsv({ workspace, report, artifact }));
    } catch (error) {
        console.error('[Business Portal] CSV export failed:', error.message);
        return res.status(500).send('تعذر تصدير التقرير.');
    }
};
