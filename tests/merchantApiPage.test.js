'use strict';
const ejs = require('ejs');
const path = require('node:path');
const { buildExample, statusLabel } = require('../public/js/merchant-api-page');
test('the quick start uses the real read-only route and a placeholder, without shell patch characters', () => {
    const sample = buildExample('https://example.com/api/v1/merchant');
    expect(sample).toContain('/balance');
    expect(sample).toContain('x-api-key: <API_KEY>');
    expect(sample).not.toContain('\n+');
    expect(statusLabel('completed')).toEqual(['مكتملة', 'success']);
    expect(statusLabel('<script>')).toEqual(['غير معروف', 'muted']);
});
test.each(['/client', '/agent-portal'])(
    'the %s API page keeps its links and safely serializes public status',
    async (portalBase) => {
        const html = await ejs.renderFile(
            path.join(__dirname, '../views/client/api.ejs'),
            {
                portalBase,
                csrfToken: '</script><script>bad()</script>',
                apiBase: 'https://example.com/api/v1/merchant',
                webhookTheme: 'night',
                status: { apiEnabled: true, keyHint: 'abcdef' },
            },
        );
        expect(html).toContain(portalBase + '/settings#integrations');
        expect(html).toContain('data-theme="night"');
        expect(html).not.toContain('</script><script>bad()');
        const config = JSON.parse(
            html.match(
                /<script id="api-page-config" type="application\/json">([\s\S]*?)<\/script>/,
            )[1],
        );
        expect(config.csrf).toBe('</script><script>bad()</script>');
        expect(config.status).not.toHaveProperty('token');
        expect(html).not.toContain('bootstrap');
    },
);
