'use strict';
const businessPortalService = require('../../services/businessPortalService');
const centralReportService = require('../../services/centralReportService');
const { logAction } = require('../../services/auditService');

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
