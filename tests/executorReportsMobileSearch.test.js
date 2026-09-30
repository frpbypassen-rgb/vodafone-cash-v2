const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const view = fs.readFileSync(path.join(root, 'views/executor/reports.ejs'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public/css/executor-report-controls.css'), 'utf8');

describe('executor reports mobile search', () => {
    test('separates quick search from report filters and searches while typing', () => {
        expect(view).toContain('id="reportSearch"');
        expect(view).toContain('role="search"');
        expect(view).toMatch(/id="reportSearch"[^>]*oninput="scheduleExecutorOperationSearch\(\)"/);
        expect(view).not.toContain('report-search-submit');
        expect(view).toContain('reportSearchTimer = setTimeout(searchExecutorOperations, 450)');
        expect(view.indexOf('executor-report-search-block')).toBeLessThan(view.indexOf('executor-report-filters'));
        expect(view).toContain('/css/executor-report-controls.css?v=20260930-compact-filters');
    });

    test('keeps employee selection limited to manager and accountant in the view', () => {
        expect(view).toContain("['manager', 'accountant'].includes(emp.role)");
        expect(view).toContain('/executor-portal/reports/employees');
        expect(view).toContain('id="btnDownloadPdf"');
        expect(view).toContain("getElementById('reportDownloadContainer').classList.toggle('d-none', Boolean(search))");
        expect(view).toContain("document.getElementById('dateType').value = 'range'");
        expect(view).toContain('id="dateFrom"');
        expect(view).toContain('id="dateTo"');
    });

    test('uses compact phone controls and operation cards', () => {
        expect(styles).toMatch(/@media \(max-width: 767\.98px\)\s*\{[\s\S]*?body\.executor-page-reports \.executor-report-search\s*\{[^}]*height:\s*42px/s);
        expect(styles).toMatch(/body\.executor-page-reports \.executor-report-search \.form-control\s*\{[^}]*min-width:\s*0;[^}]*font-size:\s*16px/s);
        expect(styles).toContain('.x-mobile-card-details');
        expect(view).toContain('id="mobileReportList"');
        expect(view.indexOf('executor-report-shortcuts mb-3')).toBeGreaterThan(view.indexOf('executor-report-filters'));
        expect(styles).toContain('.executor-report-filters { padding: 8px 10px;');
    });
});
