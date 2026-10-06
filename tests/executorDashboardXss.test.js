'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const attack = '<img src="/xss-image" onerror="window.__executorXssHits += 1">'
    + '<svg onload="window.__executorXssHits += 1"></svg><script>window.__executorXssHits += 1</script>';
const literal = 'Customer & "double" \'single\' &lt;b&gt;literal&lt;/b&gt; ' + attack;
const baseData = { tasks: [], alerts: [], depAlerts: [], completedToday: [] };
const scenarios = [
    {
        name: 'emergency',
        data: { ...baseData, alerts: [{ _id: 'alert-ui-test', status: 'processing', customId: literal, emergencyAlert: literal }] }
    },
    {
        name: 'completed',
        data: {
            ...baseData,
            completedToday: [
                { customId: literal, vodafoneNumber: literal, accountNumber: 'unused', amount: '2500' + literal, transferType: 'vodafone' },
                { customId: literal, accountNumber: literal, amount: literal, transferType: 'bank_account' }
            ],
            completedTodaySummary: { count: 73, amount: 123456 }
        }
    },
    {
        name: 'deposit',
        data: { ...baseData, depAlerts: [{ _id: 'deposit-ui-test', executorWebAlert: { type: 'warning', text: literal } }] }
    },
    { name: 'api-log', data: baseData, apiLog: 'header\n--- سجل الـ API (Terminal Log) ---\n' + literal },
    {
        name: 'normal',
        data: {
            ...baseData,
            completedToday: [
                { customId: 'C-100', vodafoneNumber: '01098765432', amount: 2500, transferType: 'vodafone', updatedAt: '2026-10-04T12:00:00Z' },
                { customId: 'B-100', accountNumber: '123456789', amount: 500, transferType: 'bank_account' }
            ]
        }
    },
    { name: 'empty', data: baseData }
];

describe('executor dashboard browser XSS regression', () => {
    let results;
    beforeAll(() => {
        // Keep Puppeteer's ESM loader outside Jest's CommonJS VM.
        const child = spawnSync(process.execPath, [path.join(__dirname, 'helpers/executorDashboardBrowser.cjs')], {
            cwd: path.join(__dirname, '..'), input: JSON.stringify(scenarios),
            encoding: 'utf8', timeout: 90000, windowsHide: true
        });
        expect(child.error).toBeUndefined();
        if (child.status !== 0) throw new Error(`Dashboard browser regression failed: ${child.stderr}`);
        results = new Map(JSON.parse(child.stdout).map((result) => [result.name, result]));
    }, 100000);

    test('emergency ID and customer message remain literal text with the existing code and breaks', () => {
        const { emergency } = results.get('emergency');
        expect(emergency.text).toBe('الطلب رقم: ' + literal + literal);
        expect(emergency.code).toBe(literal);
        expect(emergency.unsafeElements).toBe(0);
        expect(emergency.codeStyle).toBe('color:var(--accent-gold);');
        expect(emergency.breaks).toBe(2);
        expect(emergency.overlay).toBe('flex');
    });

    test('completed IDs, phone/account fallbacks and raw amount displays cannot create DOM elements', () => {
        const { completed } = results.get('completed');
        expect(completed.unsafeElements).toBe(0);
        expect(completed.rows).toEqual([
            { id: '#' + literal, recipient: literal, amount: '+2500' + literal, badge: 'كاش', icon: 'fa-solid fa-mobile-screen-button me-1' },
            { id: '#' + literal, recipient: literal, amount: '+' + literal, badge: 'بنك', icon: 'fa-solid fa-building-columns me-1' }
        ]);
        expect(completed.count).toBe('73');
        expect(completed.sum).toBe('123,456 ج.م');
    });

    test('deposit notification text is safe and acknowledgement keeps its API and CSRF contract', () => {
        const result = results.get('deposit');
        expect(result.dialogs).toHaveLength(1);
        expect(result.dialogs[0].text).toBe(literal);
        expect(result.dialogs[0].unsafeElements).toBe(0);
        expect(result.dialogOptions[0]).toMatchObject({ icon: 'warning', confirmButtonColor: '#10b981' });
        expect(result.dialogs[0].html).toContain('class="fw-bold text-warning"');
        expect(result.apiRequests.filter((request) => request.method === 'POST')).toEqual([
            { path: '/executor-portal/api/clear-dep-alert/deposit-ui-test', method: 'POST', csrf: 'ui-regression-token', body: null }
        ]);
    });

    test('decoded API logs remain text and preserve their preformatted dialog wrapper', () => {
        const { dialogs } = results.get('api-log');
        expect(dialogs).toHaveLength(1);
        expect(dialogs[0].text).toBe(literal);
        expect(dialogs[0].unsafeElements).toBe(0);
        expect(dialogs[0].html).toContain('white-space:pre-wrap');
    });

    test('normal completed rows and the existing fallback amount summary remain unchanged', () => {
        const { completed, emergency } = results.get('normal');
        expect(completed.rows).toEqual([
            { id: '#C-100', recipient: '01098765432', amount: '+2500', badge: 'كاش', icon: 'fa-solid fa-mobile-screen-button me-1' },
            { id: '#B-100', recipient: '123456789', amount: '+500', badge: 'بنك', icon: 'fa-solid fa-building-columns me-1' }
        ]);
        expect(completed.count).toBe('2');
        expect(completed.sum).toBe('3,000 ج.م');
        expect(emergency.overlay).toBe('none');
    });

    test('an empty day retains its fallback and zero counters', () => {
        const { completed } = results.get('empty');
        expect(completed.text).toContain('لا يوجد عمليات منفذة اليوم بعد');
        expect(completed.count).toBe('0');
        expect(completed.sum).toBe('0 ج.م');
    });

    test('Chrome allows the positive-control handler but executes no injected handler in any scenario', () => {
        for (const result of results.values()) {
            expect(result.controlHits).toBe(1);
            expect(result.xssHits).toBe(0);
            expect(result.errors).toEqual([]);
            expect(result.boardError).toBe(false);
            expect(result.apiRequests.filter((request) => request.method !== 'GET')).toHaveLength(result.name === 'deposit' ? 1 : 0);
        }
    });
});
