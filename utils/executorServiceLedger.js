'use strict';

const {
    getExecutorEnabledServiceKeys,
    getExecutorPrimaryServiceKey,
    getExecutorServiceBalanceCopy,
    normalizeExecutorServiceKey,
    representativeTransferTypeForService
} = require('./executorServiceCatalog');

const readServiceBalanceMap = (group) => {
    const raw = group?.serviceBalances;
    if (!raw) return {};
    if (raw instanceof Map) return Object.fromEntries(raw.entries());
    if (typeof raw.get === 'function' && typeof raw.entries === 'function') {
        return Object.fromEntries(raw.entries());
    }
    if (typeof raw === 'object') {
        return Object.entries(raw).reduce((map, [key, value]) => {
            const serviceKey = normalizeExecutorServiceKey(key, null);
            if (serviceKey) map[serviceKey] = Number(value || 0);
            return map;
        }, {});
    }
    return {};
};

const servicePrivateBalance = (group, serviceKey) => {
    const key = normalizeExecutorServiceKey(serviceKey);
    const primary = getExecutorPrimaryServiceKey(group);
    const map = readServiceBalanceMap(group);
    if (Object.prototype.hasOwnProperty.call(map, key)) return Number(map[key] || 0);
    if (key === primary) return Number(group?.balance || 0);
    return 0;
};

const ledgerServiceKeyForTransaction = (tx, fallback = 'vodafone') => {
    if (!tx || tx.transferType === 'external_balance') return null;
    const fromCanonical = normalizeExecutorServiceKey(tx.canonicalServiceKey, null);
    if (fromCanonical) return fromCanonical;
    return normalizeExecutorServiceKey(tx.transferType, fallback);
};

const visibleServiceKeysForGroup = (group) => {
    const enabled = getExecutorEnabledServiceKeys(group);
    const map = readServiceBalanceMap(group);
    const extra = Object.keys(map).filter((key) => Number(map[key] || 0) !== 0 && !enabled.includes(key));
    return [...enabled, ...extra];
};

const serviceLedgerInc = (group, serviceKey, delta) => {
    const amount = Number(delta) || 0;
    const primary = getExecutorPrimaryServiceKey(group);
    const key = normalizeExecutorServiceKey(serviceKey, primary);
    const update = {};
    if (key) update[`serviceBalances.${key}`] = amount;
    if (!key || key === primary) update.balance = amount;
    return update;
};

const primaryServiceBalanceInc = (group, delta) => (
    serviceLedgerInc(group, getExecutorPrimaryServiceKey(group), delta)
);

const completedTransferLedgerInc = (group, tx, delta) => (
    serviceLedgerInc(group, ledgerServiceKeyForTransaction(tx, getExecutorPrimaryServiceKey(group)), delta)
);

const fundingFieldsForService = (serviceKey) => {
    const key = normalizeExecutorServiceKey(serviceKey);
    return {
        canonicalServiceKey: key,
        transferType: representativeTransferTypeForService(key)
    };
};

const snapshotServiceLedgers = ({ group, allocatedBalance = 0 }) => {
    const primary = getExecutorPrimaryServiceKey(group);
    const map = readServiceBalanceMap(group);
    const keys = visibleServiceKeysForGroup(group);
    const byService = keys.map((serviceKey) => {
        const copy = getExecutorServiceBalanceCopy(serviceKey);
        const isPrimary = serviceKey === primary;
        const privateBalance = Object.prototype.hasOwnProperty.call(map, serviceKey)
            ? Number(map[serviceKey] || 0)
            : (isPrimary ? Number(group?.balance || 0) : 0);
        const allocated = isPrimary ? Number(allocatedBalance || 0) : 0;
        const appliesPoolModel = isPrimary;
        return {
            serviceKey,
            label: copy.label,
            shortLabel: copy.shortLabel,
            privateLabel: copy.privateLabel,
            totalLabel: copy.totalLabel,
            singleLabel: copy.singleLabel,
            appliesPoolModel,
            privateBalance,
            allocatedBalance: allocated,
            totalBalance: privateBalance + allocated
        };
    });
    const primaryRow = byService.find((row) => row.serviceKey === primary) || {
        serviceKey: primary,
        privateBalance: Number(group?.balance || 0),
        allocatedBalance: Number(allocatedBalance || 0),
        totalBalance: Number(group?.balance || 0) + Number(allocatedBalance || 0),
        appliesPoolModel: true
    };
    return {
        primaryServiceKey: primary,
        multiService: byService.length > 1,
        byService,
        privateBalance: Number(primaryRow.privateBalance || 0),
        allocatedBalance: Number(primaryRow.allocatedBalance || 0),
        totalBalance: Number(primaryRow.totalBalance || 0)
    };
};

module.exports = {
    completedTransferLedgerInc,
    fundingFieldsForService,
    ledgerServiceKeyForTransaction,
    primaryServiceBalanceInc,
    readServiceBalanceMap,
    serviceLedgerInc,
    servicePrivateBalance,
    snapshotServiceLedgers,
    visibleServiceKeysForGroup
};
