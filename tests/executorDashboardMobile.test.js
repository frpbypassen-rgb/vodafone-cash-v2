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

    test('keeps the received task details and distinguishes cash, bank, and post-card types', () => {
        expect(dashboard).toContain("? 'task-post-card'");
        expect(dashboard).toContain("'task-bank-transfer'");
        expect(dashboard).toContain("normalizedTransferType === 'vodafone' ? 'task-cash-transfer'");
        expect(dashboard).toContain('task-card ${cardClass} ${transferVisualClass}');
        expect(dashboard).toContain('${recipientLabel}');
        expect(dashboard).toContain('${formattedAmount}');
        expect(dashboard).toContain('${safeBankName}');
        expect(dashboard).toContain('${escapeTaskHtml(bankMethodLabel)}');
        expect(mobileStyles).toContain('.executor-task-data-cell:first-child');
        expect(mobileStyles).toContain('.task-cash-transfer .executor-task-icon');
        expect(mobileStyles).toContain('.task-bank-transfer .executor-task-icon');
        expect(mobileStyles).toContain('.task-post-card .executor-task-icon');
        expect(mobileStyles).toMatch(/\.task-card\.task-cash-transfer\s*\{[^}]*border-radius:\s*8px/s);
        expect(mobileStyles).toMatch(/\.task-card\.task-bank-transfer\s*\{[^}]*border-radius:\s*3px/s);
        expect(mobileStyles).toMatch(/body\.executor-page-dashboard\.executor-portal-v2 \.task-card \.executor-task-data\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
    });

    test('focuses the accepted task until completion or cancellation and marks bank cards without text alone', () => {
        const routes = fs.readFileSync(path.join(root, 'routes/executorPortal.js'), 'utf8');
        expect(routes).toContain("router.get('/active-task/:id', requireExecutorAuth, requireExecutorTaskAccess, dashboardController.getActiveTask)");
        expect(dashboard).toContain('window.location.assign(activeTaskUrl(id))');
        expect(dashboard).toContain('ownedTasks.filter(t => String(t._id) === activeTaskId)');
        expect(dashboard).toContain("window.location.assign('/executor-portal/dashboard')");
        expect(dashboard).toContain("${activeTaskId ? '' : `<button onclick=\"returnTask(");
        expect(mobileStyles).toContain('body.executor-page-dashboard.executor-active-task .exo-dock');
        expect(mobileStyles).toContain('repeating-linear-gradient(135deg');
        expect(mobileStyles).toContain('.task-card.task-bank-transfer .executor-task-icon');
        expect(mobileStyles).toContain('background: #256fc4 !important');
    });
});
