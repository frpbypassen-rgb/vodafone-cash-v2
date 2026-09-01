'use strict';

const centralReportService = require('../services/centralReportService');

describe('central report artifact', () => {
    const workspace = {
        isAgent: false,
        entity: { _id: 'company-01', name: 'شركة اختبار' },
        permissions: { canViewBalance: true }
    };
    const report = {
        reportScope: 'staff',
        reportScopeLabel: 'تقرير الموظفين',
        filters: { label: '2026-09-01 - 2026-09-02' },
        reportSummary: { totalCount: 2 },
        reportRows: [{ key: 'موظف اختبار', totalCount: 2, completedCount: 1, pendingCount: 1, cancelledCount: 0, totalEGP: 1500, totalLYD: 270, deposits: 0, deductions: 0, lastActivity: new Date('2026-09-01T12:00:00.000Z') }]
    };

    test('creates a traceable central report identity', () => {
        const artifact = centralReportService.buildArtifact({ workspace, report, issuedAt: new Date('2026-09-02T10:30:00.000Z') });
        expect(artifact.source).toContain('الإدارة المركزية');
        expect(artifact.reportId).toMatch(/^RPT-20260902103000-/);
        expect(artifact.checksum).toMatch(/^SHA-256:[A-F0-9]{16}$/);
    });

    test('includes central audit metadata in the downloaded CSV', () => {
        const artifact = centralReportService.buildArtifact({ workspace, report, issuedAt: new Date('2026-09-02T10:30:00.000Z') });
        const csv = centralReportService.buildCsv({ workspace, report, artifact });
        expect(csv).toContain('الإدارة المركزية');
        expect(csv).toContain(artifact.reportId);
        expect(csv).toContain('موظف اختبار');
    });
});
