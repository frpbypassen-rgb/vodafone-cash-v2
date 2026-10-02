const fs = require('node:fs');
const path = require('node:path');

test('executor team loads its compact mobile stylesheet after shared styles', () => {
    const view = fs.readFileSync(path.join(__dirname, '../views/executor/employees.ejs'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../public/css/executor-team-mobile.css'), 'utf8');
    expect(view).toMatch(/executor-os\.css[^"']*["'][\s\S]*executor-team-mobile\.css\?v=20261002-compact/);
    expect(css).toMatch(/@media \(max-width: 768px\)/);
    expect(css).toMatch(/\.executor-summary-card:has\(\.summary-help\)/);
    expect(css).toMatch(/\.executor-summary-card \.summary-help \{ display: none; \}/);
    expect(css).toMatch(/\.mobile-emp-card \{ gap: 7px; padding: 9px;/);
});
