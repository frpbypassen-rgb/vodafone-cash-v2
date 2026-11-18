'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
const payload = '</ScRiPt><script>globalThis.compromised=true</script><img src=x onerror=alert(1)>';
const literal = 'عميل & "double" \'single\' ' + payload;
const fixtures = [
    ['views/client/dashboard.ejs', 'transactions', [{ customId: 'ATT-TEST', accountName: literal, amount: 100 }]],
    ['views/settings_clients_web.ejs', 'allClientEmployees', [{ name: literal }]],
    ['views/transactions.ejs', 'allBotsMap', { executor: { name: literal } }],
    ['views/transactions.ejs', 'executorBots', [{ name: literal }]],
    ['views/executor/dashboard.ejs', 'executorServices', [{ key: 'service', name: literal }]],
    ['views/security_enroll.ejs', 'returnUrl', '/account?name=' + literal],
    ['views/client/partials/customer_theme_boot.ejs', 'clientTheme', literal],
    ['views/client/dashboard.ejs', 'serviceRates', { service: { label: literal, rate: 5 } }],
];

describe('JSON embedded in HTML script contexts', () => {
    test.each(fixtures)('%s safely serializes %s without changing its data', (file, name, value) => {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        const expression = [...source.matchAll(/<%-\s*JSON\.stringify\([\s\S]*?%>/g)]
            .find(([snippet]) => new RegExp(`\\b${name}\\b`).test(snippet))?.[0];
        expect(expression).toBeDefined();
        // Render the actual EJS expression in isolation: HTML parsers close a
        // script at </script>, even inside a JSON string or application/json.
        const rendered = ejs.render(expression, { [name]: value });
        expect(rendered).not.toMatch(/<\/script\b/i);
        expect(rendered).not.toContain('<img');
        expect(JSON.parse(rendered)).toEqual(value);
    });

    test('all EJS templates compile after encoding changes', () => {
        const visit = (directory) => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const file = path.join(directory, entry.name);
                if (entry.isDirectory()) visit(file);
                else if (file.endsWith('.ejs')) {
                    expect(() => ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file })).not.toThrow();
                }
            }
        };
        visit(path.join(root, 'views'));
    });
});
