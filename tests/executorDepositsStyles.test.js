const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const viewPath = path.join(__dirname, '../views/executor/deposits.ejs');
const cssPath = path.join(__dirname, '../public/css/executor-deposits.css');

describe('executor deposits styles', () => {
    test('serves page styles through a versioned external stylesheet', () => {
        const view = fs.readFileSync(viewPath, 'utf8');
        const css = fs.readFileSync(cssPath, 'utf8');

        expect(() => ejs.compile(view, { filename: viewPath })).not.toThrow();
        expect(view).toContain('/css/executor-deposits.css?v=20261002-compact-balances');
        expect(view).not.toContain('<style>');
        expect(css).toContain('@media (max-width: 850px)');
        expect(css).toContain('.deposit-balance-stack { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));');
        expect(css).toContain('.deposit-hero h1 { font-size: 1.18rem;');
        expect(css).toContain('.deposit-balance-stack .executor-summary-card:has(.summary-help)');
        expect(css).toContain('.deposit-balance-stack .executor-summary-card .summary-help { display: none; }');
    });
});
