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
        expect(dashboard).toContain("activeTaskId ? 'العملية النشطة' : 'منصة التنفيذ'");
        expect(dashboard).toContain('جار فتح العملية النشطة');
        expect(dashboard).toContain('ownedTasks.filter(t => String(t._id) === activeTaskId)');
        expect(dashboard).toContain("window.location.assign('/executor-portal/dashboard')");
        expect(dashboard).toContain("${activeTaskId ? '' : `<button onclick=\"returnTask(");
        expect(mobileStyles).toContain('body.executor-page-dashboard.executor-active-task .exo-dock');
        expect(mobileStyles).toContain('repeating-linear-gradient(135deg');
        expect(mobileStyles).toContain('.task-card.task-bank-transfer .executor-task-icon');
        expect(mobileStyles).toContain('background: #256fc4 !important');
    });

    test('labels cash and bank with text and shape, and surfaces load or connection failures', () => {
        expect(dashboard).toContain('class="task-kind-label">${escapeTaskHtml(typeMeta.short)}');
        expect(dashboard).toContain('data-task-kind="${escapeTaskHtml(typeMeta.short)}"');
        expect(dashboard).toContain('id="taskBoardStatus"');
        expect(dashboard).toContain('انقطع الاتصال. تبقى آخر المهام ظاهرة حتى يعود الإنترنت.');
        expect(dashboard).toContain('تعذر تحميل العملية النشطة. ستتم إعادة المحاولة تلقائيًا.');
        expect(dashboard).toContain("acceptTask('${t._id}', this)");
        expect(dashboard).toContain("button.setAttribute('aria-busy', 'true')");
        expect(dashboard).toContain('executor-focus-hint');
        expect(dashboard).toContain("window.addEventListener('offline'");
        expect(dashboard).toContain('let lastTasksHash = null');
        expect(mobileStyles).toContain('.task-card.task-cash-transfer .task-kind-label');
        expect(mobileStyles).toContain('.task-card.task-bank-transfer .task-kind-label');
        expect(mobileStyles).toMatch(/\.task-card\.task-cash-transfer \.task-kind-label\s*\{[^}]*border-radius:\s*999px/s);
        expect(mobileStyles).toMatch(/\.task-card\.task-bank-transfer \.task-kind-label\s*\{[^}]*border-radius:\s*2px/s);
        expect(mobileStyles).toMatch(/\.task-card\.task-bank-transfer \.task-kind-label\s*\{[^}]*border-style:\s*dashed/s);
        expect(sharedStyles).toMatch(/\.exo-icon-btn\s*\{[^}]*min-height:\s*44px/);
    });

    test('keeps the empty queue readable, clears the dock, and labels active-task actions', () => {
        expect(dashboard).toContain('class="executor-empty-mark"');
        expect(dashboard).toContain('غرفة العمليات هادئة');
        expect(dashboard).toContain("confirmButtonText: 'تأكيد الإلغاء'");
        expect(dashboard).not.toContain('executor-3d-alert.png');
        expect(dashboard).toContain('aria-label="رادار مراقبة العمليات"');
        expect(dashboard).toContain('aria-label="تعديل المبلغ"');
        expect(dashboard).toContain('aria-label="إلغاء العملية"');
        expect(dashboard).toContain("popup.setAttribute('dir', 'rtl')");
        expect(dashboard).toMatch(/if \(reason\) \{[\s\S]*?\/executor-portal\/api\/cancel-task\//);
        expect(mobileStyles).toContain('padding-bottom: calc(62px + env(safe-area-inset-bottom))');
        expect(mobileStyles).toContain('body.executor-page-dashboard.executor-active-task .btn-text-hide');
        expect(mobileStyles).toContain('#0b1929');
        expect(mobileStyles).toContain('#f8fafc');
        expect(mobileStyles).toContain('#1e293b');
        expect(mobileStyles).toContain('#e2e8f0');
        expect(mobileStyles).toContain('animation: none');
        expect(mobileStyles).not.toMatch(/\.exo-(?:command|dock)\s*\{/);
    });
});
