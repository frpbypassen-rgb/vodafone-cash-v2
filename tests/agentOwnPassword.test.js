'use strict';
jest.mock('../services/agentCredentialService', () => ({
    rotateAgentPassword: jest.fn(),
    setAgentStaffStatus: jest.fn(),
}));
const credentials = require('../services/agentCredentialService');
jest.mock('../services/businessPortalService', () => ({ resolveWorkspace: jest.fn() }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }));
const bcrypt = require('bcryptjs');
const AgentEmployee = require('../models/AgentEmployee');
const User = require('../models/User');
const businessPortal = require('../services/businessPortalService');
const { postChangePassword } = require('../controllers/clientWorkspaceController');
afterEach(() => jest.restoreAllMocks());
test.each([
    ['AgentEmployee', AgentEmployee],
    ['User', User],
])('password changes revoke older %s sessions while retaining the current one', async (actorModel, Model) => {
    const actor = {
        _id: 'actor-a',
        webPassword: 'existing-hash',
        sessionVersion: 4,
        save: jest.fn().mockResolvedValue(undefined),
    };
    businessPortal.resolveWorkspace.mockResolvedValue({ actor, actorModel, type: 'agent', isAgent: true });
    jest.spyOn(Model, 'findById').mockResolvedValue(actor);
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
    credentials.rotateAgentPassword.mockResolvedValue({ sessionVersion: 7 });
    const req = {
        body: {
            currentPassword: 'old-password',
            newPassword: ' new-password ',
            passwordConfirm: ' new-password ',
        },
        session: { clientSessionVersion: 4 },
    };
    const res = { redirect: jest.fn() };
    await postChangePassword(req, res);
    expect(credentials.rotateAgentPassword).toHaveBeenCalledWith(
        expect.objectContaining({
            accountModel: actorModel,
            accountId: actor._id,
            expectedPasswordHash: 'existing-hash',
            newPassword: ' new-password ',
            requireActive: true,
        })
    );
    expect(req.session.clientSessionVersion).toBe(7);
    expect(actor.save).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/client/settings?settingsSuccess=password');
});
