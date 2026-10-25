'use strict';

jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/AgentEmployee', () => ({ findById: jest.fn() }));
jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: jest.fn(() => 'single') }));

const express = require('express');
const request = require('supertest');
const User = require('../models/User');
const AgentEmployee = require('../models/AgentEmployee');
const { tenantMode } = require('../middlewares/tenantResolver');
const { loadAgentPortalActor } = require('../services/agentPortalAccessService');
const { requireClientAuth } = require('../middlewares/clientPortalAuth');
const { resolveAgentPermissions, dashboardPersona } = require('../utils/agentPortalPolicy');
const { agentOwnsSubAccount } = require('../utils/agencyOwnership');

const query = (value) => ({
    select: () => query(value),
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});
let actor, agent, session;
beforeEach(() => {
    jest.clearAllMocks();
    tenantMode.mockReturnValue('single');
    actor = {
        _id: 'staff-a',
        agentId: 'agent-a',
        tenantId: 'tenant-a',
        role: 'employee',
        status: 'active',
        sessionVersion: 3,
    };
    agent = { _id: 'agent-a', tenantId: 'tenant-a', role: 'agent', status: 'active' };
    session = {
        isClientLoggedIn: true,
        accountType: 'agent_staff',
        clientId: actor._id,
        clientSessionVersion: 3,
        destroy: jest.fn((cb) => cb()),
    };
    AgentEmployee.findById.mockImplementation(() => query(actor));
    User.findById.mockImplementation(() => query(agent));
});

test('loads the authoritative staff and owning agency for a valid session', async () => {
    await expect(loadAgentPortalActor({ session }, { lean: true })).resolves.toMatchObject({
        actor,
        agent,
        actorModel: 'AgentEmployee',
    });
});
test.each(['version', 'banned', 'parent', 'mfa', 'wrong_preload', 'unknown_role'])(
    'rejects %s before agency actions',
    async (scenario) => {
        const options = {};
        if (scenario === 'version') session.clientSessionVersion = 2;
        if (scenario === 'banned') actor.status = 'banned';
        if (scenario === 'parent') agent.status = 'banned';
        if (scenario === 'mfa') session.mfaEnrollmentRequired = true;
        if (scenario === 'wrong_preload') options.preloadedAccount = { ...actor, _id: 'staff-b' };
        if (scenario === 'unknown_role') actor.role = 'unexpected';
        await expect(loadAgentPortalActor({ session }, options)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
);
test.each(['missing_request_tenant', 'foreign_staff', 'foreign_parent'])(
    'enforces tenant boundaries: %s',
    async (scenario) => {
        tenantMode.mockReturnValue('multi');
        const req = { session, tenant: { _id: 'tenant-a' } };
        if (scenario === 'missing_request_tenant') delete req.tenant;
        if (scenario === 'foreign_staff') actor.tenantId = 'tenant-b';
        if (scenario === 'foreign_parent') agent.tenantId = 'tenant-b';
        await expect(loadAgentPortalActor(req)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
);
test('retail users retain the shared router fallback', async () => {
    session = { accountType: 'user', clientId: 'agent-a' };
    agent.role = 'user';
    await expect(loadAgentPortalActor({ session })).rejects.toThrow('NOT_BUSINESS_PORTAL');
});
test('unknown roles receive no agency capabilities even with forged flags', () => {
    const result = resolveAgentPermissions({
        role: 'unexpected',
        canManageAgent: true,
        canCreateAgentStaff: true,
        canViewAllReports: true,
    });
    expect(Object.values(result).every((value) => value === false)).toBe(true);
});
test('accountants remain accountants when delegated customer management', () => {
    expect(dashboardPersona({ role: 'accountant', canManageAgent: true })).toBe('accountant');
    expect(resolveAgentPermissions({ role: 'accountant', canManageAgent: true })).toMatchObject({
        canTransfer: false,
        canInternalTransfer: false,
        canManageCustomers: true,
    });
});
test('empty ownership identifiers cannot match', () => {
    expect(agentOwnsSubAccount({}, { masterType: 'user', status: 'active' })).toBe(false);
    expect(agentOwnsSubAccount({ _id: 'a' }, { masterType: 'user', masterId: 'b' })).toBe(false);
});

const app = () => {
    const result = express();
    result.use((req, res, next) => {
        req.session = session;
        next();
    });
    result.get(['/api/probe', '/dashboard'], requireClientAuth, (_req, res) => res.json({ reached: true }));
    return result;
};
test('web middleware revokes a stale staff session without calling its handler', async () => {
    session.clientSessionVersion = 2;
    const response = await request(app()).get('/api/probe');
    expect(response.status).toBe(401);
    expect(session.destroy).toHaveBeenCalledTimes(1);
    expect(response.body.reached).toBeUndefined();
});
test('MFA on API routes returns an explicit error instead of an HTML success', async () => {
    session.mfaEnrollmentRequired = true;
    const response = await request(app()).get('/api/probe');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('MFA_ENROLLMENT_REQUIRED');
    expect(AgentEmployee.findById).not.toHaveBeenCalled();
});
test('a background client request preserves a different portal session', async () => {
    session = { isExecutorLoggedIn: true, executorId: 'executor-a', destroy: jest.fn() };
    const response = await request(app()).get('/api/probe');
    expect(response.status).toBe(401);
    expect(session.destroy).not.toHaveBeenCalled();
});
test('HTML MFA requests keep the enrollment redirect', async () => {
    session.mfaEnrollmentRequired = true;
    const response = await request(app()).get('/dashboard');
    expect(response.headers.location).toBe('/security/mfa-enroll');
});
