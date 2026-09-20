'use strict';

const { agentOwnsSubAccount, isVisibleAgencyClient } = require('../utils/agencyOwnership');
const { adminAccountScope } = require('../utils/tenantScope');

const ADMIN_TX_NAME_SEARCH_FIELDS = Object.freeze([
    'companyName',
    'employeeName',
    'accountName'
]);

const excludeAgencyClientTxFilter = Object.freeze({
    isSubAccountTx: { $ne: true }
});

const VISIBLE_ADMIN_ACCOUNT_STATUS = Object.freeze({
    status: { $ne: 'deleted' }
});

// Directory widgets use adminAccountScope so single-tenant production can
// still open companies and agency masters whose tenantId predates the
// current DEFAULT_TENANT_SLUG. Detail/edit lookups must use the same helper
// or those rows appear in /clients and then redirect as not found.
const adminAccountFindQuery = (source, extra = {}) => ({
    ...adminAccountScope(source),
    ...VISIBLE_ADMIN_ACCOUNT_STATUS,
    ...extra
});

const accountIdentifiers = (account = {}) => (
    [account.phone, account.webUsername].map((value) => String(value || '').trim()).filter(Boolean)
);

const applyAdminTxPrivacy = (query = {}) => ({
    ...query,
    ...excludeAgencyClientTxFilter
});

const adminVisibleTransactionQuery = (scope = {}, extra = {}) => (
    applyAdminTxPrivacy({ ...scope, ...extra })
);

const ADMIN_HIDDEN_PRINCIPAL_TYPES = Object.freeze(['sub_client']);

const isAdminHiddenPrincipalType = (principalType) => (
    ADMIN_HIDDEN_PRINCIPAL_TYPES.includes(String(principalType || '').trim())
);

const isAgencyClientScopedTx = (transaction) => (
    Boolean(transaction)
    && (transaction.isSubAccountTx === true || Boolean(transaction.subAccountId))
);

const buildAdminAccountHistoryQuery = ({ kind, account, tenant = {} } = {}) => {
    const scoped = applyAdminTxPrivacy(tenant);

    if (kind === 'subaccount') {
        return { ...scoped, _id: null };
    }

    if (kind === 'company' && account?._id) {
        return { ...scoped, companyId: account._id };
    }

    const identifiers = accountIdentifiers(account);
    const userMatch = identifiers.length
        ? { userId: identifiers.length === 1 ? identifiers[0] : { $in: identifiers }, companyId: null }
        : null;

    return userMatch ? { ...scoped, ...userMatch } : { ...scoped, _id: null };
};

const adminListIncludesAgencyDeposit = (transaction) => {
    if (!transaction || !['deposit', 'deduction', 'deposit_pending'].includes(transaction.status)) {
        return false;
    }
    return false;
};

const loadAdminAccountHistory = async ({ Transaction }, {
    kind,
    account,
    tenant = {},
    limit = 50
} = {}) => {
    const query = buildAdminAccountHistoryQuery({ kind, account, tenant });
    const transactions = await Transaction.find(query).sort({ createdAt: -1 }).limit(limit);
    return { query, transactions };
};

module.exports = {
    ADMIN_HIDDEN_PRINCIPAL_TYPES,
    ADMIN_TX_NAME_SEARCH_FIELDS,
    VISIBLE_ADMIN_ACCOUNT_STATUS,
    accountIdentifiers,
    adminAccountFindQuery,
    adminListIncludesAgencyDeposit,
    adminVisibleTransactionQuery,
    agentOwnsSubAccount,
    applyAdminTxPrivacy,
    buildAdminAccountHistoryQuery,
    excludeAgencyClientTxFilter,
    isAdminHiddenPrincipalType,
    isAgencyClientScopedTx,
    isVisibleAgencyClient,
    loadAdminAccountHistory
};
