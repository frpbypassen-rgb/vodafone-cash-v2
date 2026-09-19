'use strict';

const {
    adminListIncludesAgencyDeposit,
    agencyOwnerLabel,
    agentOwnsSubAccount,
    buildAdminAccountHistoryQuery,
    decorateAgencyClient
} = require('../services/adminAccountVisibilityService');
const { agentOwnsSubAccount: ownershipCheck } = require('../utils/agencyOwnership');

const AGENT_A = { _id: 'agent-a', name: 'وكالة أ', role: 'agent', phone: '0911111111', webUsername: 'agent.a' };
const AGENT_B = { _id: 'agent-b', name: 'وكالة ب', role: 'agent', phone: '0922222222', webUsername: 'agent.b' };
const AGENCY_CLIENT = {
    _id: 'client-a',
    masterType: 'user',
    masterId: 'agent-a',
    name: 'عميل الوكالة',
    status: 'active',
    balance: 40
};

describe('Admin visibility for agency-scoped clients', () => {
    test('directory decoration labels the owning agency without changing ownership', () => {
        const decorated = decorateAgencyClient(AGENCY_CLIENT, { ...AGENT_A, agentCode: '1188' });
        expect(decorated.ownerKind).toBe('agent');
        expect(decorated.agencyLabel).toBe('وكيل: وكالة أ · 1188');
        expect(decorated.masterName).toBe('وكالة أ');
        expect(agencyOwnerLabel({ masterType: 'user', master: { name: 'وكالة أ', role: 'agent' } })).toBe('وكيل: وكالة أ');
    });

    test('admin history query includes an agent deposit to their own agency client', () => {
        const query = buildAdminAccountHistoryQuery({
            kind: 'agent',
            account: AGENT_A,
            subAccountIds: [AGENCY_CLIENT._id]
        });
        expect(query.$or).toEqual(expect.arrayContaining([
            { subAccountId: { $in: [AGENCY_CLIENT._id] } },
            { userId: { $in: ['0911111111', 'agent.a'] }, companyId: null }
        ]));

        const deposit = {
            status: 'deposit',
            subAccountId: AGENCY_CLIENT._id,
            isSubAccountTx: true,
            subAccountName: 'عميل الوكالة',
            userId: AGENT_A.phone,
            companyName: 'تسوية وكيل'
        };
        expect(adminListIncludesAgencyDeposit(deposit, { subAccountIds: [AGENCY_CLIENT._id] })).toBe(true);

        const clientQuery = buildAdminAccountHistoryQuery({
            kind: 'subaccount',
            account: AGENCY_CLIENT
        });
        expect(clientQuery).toEqual({ subAccountId: AGENCY_CLIENT._id });
        expect(clientQuery.isSubAccountTx).toBeUndefined();
    });

    test('cross-agency agent still cannot operate on another agency client', () => {
        expect(agentOwnsSubAccount(AGENT_A, AGENCY_CLIENT)).toBe(true);
        expect(ownershipCheck(AGENT_B, AGENCY_CLIENT)).toBe(false);
        expect(agentOwnsSubAccount(AGENT_B, { ...AGENCY_CLIENT, masterId: AGENT_B._id })).toBe(true);
        expect(agentOwnsSubAccount(AGENT_A, { ...AGENCY_CLIENT, status: 'deleted' })).toBe(false);

        const otherAgentHistory = buildAdminAccountHistoryQuery({
            kind: 'agent',
            account: AGENT_B,
            subAccountIds: []
        });
        expect(otherAgentHistory.subAccountId).toBeUndefined();
        expect(JSON.stringify(otherAgentHistory)).not.toContain(String(AGENCY_CLIENT._id));
        expect(adminListIncludesAgencyDeposit(
            { status: 'deposit', subAccountId: AGENCY_CLIENT._id },
            { subAccountIds: [] }
        )).toBe(false);
    });
});
