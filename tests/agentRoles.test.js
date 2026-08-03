'use strict';

const { agentRoleHelpers } = require('../controllers/clientAgentController');

describe('Agent client role helpers', () => {
    test('agent owner can manage staff, approve requests, view balance, and transfer', () => {
        const owner = { role: 'agent' };

        expect(agentRoleHelpers.dashboardPersona(owner)).toBe('manager');
        expect(agentRoleHelpers.canManageAgent(owner)).toBe(true);
        expect(agentRoleHelpers.canCreateAgentStaff(owner)).toBe(true);
        expect(agentRoleHelpers.canViewAgentBalance(owner)).toBe(true);
        expect(agentRoleHelpers.canTransfer(owner)).toBe(true);
    });

    test('delegated agent manager cannot create staff by default', () => {
        const manager = {
            role: 'employee',
            canManageAgent: true,
            canCreateAgentStaff: false,
            canViewAllReports: true
        };

        expect(agentRoleHelpers.dashboardPersona(manager)).toBe('manager');
        expect(agentRoleHelpers.canManageAgent(manager)).toBe(true);
        expect(agentRoleHelpers.canCreateAgentStaff(manager)).toBe(false);
        expect(agentRoleHelpers.canViewAgentBalance(manager)).toBe(true);
        expect(agentRoleHelpers.canTransfer(manager)).toBe(true);
    });

    test('accountant and employee resolve to separate dashboards', () => {
        expect(agentRoleHelpers.dashboardPersona({ role: 'accountant' })).toBe('accountant');
        expect(agentRoleHelpers.canViewAgentBalance({ role: 'accountant' })).toBe(true);
        expect(agentRoleHelpers.canTransfer({ role: 'accountant' })).toBe(false);

        const employee = { role: 'employee', canViewAllReports: false };
        expect(agentRoleHelpers.dashboardPersona(employee)).toBe('employee');
        expect(agentRoleHelpers.canViewAgentBalance(employee)).toBe(false);
        expect(agentRoleHelpers.canCreateAgentStaff(employee)).toBe(false);
        expect(agentRoleHelpers.canTransfer(employee)).toBe(true);
    });

    test('agent usernames are normalized to the official domain', () => {
        expect(agentRoleHelpers.normalizeUsername('Agent_User')).toBe('agent_user@ahram.com');
        expect(() => agentRoleHelpers.normalizeUsername('bad user')).toThrow('INVALID_USERNAME');
    });
});
