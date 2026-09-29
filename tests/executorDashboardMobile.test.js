const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'views/executor/dashboard.ejs'), 'utf8');
const mobileStyles = fs.readFileSync(path.join(root, 'public/css/executor-dashboard-mobile.css'), 'utf8');

describe('executor manager mobile dashboard', () => {
    test('loads the mobile layout after the executor theme styles and scopes it to managers', () => {
        expect(dashboard).toMatch(/executor-os\.css[^\n]*\n\s*<link rel="stylesheet" href="\/css\/executor-dashboard-mobile\.css/);
        expect(dashboard).toContain("emp.role === 'manager' ? 'executor-role-manager' : ''");
    });

    test('keeps the manager command bar and mobile dock fixed within the phone viewport', () => {
        expect(mobileStyles).toMatch(/\.exo-command\s*\{[^}]*position:\s*fixed\s*!important/s);
        expect(mobileStyles).toMatch(/\.exo-dock\s*\{[^}]*position:\s*fixed\s*!important/s);
        expect(mobileStyles).toContain('env(safe-area-inset-bottom)');
    });

    test('uses compact mobile task data and separate bank and post-card visual classes', () => {
        expect(dashboard).toContain("? 'task-post-card'");
        expect(dashboard).toContain("'task-bank-transfer'");
        expect(dashboard).toContain('task-card ${cardClass} ${transferVisualClass}');
        expect(mobileStyles).toContain('.executor-task-data-cell:first-child');
        expect(mobileStyles).toContain('.task-bank-transfer .executor-task-icon');
        expect(mobileStyles).toContain('.task-post-card .executor-task-icon');
    });
});
