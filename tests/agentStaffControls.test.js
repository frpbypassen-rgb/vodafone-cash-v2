'use strict';
jest.mock('../services/agentPortalContextService', () => ({ getAgentActor: jest.fn() }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../models/AgentEmployee', () => ({ findOne: jest.fn(), create: jest.fn(), exists: jest.fn() }));
const AgentEmployee = require('../models/AgentEmployee');
const { getAgentActor } = require('../services/agentPortalContextService');
const staff = require('../controllers/agent/staffController');
let req, res, owner, target;
beforeEach(() => {
    jest.clearAllMocks();
    owner = { _id: 'agent-a', status: 'active', role: 'agent', name: 'Owner' };
    target = {
        _id: 'staff-a',
        agentId: 'agent-a',
        status: 'active',
        sessionVersion: 2,
        save: jest.fn().mockResolvedValue(undefined),
    };
    getAgentActor.mockResolvedValue({ actor: owner, agent: owner, actorModel: 'User' });
    AgentEmployee.findOne.mockResolvedValue(target);
    req = { params: { id: 'staff-a' }, body: { newPassword: ' secure-password ' } };
    res = { redirect: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
});
test('reset preserves the password exactly and invalidates prior sessions and refresh credentials', async () => {
    target.refreshToken = 'old-refresh-token';
    await staff.postResetStaffPassword(req, res);
    expect(target.webPassword).toBe(' secure-password ');
    expect(target.sessionVersion).toBe(3);
    expect(target.refreshToken).toBeUndefined();
    expect(target.save).toHaveBeenCalledTimes(1);
    expect(res.redirect).toHaveBeenCalledWith('/client/staff?staffSuccess=password');
});
test.each(['short', 'x'.repeat(129)])(
    'rejects invalid password length before looking up a target',
    async (newPassword) => {
        req.body.newPassword = newPassword;
        await staff.postResetStaffPassword(req, res);
        expect(AgentEmployee.findOne).not.toHaveBeenCalled();
        expect(target.save).not.toHaveBeenCalled();
    }
);
test('staff changes are scoped to the current agency and exclude deleted records', async () => {
    AgentEmployee.findOne.mockResolvedValue(null);
    req.params.id = 'foreign-or-deleted-staff';
    await staff.postResetStaffPassword(req, res);
    expect(AgentEmployee.findOne).toHaveBeenCalledWith({
        _id: req.params.id,
        agentId: 'agent-a',
        status: { $ne: 'deleted' },
    });
    expect(target.save).not.toHaveBeenCalled();
});
test('a delegated manager cannot reset staff passwords without staff-management permission', async () => {
    getAgentActor.mockResolvedValue({ actor: { role: 'employee', canManageAgent: true }, agent: owner });
    await staff.postResetStaffPassword(req, res);
    expect(AgentEmployee.findOne).not.toHaveBeenCalled();
    expect(target.save).not.toHaveBeenCalled();
});
test('changing staff status invalidates every previously issued session', async () => {
    await staff.postToggleStaff(req, res);
    expect(target.status).toBe('banned');
    expect(target.sessionVersion).toBe(3);
    expect(target.save).toHaveBeenCalledTimes(1);
});
test('a staff administrator cannot change their own status through the team endpoint', async () => {
    target._id = owner._id;
    await staff.postToggleStaff(req, res);
    expect(target.save).not.toHaveBeenCalled();
});
