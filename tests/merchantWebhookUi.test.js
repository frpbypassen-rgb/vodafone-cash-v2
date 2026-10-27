'use strict';
const {
    escapeHtml,
    filterDeliveries,
    deliveryLabel,
    canRetry,
    validateInput,
} = require('../public/js/merchant-webhooks');
const ejs = require('ejs');
const path = require('node:path');

test('untrusted endpoint names and receiver errors remain text', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
        '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
    expect(deliveryLabel('unknown<script>')).toEqual({
        text: 'غير معروف',
        tone: 'muted',
    });
});
test('history filters preserve queued/in-flight rows in All and never offer retry for a sending or delivered row', () => {
    const rows = ['pending', 'sending', 'failed', 'delivered'].map(
        (status) => ({ status }),
    );
    expect(filterDeliveries(rows, 'all')).toHaveLength(4);
    expect(filterDeliveries(rows, 'failed')).toEqual([{ status: 'failed' }]);
    expect(filterDeliveries(rows, 'delivered')).toEqual([
        { status: 'delivered' },
    ]);
    for (const row of rows) expect(canRetry(row)).toBe(row.status === 'failed');
});
test('editor requires HTTPS, a name and at least one supported event before making a request', () => {
    const valid = {
        name: ' نظام المحاسبة ',
        url: 'https://example.com/hook',
        events: ['transfer.created', 'transfer.created'],
    };
    expect(validateInput(valid)).toEqual({
        name: 'نظام المحاسبة',
        url: 'https://example.com/hook',
        events: ['transfer.created'],
    });
    expect(() =>
        validateInput({ ...valid, url: 'http://example.com/hook' }),
    ).toThrow('WEBHOOK_HTTPS_REQUIRED');
    expect(() => validateInput({ ...valid, name: ' ' })).toThrow(
        'WEBHOOK_NAME_REQUIRED',
    );
    expect(() => validateInput({ ...valid, events: [] })).toThrow(
        'WEBHOOK_EVENTS_REQUIRED',
    );
});
test('the page keeps portal links and safely serializes its configuration without an inline application bundle', async () => {
    const html = await ejs.renderFile(
        path.join(__dirname, '../views/client/webhooks.ejs'),
        {
            portalBase: '/client',
            events: ['transfer.created'],
            csrfToken: '</script><script>bad()</script>',
            webhookTheme: 'night',
        },
    );
    expect(html).toContain('/css/merchant-webhooks.css');
    expect(html).toContain('/js/merchant-webhooks.js');
    expect(html).not.toContain('</script><script>bad()');
    expect(html).toContain('data-theme="night"');
    expect(html).not.toContain('bootstrap');
    const config = JSON.parse(
        html.match(
            /<script id="webhook-config" type="application\/json">([\s\S]*?)<\/script>/,
        )[1],
    );
    expect(config.csrf).toBe('</script><script>bad()</script>');
});

test('the same compact page preserves agent portal navigation and theme', async () => {
    const html = await ejs.renderFile(
        path.join(__dirname, '../views/client/webhooks.ejs'),
        {
            portalBase: '/agent-portal',
            events: [],
            csrfToken: 'test-only',
            webhookTheme: 'pharaonic',
        },
    );
    expect(html).toContain('/agent-portal/settings#integrations');
    expect(html).toContain('ahram_client_theme');
    expect(html).toContain('data-theme="pharaonic"');
});
