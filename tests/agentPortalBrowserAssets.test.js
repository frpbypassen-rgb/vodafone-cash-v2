'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { renderWorkspacePage, managerWorkspace } = require('./helpers/agentPortalFixtures');
const { resolveAgentPermissions } = require('../utils/agentPortalPolicy');
const { renderAgentPage } = require('./helpers/agentPortalFixtures');
const asset = (name) => fs.readFileSync(path.join(__dirname, '../public/js/business-portal', name), 'utf8');
let window;
beforeEach(() => {
    window = { location: { assign: jest.fn() } };
    vm.runInNewContext(asset('api-response.js'), { window });
});
test.each(['', 'null', '[]', 'true', '"success"', '<html>Login</html>'])(
    'rejects invalid API success payloads: %p',
    async (text) => {
        const payload = await window.businessPortalApi.readResponse({
            status: 200,
            ok: true,
            text: async () => text,
        });
        expect(payload.success).toBe(false);
        expect(payload.error).toBeTruthy();
    }
);
test('preserves a valid API response', async () => {
    await expect(
        window.businessPortalApi.readResponse({
            status: 200,
            ok: true,
            text: async () => '{"success":true,"customId":"TEST"}',
        })
    ).resolves.toMatchObject({ success: true, customId: 'TEST' });
});
test('MFA errors navigate only to the fixed local enrollment route', async () => {
    const payload = await window.businessPortalApi.readResponse({
        status: 403,
        ok: false,
        text: async () => '{"code":"MFA_ENROLLMENT_REQUIRED","redirect":"https://invalid.example"}',
    });
    expect(window.location.assign).toHaveBeenCalledWith('/security/mfa-enroll');
    expect(payload.success).toBe(false);
});
test('expiry is reported explicitly even if the server body is unavailable', async () => {
    const text = jest.fn();
    const payload = await window.businessPortalApi.readResponse({ status: 401, ok: false, text });
    expect(payload.success).toBe(false);
    expect(text).not.toHaveBeenCalled();
});
test('rate notices retain the initial text, clear cancelled schedules and clean up timers', () => {
    const value = { textContent: '' };
    const banner = { hidden: false, querySelector: () => value };
    const details = { textContent: '' };
    const handlers = {};
    const scheduled = new Date(Date.now() + 60000).toISOString();
    const intervals = new Set();
    window = {
        businessPortal: {
            pendingRateUpdate: { effectiveAt: scheduled, rateChangesText: '<b>literal rates</b>' },
        },
        setInterval: jest.fn(() => {
            intervals.add(1);
            return 1;
        }),
        clearInterval: jest.fn((id) => intervals.delete(id)),
        io: () => ({
            on: (name, callback) => {
                handlers[name] = callback;
            },
        }),
    };
    const document = {
        getElementById: (id) => ({ rateChangeCountdown: banner, rateChangeDetails: details })[id] || null,
    };
    vm.runInNewContext(asset('rate-notice.js'), { window, document, Date });
    expect(details.textContent).toBe('<b>literal rates</b>');
    expect(banner.hidden).toBe(false);
    handlers.rate_change_scheduled({ effectiveAt: null });
    expect(banner.hidden).toBe(true);
    expect(intervals.size).toBe(0);
});
test('agent bootstrap escapes script-breaking names and loads response handling before workspace behavior', async () => {
    const name = '</script><script>window.agentInjected=1</script>';
    const workspace = {
        ...managerWorkspace,
        type: 'agent',
        isCompany: false,
        isAgent: true,
        actor: { _id: 'staff', name: 'Actor', role: 'employee' },
        entity: { ...managerWorkspace.entity, _id: 'agency', name },
        permissions: resolveAgentPermissions({ role: 'employee' }),
    };
    const html = await renderWorkspacePage('settings', { workspace });
    expect(html).not.toContain(name);
    const source = html.match(/window.agentPortal = ([\s\S]*?);\s*window.rateAlertInitial/)[1];
    const parsed = vm.runInNewContext('(' + source + ')');
    expect(parsed.entityName).toBe(name);
    expect(html).toContain('/js/agent-portal/index.js');
    expect(html).not.toContain('/js/client-workspace.js');
    expect(html).not.toContain('/js/company-portal.js');
});

test.each([
    ['owner', 'owner'],
    ['manager', 'manager'],
    ['accountant', 'accountant'],
    ['employee', 'employee'],
])('uses consistent role markers for %s', async (role, marker) => {
    const html = await renderAgentPage('settings', role);
    const htmlRole = html.match(/<html[^>]+data-agent-role="([^"]+)"/)[1];
    const bodyRole = html.match(/<body[^>]+data-agent-role="([^"]+)"/)[1];
    expect(htmlRole).toBe(marker);
    expect(bodyRole).toBe(marker);
});
