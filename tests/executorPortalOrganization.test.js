const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const ejs = require('ejs');
const { portalAssets } = require('./helpers/executorPortalSources');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ownership = {
    pages: [
        'getDashboard',
        'getActiveTask',
        'getOverview',
        'getLiveTasks',
        'postClearAlert',
        'postClearDepAlert',
    ],
    proofImages: ['getProxyImage', 'getProxyExecutorImage'],
    settings: ['getSettings', 'patchSettingsProfile', 'postSettingsPassword'],
    employees: [
        'getEmployees',
        'getEmployeesList',
        'postEmployeesUpdate',
        'postEmployeesCreate',
        'postEmployeesToggle',
        'postEmployeesToggleReports',
        'postEmployeesResetPassword',
        'postEmployeesDelete',
    ],
    balancePools: [
        'postExternalEmployeeTransaction',
        'getBalancePools',
        'postBalancePoolCreate',
        'postBalancePoolRename',
        'postBalancePoolAttach',
        'postBalancePoolDetach',
        'postBalancePoolArchive',
    ],
    routing: [
        'postTaskRoutingMode',
        'postExecutionPolicy',
        'postEmployeeExecutionPolicy',
        'getRouteCandidates',
        'postRouteTask',
    ],
    deposits: ['getDeposits', 'getDepositRequests', 'postDepositRequest', 'postReviewAdminDeposit'],
    quickExecute: ['getQuickExecute', 'putQuickExecute', 'postQuickExecuteDial'],
};

describe('executor portal organization contracts', () => {
    test.each(Object.entries(ownership))('%s owns only its assigned request handlers', (name, expected) => {
        const source = read(`controllers/executor/dashboard/${name}Controller.js`);
        const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
        const exports = tree.statements
            .filter((node) => ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression))
            .map((node) => node.expression.left)
            .filter((node) => ts.isPropertyAccessExpression(node) && node.expression.getText() === 'exports')
            .map((node) => node.name.text);
        expect(exports).toEqual(expected);
        expect(source.split('\n').length).toBeLessThan(350);
    });

    test('keeps the original route import as a small compatibility facade', () => {
        const facade = read('controllers/executorDashboardController.js');
        for (const name of Object.keys(ownership))
            expect(facade).toContain(`require('./executor/dashboard/${name}Controller')`);
        expect(facade.split('\n').length).toBeLessThan(20);
        const handlers = Object.values(ownership).flat();
        expect(new Set(handlers).size).toBe(38);
        expect(read('routes/executorPortal.js')).toContain(
            "require('../controllers/executorDashboardController')"
        );
    });

    test.each(['dashboard', 'employees', 'reports', 'register'])(
        '%s keeps markup separate from static scripts and page CSS',
        (page) => {
            const template = read(`views/executor/${page}.ejs`);
            expect(() =>
                ejs.compile(template, { filename: path.join(root, `views/executor/${page}.ejs`) })
            ).not.toThrow();
            expect(template).not.toContain('<style>');
            expect(template).toContain(`/css/executor/pages/${page}.css`);
            expect(template.split('\n').length).toBeLessThan(600);
            const assets = portalAssets(template);
            expect(new Set(assets).size).toBe(assets.length);
            for (const asset of assets) {
                const source = read(asset);
                expect(source).not.toContain('<%');
                if (asset.endsWith('.js'))
                    expect(
                        ts.createSourceFile(asset, source, ts.ScriptTarget.Latest, true).parseDiagnostics
                    ).toEqual([]);
            }
            if (['dashboard', 'employees'].includes(page))
                expect(template.indexOf(`/css/executor/pages/${page}.css`)).toBeLessThan(
                    template.indexOf('/css/executor-os.css')
                );
            if (page === 'reports')
                expect(template.indexOf('/css/executor-os.css')).toBeLessThan(
                    template.indexOf('/css/executor/pages/reports.css')
                );
        }
    );

    test('loads dashboard polling only after state, rendering, and actions', () => {
        const assets = portalAssets(read('views/executor/dashboard.ejs')).filter((file) =>
            file.endsWith('.js')
        );
        const position = (name) => assets.indexOf(`public/js/executor/dashboard/${name}.js`);
        expect(position('state')).toBeLessThan(position('proofs'));
        expect(position('proofs')).toBeLessThan(position('actions'));
        expect(position('tasks')).toBeLessThan(position('polling'));
        expect(position('actions')).toBeLessThan(position('polling'));
        expect(assets.at(-1)).toBe('public/js/executor/dashboard/polling.js');
    });

    test('the CI gate checks pinned, scoped formatting', () => {
        const manifest = JSON.parse(read('package.json'));
        expect(manifest.devDependencies.prettier).toBe('3.9.9');
        expect(manifest.scripts['check:executor-format']).toContain('--check');
        expect(manifest.scripts['check:executor-format']).not.toContain('services/');
        expect(read('.github/workflows/ci-cd.yml')).toContain('npm run check:executor-format');
    });
});
