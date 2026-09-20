'use strict';

const { agentOwnsSubAccount, isVisibleAgencyClient } = require('../utils/agencyOwnership');
const { adminAccountScope } = require('../utils/tenantScope');

const ADMIN_TX_NAME_SEARCH_FIELDS = Object.freeze([
    'companyName',
    'employeeName',
    'accountName'
]);

const AGENCY_CLIENT_FUNDING_STATUSES = Object.freeze(['deposit', 'deduction', 'deposit_pending']);

const SUB_CLIENT_OPERATION_STATUSES = Object.freeze([
    'pending',
    'processing',
    'accepted',
    'completed',
    'rejected',
    'cancelled_by_admin'
]);

// Directory / account-history listings still hide every agency-client row
// (clients + deposits). Live ops and other operational queues must not use
// this filter — sub-client transfers have to reach central admin.
const excludeAgencyClientTxFilter = Object.freeze({
    isSubAccountTx: { $ne: true }
});

// Hide only agency-client funding rows from admin ops. Transfers stay visible
// so a sub_client cash op appears in the live queue the same way a direct
// retail client's op does.
//
// Each hide rule is a *separate* $nor clause with only field predicates.
// Nesting `$or` inside a $nor operand is unsafe: MongoDB/Mongoose can lift
// that `$or` into a sibling $nor expression, which then excludes every
// `isSubAccountTx: true` row (pending transfers included). $nor is still
// used at the top level so callers can set `$or` for search.
const agencyClientFundingHideClauses = Object.freeze([
    Object.freeze({
        status: { $in: AGENCY_CLIENT_FUNDING_STATUSES },
        isSubAccountTx: true
    }),
    Object.freeze({
        status: { $in: AGENCY_CLIENT_FUNDING_STATUSES },
        subAccountId: { $exists: true, $nin: [null] }
    })
]);

// Backward-compatible alias: first hide clause (funding + isSubAccountTx).
const agencyClientFundingNorClause = agencyClientFundingHideClauses[0];

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

const applyAdminDirectoryTxPrivacy = (query = {}) => ({
    ...query,
    ...excludeAgencyClientTxFilter
});

const applyAdminTxPrivacy = (query = {}) => {
    const next = { ...query };
    const existingNor = Array.isArray(next.$nor) ? next.$nor : [];
    next.$nor = existingNor.concat(agencyClientFundingHideClauses);
    return next;
};

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

const isAgencyClientFundingTx = (transaction) => (
    isAgencyClientScopedTx(transaction)
    && AGENCY_CLIENT_FUNDING_STATUSES.includes(String(transaction?.status || ''))
);

const isSubClientOperationTx = (transaction) => (
    Boolean(transaction?.isSubAccountTx)
    && Boolean(transaction.subAccountId)
    && SUB_CLIENT_OPERATION_STATUSES.includes(String(transaction.status || ''))
);

const isAdminOpsVisibleTransaction = (transaction) => (
    Boolean(transaction) && !isAgencyClientFundingTx(transaction)
);

const isAgencyLogVisibleTransaction = (transaction, customerIds = []) => {
    if (!transaction?.isSubAccountTx || !transaction.subAccountId) return false;
    if (!customerIds.length) return true;
    return customerIds.map(String).includes(String(transaction.subAccountId));
};

const buildAdminAccountHistoryQuery = ({ kind, account, tenant = {} } = {}) => {
    const scoped = applyAdminDirectoryTxPrivacy(tenant);

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
    if (!transaction || !AGENCY_CLIENT_FUNDING_STATUSES.includes(transaction.status)) {
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
    AGENCY_CLIENT_FUNDING_STATUSES,
    SUB_CLIENT_OPERATION_STATUSES,
    VISIBLE_ADMIN_ACCOUNT_STATUS,
    accountIdentifiers,
    adminAccountFindQuery,
    adminListIncludesAgencyDeposit,
    adminVisibleTransactionQuery,
    agencyClientFundingHideClauses,
    agencyClientFundingNorClause,
    agentOwnsSubAccount,
    applyAdminDirectoryTxPrivacy,
    applyAdminTxPrivacy,
    buildAdminAccountHistoryQuery,
    excludeAgencyClientTxFilter,
    isAdminHiddenPrincipalType,
    isAdminOpsVisibleTransaction,
    isAgencyClientFundingTx,
    isAgencyClientScopedTx,
    isAgencyLogVisibleTransaction,
    isSubClientOperationTx,
    isVisibleAgencyClient,
    loadAdminAccountHistory
};
