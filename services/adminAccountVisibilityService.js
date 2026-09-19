'use strict';

const { agentOwnsSubAccount, isVisibleAgencyClient } = require('../utils/agencyOwnership');

const ADMIN_TX_NAME_SEARCH_FIELDS = Object.freeze([
    'companyName',
    'employeeName',
    'accountName',
    'subAccountName'
]);

const accountIdentifiers = (account = {}) => (
    [account.phone, account.webUsername].map((value) => String(value || '').trim()).filter(Boolean)
);

const ownerKindForMaster = (masterType, master = {}) => {
    if (masterType === 'company') return 'company';
    if (master?.role === 'agent') return 'agent';
    return 'user';
};

const agencyOwnerLabel = ({ masterType, master = {}, fallbackName = 'غير معروف' } = {}) => {
    const name = master.name || fallbackName;
    const kind = ownerKindForMaster(masterType, master);
    if (kind === 'company') return `شركة: ${name}`;
    const code = master.agentCode || master.accountCode;
    return code ? `وكيل: ${name} · ${code}` : `وكيل: ${name}`;
};

const decorateAgencyClient = (subAccount, master = {}) => {
    const kind = ownerKindForMaster(subAccount.masterType, master);
    return {
        ...subAccount,
        balance: Number(subAccount.balance || 0),
        creditLimit: Number(subAccount.creditLimit || 0),
        masterName: master.name || subAccount.masterName || 'غير معروف',
        masterRole: master.role || (subAccount.masterType === 'company' ? 'company' : ''),
        masterAgentCode: master.agentCode || master.accountCode || '',
        ownerKind: kind,
        agencyLabel: agencyOwnerLabel({
            masterType: subAccount.masterType,
            master: { ...master, name: master.name || subAccount.masterName },
            fallbackName: subAccount.masterName
        })
    };
};

const buildAdminAccountHistoryQuery = ({ kind, account, subAccountIds = [], tenant = {} } = {}) => {
    const scoped = { ...tenant };
    if (kind === 'subaccount' && account?._id) {
        return { ...scoped, subAccountId: account._id };
    }

    const ownedIds = (subAccountIds || []).filter(Boolean);
    if (kind === 'company' && account?._id) {
        if (!ownedIds.length) return { ...scoped, companyId: account._id };
        return {
            ...scoped,
            $or: [
                { companyId: account._id },
                { subAccountId: { $in: ownedIds } }
            ]
        };
    }

    const identifiers = accountIdentifiers(account);
    const userMatch = identifiers.length
        ? { userId: identifiers.length === 1 ? identifiers[0] : { $in: identifiers }, companyId: null }
        : null;

    if (kind === 'agent' && ownedIds.length) {
        const clauses = [{ subAccountId: { $in: ownedIds } }];
        if (userMatch) clauses.push(userMatch);
        return { ...scoped, $or: clauses };
    }

    return userMatch ? { ...scoped, ...userMatch } : { ...scoped, _id: null };
};

const adminListIncludesAgencyDeposit = (transaction, { subAccountIds = [] } = {}) => {
    if (!transaction || !['deposit', 'deduction', 'deposit_pending'].includes(transaction.status)) {
        return false;
    }
    const owned = new Set((subAccountIds || []).map((id) => String(id)));
    if (transaction.subAccountId && owned.has(String(transaction.subAccountId))) return true;
    return false;
};

const loadOwnedSubAccountIds = async (SubAccount, { kind, accountId } = {}) => {
    if (!SubAccount || !accountId || !['agent', 'company'].includes(kind)) return [];
    const filter = {
        masterType: kind === 'company' ? 'company' : 'user',
        masterId: accountId,
        status: { $ne: 'deleted' }
    };
    const rows = await SubAccount.find(filter).select('_id').lean();
    return rows.map((row) => row._id);
};

const loadAdminAccountHistory = async ({ Transaction, SubAccount }, {
    kind,
    account,
    tenant = {},
    limit = 50
} = {}) => {
    const subAccountIds = kind === 'subaccount'
        ? [account?._id].filter(Boolean)
        : await loadOwnedSubAccountIds(SubAccount, { kind, accountId: account?._id });
    const query = buildAdminAccountHistoryQuery({ kind, account, subAccountIds, tenant });
    const transactions = await Transaction.find(query).sort({ createdAt: -1 }).limit(limit);
    return { query, subAccountIds, transactions };
};

module.exports = {
    ADMIN_TX_NAME_SEARCH_FIELDS,
    accountIdentifiers,
    adminListIncludesAgencyDeposit,
    agencyOwnerLabel,
    agentOwnsSubAccount,
    buildAdminAccountHistoryQuery,
    decorateAgencyClient,
    isVisibleAgencyClient,
    loadAdminAccountHistory,
    loadOwnedSubAccountIds,
    ownerKindForMaster
};
