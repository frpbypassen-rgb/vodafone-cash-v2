'use strict';

jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));

const {
    ADMIN_TX_NAME_SEARCH_FIELDS,
    adminAccountFindQuery,
    adminListIncludesAgencyDeposit,
    adminVisibleTransactionQuery,
    applyAdminTxPrivacy,
    agentOwnsSubAccount,
    buildAdminAccountHistoryQuery,
    isAdminHiddenPrincipalType,
    isAgencyClientScopedTx
} = require('../services/adminAccountVisibilityService');
const { adminAccountScope } = require('../utils/tenantScope');
const { agentOwnsSubAccount: ownershipCheck } = require('../utils/agencyOwnership');
const { mongoQueryMatches } = require('./mongoQueryMatch');

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
        expect(applyAdminTxPrivacy({ companyId: 'co-1' }).companyId).toBe('co-1');
        expect(applyAdminTxPrivacy({ companyId: 'co-1' }).isSubAccountTx).toBeUndefined();
        expect(applyAdminTxPrivacy({ companyId: 'co-1' }).$nor).toEqual(expect.arrayContaining([
            expect.objectContaining({
                status: { $in: ['deposit', 'deduction', 'deposit_pending'] },
                isSubAccountTx: true
            }),
            expect.objectContaining({
                status: { $in: ['deposit', 'deduction', 'deposit_pending'] },
                subAccountId: { $exists: true, $nin: [null] }
            })
        ]));
        applyAdminTxPrivacy({ companyId: 'co-1' }).$nor.forEach((clause) => {
            expect(clause.$or).toBeUndefined();
        });
        expect(adminVisibleTransactionQuery({ tenantId: 't-1' }, { _id: 'tx-agency' })).toEqual(expect.objectContaining({
            tenantId: 't-1',
            _id: 'tx-agency'
        }));
        expect(adminVisibleTransactionQuery({ tenantId: 't-1' }, { _id: 'tx-agency' }).isSubAccountTx).toBeUndefined();
        expect(mongoQueryMatches({
            status: 'pending',
            transferType: 'vodafone',
            isSubAccountTx: true,
            subAccountId: AGENCY_CLIENT._id
        }, applyAdminTxPrivacy({}))).toBe(true);
        expect(mongoQueryMatches({
            status: 'deposit',
            isSubAccountTx: true,
            subAccountId: AGENCY_CLIENT._id
        }, applyAdminTxPrivacy({}))).toBe(false);
        expect(isAdminHiddenPrincipalType('sub_client')).toBe(true);
        expect(isAdminHiddenPrincipalType('client_user')).toBe(false);
        expect(buildAdminAccountHistoryQuery({
            kind: 'company',
            account: { _id: 'company-1', name: 'شركة النور' }
        })).toEqual({
            isSubAccountTx: { $ne: true },
            companyId: 'company-1'
        });
        expect(adminAccountFindQuery({ tenantId: 't-historical' }, { _id: 'company-1' })).toEqual({
            _id: 'company-1',
            status: { $ne: 'deleted' }
        });
        expect(adminAccountScope({ tenantId: 't-historical' })).toEqual({});
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
