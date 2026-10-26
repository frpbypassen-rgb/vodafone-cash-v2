'use strict';
jest.mock('../services/adminReportService', () => ({ loadAdminReport: jest.fn() }));
jest.mock('../services/reportPdfService', () => ({ generateAdminReportPdf: jest.fn() }));
const { createStatementPdf, statementInput } = require('../services/agentDailyStatementService');
const { loadAdminReport } = require('../services/adminReportService');
const { generateAdminReportPdf } = require('../services/reportPdfService');
const workspace = { isAgent: true, entity: { _id: 'agency-id', tenantId: 'tenant-id' }, permissions: { canViewReports: true, canViewBalance: true, canViewAllReports: true } };
test('daily attachment reuses the administration loader, PDF generator and agency filter', async () => {
    const report = { success: true, scope: { mainCategory: 'agent', subId: 'agency-id' } };
    loadAdminReport.mockResolvedValue(report);
    generateAdminReportPdf.mockResolvedValue(Buffer.from('admin-pdf'));
    expect(await createStatementPdf(workspace, '2026-10-25')).toEqual(Buffer.from('admin-pdf'));
    expect(loadAdminReport).toHaveBeenCalledWith({ mainCategory: 'agent', subId: 'agency-id', subType: 'all', dateType: 'day', dateValue: '2026-10-25', tenantId: 'tenant-id' }, { readOnly: true });
    expect(generateAdminReportPdf).toHaveBeenCalledWith(expect.objectContaining({ render: expect.any(Function) }), { report, generatedAt: expect.any(Date), adminName: 'الإدارة' });
});
test('statement dates are explicit and invalid dates are rejected', () => {
    expect(() => statementInput(workspace, '2026-10-99')).toThrow('INVALID_REPORT_DAY');
});
