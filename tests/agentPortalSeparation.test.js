'use strict';

jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/AgentEmployee', () => ({ findById: jest.fn() }));
jest.mock('../services/agentPortalWorkspaceService', () => ({ loadPageContext: jest.fn() }));
const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ejs = require('ejs');
const User = require('../models/User');
const AgentEmployee = require('../models/AgentEmployee');
const workspaceService = require('../services/agentPortalWorkspaceService');
const router = require('../routes/agentPortal');
const legacy = require('../middlewares/legacyAgentPortal');
const csrf = require('../middlewares/csrfProtection');
const { protectedMutation } = require('../middlewares/securityControl');
const { buildAgentWorkspace, managerWorkspace, renderAgentPage } = require('./helpers/agentPortalFixtures');
const { canAccessAgentPage } = require('../utils/agentPortalPolicy');
const root = path.join(__dirname, '..');
const query = (value) => ({
    select: () => query(value),
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});
let session, actor, agent;
beforeEach(() => {
    jest.clearAllMocks();
    agent = { _id: 'agent-a', role: 'agent', status: 'active', sessionVersion: 1, name: 'Agency' };
    actor = { _id: 'staff-a', agentId: agent._id, role: 'employee', status: 'active', sessionVersion: 2 };
    session = {
        isClientLoggedIn: true,
        accountType: 'agent_staff',
        clientId: actor._id,
        clientSessionVersion: 2,
        csrfToken: 'local-token',
        destroy: jest.fn((cb) => cb?.()),
    };
    AgentEmployee.findById.mockImplementation(() => query(actor));
    User.findById.mockImplementation((id) => query(String(id) === agent._id ? agent : null));
    workspaceService.loadPageContext.mockResolvedValue({ workspace: buildAgentWorkspace('employee') });
});
const app = ({ legacyRoutes = false, csrfEnabled = false } = {}) => {
    const server = express();
    server.use(express.json());
    server.use((req, res, next) => {
        req.session = session;
        res.render = (view, context) => res.json({ view, portal: context.workspace.type });
        next();
    });
    if (csrfEnabled) server.use(csrf);
    server.use('/agent-portal', router);
    if (legacyRoutes) {
        server.use('/client', legacy);
        server.use('/client', (_req, res) => res.json({ portal: 'existing-client' }));
    }
    return server;
};
test('agency sessions use the dedicated controller and view', async () => {
    const response = await request(app()).get('/agent-portal/dashboard');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ view: 'agent/workspace', portal: 'agent' });
    expect(workspaceService.loadPageContext).toHaveBeenCalledWith(
        expect.objectContaining({ agentPortalIdentity: expect.objectContaining({ actor, agent }) }),
        'overview'
    );
});
test.each(['get', 'post'])('company sessions cannot enter agency routes through %s', async (method) => {
    session.accountType = 'company';
    const response = await request(app())[method](
        method === 'get' ? '/agent-portal/dashboard' : '/agent-portal/customers/add'
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AGENT_PORTAL_ONLY');
    expect(workspaceService.loadPageContext).not.toHaveBeenCalled();
    expect(User.findById).not.toHaveBeenCalled();
});
test('retail accounts cannot masquerade as agency owners', async () => {
    session.accountType = 'user';
    session.clientId = agent._id;
    session.clientSessionVersion = 1;
    agent.role = 'user';
    expect((await request(app()).get('/agent-portal/dashboard')).status).toBe(404);
    expect(workspaceService.loadPageContext).not.toHaveBeenCalled();
});
test('old agency page URLs redirect into the new namespace and preserve filters', async () => {
    const response = await request(app({ legacyRoutes: true })).get(
        '/client/transactions?search=TEST&page=2'
    );
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/agent-portal/transactions?search=TEST&page=2');
});
test('legacy company URLs stay on the existing company route', async () => {
    session.accountType = 'company';
    expect((await request(app({ legacyRoutes: true })).get('/client/services')).body.portal).toBe(
        'existing-client'
    );
    expect(User.findById).not.toHaveBeenCalled();
});
test('legacy retail URLs retain their existing handlers', async () => {
    session.accountType = 'user';
    session.clientId = agent._id;
    session.clientSessionVersion = 1;
    agent.role = 'user';
    expect((await request(app({ legacyRoutes: true })).get('/client/services')).body.portal).toBe(
        'existing-client'
    );
});
test('the agency namespace does not expose company administration endpoints', async () => {
    const response = await request(app()).get('/agent-portal/company/staff');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('AGENT_ROUTE_NOT_FOUND');
});
test('mandatory MFA cannot be bypassed by entering the new API namespace', async () => {
    session.mfaEnrollmentRequired = true;
    const response = await request(app()).get('/agent-portal/api/rates');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('MFA_ENROLLMENT_REQUIRED');
});
test('CSRF enforcement covers new agency mutations', async () => {
    const response = await request(app({ csrfEnabled: true }))
        .post('/agent-portal/settings/theme')
        .send({ theme: 'night' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Invalid CSRF token');
});
test.each([
    '/agent-portal/transfer',
    '/agent-portal/balance-transfer',
    '/agent-portal/customers/customer-a/balance',
    '/client/transfer',
])('emergency financial lockdown covers %s', (url) => {
    expect(protectedMutation({ method: 'POST', path: url })).toBe(true);
    expect(protectedMutation({ method: 'GET', path: url })).toBe(false);
});
test('agency policy rejects a company workspace before page loading', () => {
    expect(canAccessAgentPage(managerWorkspace, 'settings')).toBe(false);
});
test.each([
    ['agent', managerWorkspace, 'AGENT_VIEW_CONTEXT_REQUIRED'],
    ['company', buildAgentWorkspace('owner'), 'COMPANY_VIEW_CONTEXT_REQUIRED'],
])('the %s view refuses a context from another portal', async (portal, workspace, error) => {
    await expect(
        ejs.renderFile(path.join(root, 'views', portal, 'workspace.ejs'), { workspace })
    ).rejects.toThrow(error);
});
test.each(['owner', 'manager', 'accountant', 'employee'])(
    'the %s agency page does not load company entrypoints or company state',
    async (role) => {
        const html = await renderAgentPage('settings', role);
        expect(html).toContain('window.agentPortal =');
        expect(html).toContain('/js/agent-portal/index.js');
        expect(html).not.toContain('window.businessPortal =');
        expect(html).not.toContain('data-company-shell');
        expect(html).not.toMatch(/(?:src|href)="\/(?:js|css)\/company-/);
        expect(html).not.toContain('id="companyWelcomeDialog"');
        expect(html).not.toMatch(/(?:href|action)="\/client(?:\/|\?|")/);
    }
);
test.each(['client-workspace.js', 'company-portal.js', 'company-internal.js'])(
    'the legacy %s entrypoint remains inert on agency pages',
    (name) => {
        const document = { documentElement: { dataset: { portal: 'agent' } }, body: { dataset: {} } };
        const source = fs.readFileSync(path.join(root, 'public/js', name), 'utf8');
        expect(() => vm.runInNewContext(source, { document })).not.toThrow();
        expect(document.body.dataset.workspaceReady).toBeUndefined();
    }
);
test('the agency entrypoint remains inert on a company page', () => {
    const source = fs.readFileSync(path.join(root, 'public/js/agent-portal/index.js'), 'utf8');
    expect(() =>
        vm.runInNewContext(source, {
            window: {},
            document: { documentElement: { dataset: { portal: 'company' } } },
        })
    ).not.toThrow();
});
test('agency staff report links use the supported report scope', async () => {
    const html = await renderAgentPage('reports', 'owner');
    expect(html).toContain('/agent-portal/reports?scope=staff');
    expect(html).not.toContain('/agent-portal/reports/staff');
    workspaceService.loadPageContext.mockResolvedValue({ workspace: buildAgentWorkspace('owner') });
    const response = await request(app()).get('/agent-portal/reports?scope=staff');
    expect(response.status).toBe(200);
    expect(response.body.view).toBe('agent/workspace');
});

test.each(['owner', 'manager', 'accountant', 'employee'])(
    'agency %s settings do not link to unsupported webhook administration',
    async (role) => {
        const html = await renderAgentPage('settings', role);
        expect(html).not.toContain('/agent-portal/integrations/webhooks');
        expect(html).toContain('/agent-portal/security');
    }
);

test('browser and server behavior stays split into reviewable modules', () => {
    for (const folder of [
        'services/portalWorkspace',
        'controllers/portalWorkspace',
        'public/js/portal-workspace',
    ]) {
        const files = fs.readdirSync(path.join(root, folder)).filter((name) => name.endsWith('.js'));
        expect(files.length).toBeGreaterThan(5);
        for (const file of files)
            expect(fs.readFileSync(path.join(root, folder, file), 'utf8').split('\n').length).toBeLessThan(
                800
            );
    }
});
