const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const view = fs.readFileSync(path.join(root, 'views/executor/reports.ejs'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public/css/executor-report-controls.css'), 'utf8');

describe('executor reports mobile search', () => {
    test('keeps search, clear, and Enter wired to the existing handlers', () => {
        expect(view).toContain('id="reportSearch"');
        expect(view).toContain('role="search"');
        expect(view).toMatch(/id="reportSearch"[^>]*searchExecutorOperations\(\)/);
        expect(view).toMatch(/class="[^"]*report-search-submit"[^>]*onclick="searchExecutorOperations\(\)"/);
        expect(view).toMatch(/class="[^"]*report-search-clear"[^>]*onclick="clearExecutorOperationSearch\(\)"/);
        expect(view).toContain('/css/executor-report-controls.css?v=20260930-mobile-search');
    });

    test('uses phone-only compact controls without changing desktop search layout', () => {
        expect(styles).toMatch(/@media \(max-width: 767\.98px\)\s*\{[\s\S]*?body\.executor-page-reports \.executor-report-search\s*\{[^}]*height:\s*44px/s);
        expect(styles).toMatch(/body\.executor-page-reports \.executor-report-search \.form-control\s*\{[^}]*min-width:\s*0;[^}]*font-size:\s*16px/s);
        expect(styles).toContain('.report-search-button-label { display: none; }');
    });
});
