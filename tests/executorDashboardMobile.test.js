const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'views/executor/dashboard.ejs'), 'utf8');
const mobileStyles = fs.readFileSync(path.join(root, 'public/css/executor-dashboard-mobile.css'), 'utf8');
const sharedStyles = fs.readFileSync(path.join(root, 'public/css/executor-os.css'), 'utf8');
const executorPages = ['dashboard', 'employees', 'deposits', 'reports', 'support', 'settings'];

describe('executor manager mobile dashboard', () => {
    test('loads the mobile layout after the executor theme styles and scopes it to managers', () => {
        expect(dashboard).toMatch(/executor-os\.css[^\n]*\n\s*<link rel="stylesheet" href="\/css\/executor-dashboard-mobile\.css/);
        expect(dashboard).toContain("emp.role === 'manager' ? 'executor-role-manager' : ''");
    });

    test('keeps identical fixed bars across every executor page on mobile', () => {
        for (const page of executorPages) {
            const view = fs.readFileSync(path.join(root, `views/executor/${page}.ejs`), 'utf8');
            expect(view).toContain('/css/executor-os.css?v=20260930-mobile-shell');
            expect(view).toContain("include('partials/navigation'");
            expect(view).toContain("include('partials/command-bar'");
        }
        expect(sharedStyles).toMatch(/@media \(max-width: 767\.98px\)\s*\{[\s\S]*?\.exo-command\s*\{[^}]*position:\s*fixed\s*!important[^}]*height:\s*54px/s);
        expect(sharedStyles).toMatch(/@media \(max-width: 767\.98px\)\s*\{[\s\S]*?\.exo-dock\s*\{[^}]*position:\s*fixed\s*!important[^}]*height:\s*62px/s);
        expect(sharedStyles).toContain('env(safe-area-inset-bottom)');
        expect(mobileStyles).not.toMatch(/\.exo-(?:command|dock)\s*\{/);
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
