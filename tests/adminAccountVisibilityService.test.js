'use strict';

const {
    ADMIN_TX_NAME_SEARCH_FIELDS,
    adminListIncludesAgencyDeposit,
    applyAdminTxPrivacy,
    agentOwnsSubAccount,
    buildAdminAccountHistoryQuery,
    isAgencyClientScopedTx
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

describe('Admin privacy for agency-scoped clients', () => {
    test('admin history for an agent excludes agency-client deposits', () => {
        const query = buildAdminAccountHistoryQuery({
            kind: 'agent',
            account: AGENT_A,
            subAccountIds: [AGENCY_CLIENT._id]
        });

        expect(query.isSubAccountTx).toEqual({ $ne: true });
        expect(query.userId).toEqual({ $in: ['0911111111', 'agent.a'] });
        expect(query.companyId).toBeNull();
        expect(JSON.stringify(query)).not.toContain(String(AGENCY_CLIENT._id));
        expect(query.$or).toBeUndefined();

        const deposit = {
            status: 'deposit',
            subAccountId: AGENCY_CLIENT._id,
            isSubAccountTx: true,
            subAccountName: 'عميل الوكالة',
            userId: AGENT_A.phone,
            companyName: 'تسوية وكيل'
        };
        expect(isAgencyClientScopedTx(deposit)).toBe(true);
        expect(adminListIncludesAgencyDeposit(deposit)).toBe(false);
        expect(adminListIncludesAgencyDeposit({
            status: 'deposit',
            userId: AGENT_A.phone,
            isSubAccountTx: false
        })).toBe(false);
    });

    test('admin has no sub-account ledger query and search fields omit agency client names', () => {
        const clientQuery = buildAdminAccountHistoryQuery({
            kind: 'subaccount',
            account: AGENCY_CLIENT
        });
        expect(clientQuery).toEqual({ isSubAccountTx: { $ne: true }, _id: null });
        expect(ADMIN_TX_NAME_SEARCH_FIELDS).not.toContain('subAccountName');
        expect(applyAdminTxPrivacy({ companyId: 'co-1' })).toEqual({
            companyId: 'co-1',
            isSubAccountTx: { $ne: true }
        });
    });

    test('cross-agency agent still cannot operate on another agency client', () => {
        expect(agentOwnsSubAccount(AGENT_A, AGENCY_CLIENT)).toBe(true);
        expect(ownershipCheck(AGENT_B, AGENCY_CLIENT)).toBe(false);
        expect(agentOwnsSubAccount(AGENT_B, { ...AGENCY_CLIENT, masterId: AGENT_B._id })).toBe(true);
        expect(agentOwnsSubAccount(AGENT_A, { ...AGENCY_CLIENT, status: 'deleted' })).toBe(false);

        const otherAgentHistory = buildAdminAccountHistoryQuery({
            kind: 'agent',
            account: AGENT_B
        });
        expect(otherAgentHistory.subAccountId).toBeUndefined();
        expect(otherAgentHistory.isSubAccountTx).toEqual({ $ne: true });
        expect(JSON.stringify(otherAgentHistory)).not.toContain(String(AGENCY_CLIENT._id));
        expect(adminListIncludesAgencyDeposit(
            { status: 'deposit', subAccountId: AGENCY_CLIENT._id, isSubAccountTx: true },
            { subAccountIds: [AGENCY_CLIENT._id] }
        )).toBe(false);
    });
});
