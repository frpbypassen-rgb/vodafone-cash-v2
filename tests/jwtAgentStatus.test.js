'use strict';
jest.mock('../models/AgentEmployee', () => ({ findById: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/MobileDeviceSession', () => ({ exists: jest.fn() }));
const AgentEmployee = require('../models/AgentEmployee');
const User = require('../models/User');
const MobileDeviceSession = require('../models/MobileDeviceSession');
const { ensureActiveCustomerSession } = require('../middlewares/jwtAuth');
let account, agent, token;
beforeEach(() => {
    jest.clearAllMocks();
    account = { status: 'active', sessionVersion: 2, agentId: 'agent-a' };
    agent = { role: 'agent', status: 'active' };
    token = { accountType: 'agent_staff', userId: 'staff-a', sessionVersion: 2 };
    AgentEmployee.findById.mockImplementation(() => ({ select: jest.fn().mockResolvedValue(account) }));
    User.findById.mockImplementation(() => ({ select: jest.fn().mockResolvedValue(agent) }));
});
test('accepts a current staff token in an active agency', async () => {
    await expect(ensureActiveCustomerSession(token)).resolves.toBe(true);
});
test.each(['version', 'banned_staff', 'banned_agency', 'non_agent'])(
    'revokes an invalid staff token: %s',
    async (scenario) => {
        if (scenario === 'version') token.sessionVersion = 1;
        if (scenario === 'banned_staff') account.status = 'banned';
        if (scenario === 'banned_agency') agent.status = 'banned';
        if (scenario === 'non_agent') agent.role = 'user';
        await expect(ensureActiveCustomerSession(token)).resolves.toBe(false);
    }
);
test('checks the mobile device session when the token carries one', async () => {
    token.sessionId = 'device-a';
    MobileDeviceSession.exists.mockResolvedValue(null);
    await expect(ensureActiveCustomerSession(token)).resolves.toBe(false);
    expect(MobileDeviceSession.exists).toHaveBeenCalledWith(
        expect.objectContaining({ accountType: 'agent_staff', accountId: 'staff-a' })
    );
});
