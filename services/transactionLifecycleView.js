'use strict';

const { getTransferPricingDefinition } = require('../utils/transferPricing');

const routingTitles = {
    admin_routed: 'وجّهت الإدارة العملية',
    admin_pulled: 'سحبت الإدارة العملية',
    auto_routed: 'وُجّهت العملية تلقائيًا',
    executor_assigned: 'أُسندت إلى موظف تنفيذ',
    executor_accepted: 'قبِل المنفذ العملية',
    rerouted: 'تغيّر منفذ العملية',
    arrived: 'ظهرت في قائمة المنفذ'
};
const auditKinds = {
    TRANSACTION_ROUTED: 'admin_routed',
    TRANSACTION_PULLED: 'admin_pulled',
    TRANSACTION_EXECUTOR_CHANGED: 'rerouted',
    TASK_ACCEPTED: 'executor_accepted',
    TRANSFER_COMPLETED: 'completed',
    TRANSACTION_CANCELLED_BY_ADMIN: 'cancelled',
    TRANSFER_CANCELLED: 'cancelled',
    API_PROVIDER_RETURN_CANCELLED: 'cancelled'
};
const accountLabels = {
    User: 'حساب العميل أو الوكيل',
    ClientCompany: 'حساب الشركة',
    ClientBot: 'حساب العميل',
    SubAccount: 'حساب العميل التابع',
    ExecutorGroup: 'حساب شركة التنفيذ',
    ExecutorBot: 'حساب المنفذ'
};
const terminalStates = new Set(['completed', 'rejected', 'cancelled_by_admin']);
const executorWallets = new Set(['ExecutorGroup', 'ExecutorBot']);
const movementKinds = new Set(['TRANSFER', 'REFUND', 'REVERSAL', 'DEPOSIT', 'DEDUCTION', 'COMMISSION']);
const text = value => typeof value === 'string' && value.trim() !== '---' ? value.trim().slice(0, 180) : '';
const iso = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;

function sourceFor(tx, account, creation) {
    const actor = text(creation?.performedByName) || text(tx.employeeName);
    const parentName = text(tx.companyName);
    const model = tx.clientActorModel || creation?.performedByModel;
    if (tx.isSubAccountTx || tx.subAccountId || model === 'SubAccount') {
        const owner = account?.masterType;
        return { kind: owner === 'user' ? 'agency_client' : owner === 'company' ? 'company_client' : 'sub_client',
            label: owner === 'user' ? 'عميل تابع لوكيل' : owner === 'company' ? 'عميل تابع لشركة' : 'عميل تابع', name: parentName, actor };
    }
    if (model === 'AgentEmployee' || account?.role === 'agent') {
        return { kind: 'agent', label: 'وكيل', name: parentName || text(account?.name) || actor, actor };
    }
    if (tx.companyId || ['ClientEmployee', 'ClientCompany'].includes(model)) {
        return { kind: 'company', label: 'شركة', name: parentName, actor };
    }
    return { kind: model === 'Admin' ? 'admin' : 'client', label: model === 'Admin' ? 'الإدارة' : 'عميل مباشر', name: actor || parentName, actor };
}

function movementsFor(ledgers, source, tx, executorNames) {
    const executorCurrency = getTransferPricingDefinition(tx.transferType).amountCurrencyCode;
    return ledgers.filter(row => movementKinds.has(row.type) && typeof row.amount === 'number' && Number.isFinite(row.amount))
        .map(row => {
            const executor = executorWallets.has(row.entityModel);
            const refund = row.type === 'REFUND' && row.amount > 0;
            const action = refund ? 'رد الرصيد' : row.amount < 0 ? 'خصم من الرصيد' : 'إضافة إلى الرصيد';
            const accountId = row.entityId == null ? '' : String(row.entityId);
            const agencyWallet = row.entityModel === 'User' && ['agent','agency_client'].includes(source.kind);
            const name = executor ? executorNames.get(accountId)
                : accountId && accountId === String(tx.companyId) ? source.name
                    : accountId && accountId === String(tx.subAccountId) ? source.actor : '';
            return {
                id: String(row._id), at: iso(row.createdAt),
                kind: refund ? 'refund' : row.amount < 0 ? 'debit' : 'credit',
                label: action, account: agencyWallet ? 'حساب الوكيل' : accountLabels[row.entityModel] || 'حساب مالي',
                accountName:text(name),
                role: executor ? 'executor' : 'sender', amount: row.amount,
                currency: executor ? executorCurrency : row.settledCurrency || row.currency || 'LYD',
                balanceBefore: Number.isFinite(row.balanceBefore) ? row.balanceBefore : null,
                balanceAfter: Number.isFinite(row.balanceAfter) ? row.balanceAfter : null
            };
        });
}

function buildLifecycle(tx, { audits = [], ledgers = [], account = null, executorNames = new Map(), canReadFinance = false, auditTruncated = false, financeTruncated = false } = {}) {
    const creation = audits.find(event => event.action === 'TRANSFER_CREATED' && event.success !== false);
    const source = sourceFor(tx, account, creation);
    const events = [{ kind:'created', label:'أُنشئت العملية وحُفظت', actor:source.actor || source.name, at:iso(tx.createdAt) }];
    const addRouting = event => events.push({
        kind:event.kind, label:routingTitles[event.kind], at:iso(event.at),
        actor:text(event.actor), executor:text(event.executor), previousRouter:text(event.previousRouter),
        previousExecutor:text(event.previousExecutor)
    });
    const routing = (tx.routingHistory || []).filter(row => routingTitles[row.kind] && iso(row.at));
    routing.forEach(addRouting);

    let completedAudit;
    let cancelledAudit;
    for (const audit of audits) {
        if (audit.success === false) continue;
        const kind = auditKinds[audit.action];
        if (kind === 'completed') { completedAudit = audit; continue; }
        if (kind === 'cancelled') { cancelledAudit = audit; continue; }
        if (!routingTitles[kind] || audit.metadata?.lifecycleRecorded === true) continue;
        const from = audit.oldData || {};
        const to = audit.newData || {};
        const executor = kind === 'admin_pulled' ? from.assignedExecutorName || from.executorName
            : kind === 'executor_accepted' ? audit.performedByName
                : to.executorName || audit.metadata?.executorName;
        if (kind === 'executor_accepted' && routing.some(row => row.kind === kind && text(row.actor) === text(audit.performedByName)
            && Math.abs(new Date(row.at) - new Date(audit.createdAt)) <= 3000)) continue;
        addRouting({ kind, at:audit.createdAt, actor:audit.performedByName, executor,
            previousRouter:kind === 'admin_pulled' ? from.routedByAdminName || audit.metadata?.routedByAdminName : '',
            previousExecutor:kind === 'rerouted' ? from.executorName : '' });
    }

    const lastPullAt = events.filter(event => event.kind === 'admin_pulled' && event.at).map(event => event.at).sort().at(-1);
    const isCurrentRouteEvent = event => !lastPullAt || (event.at && event.at > lastPullAt);
    const hasCurrentRoute = events.some(event => ['admin_routed','rerouted','auto_routed'].includes(event.kind) && isCurrentRouteEvent(event));
    if (tx.routedAt && tx.routedByAdminName && !hasCurrentRoute) {
        addRouting({ kind:'admin_routed', at:tx.routedAt, actor:tx.routedByAdminName, executor:tx.executorGroupName || tx.executorName });
    } else if (tx.executorGroupId && tx.status !== 'pending' && tx.executorReceivedAt && !hasCurrentRoute) {
        addRouting({ kind:'arrived', at:tx.executorReceivedAt, executor:tx.executorGroupName || tx.executorName });
    }
    if (tx.status !== 'pending' && tx.assignedExecutorAt && !events.some(event => event.kind === 'executor_assigned' && isCurrentRouteEvent(event))) {
        addRouting({ kind:'executor_assigned', at:tx.assignedExecutorAt, executor:tx.assignedExecutorName });
    }
    if (tx.status === 'accepted' && tx.operatorId && !events.some(event => event.kind === 'executor_accepted' && isCurrentRouteEvent(event))) {
        addRouting({ kind:'executor_accepted', actor:tx.executorName || tx.assignedExecutorName });
    }

    const movements = canReadFinance ? movementsFor(ledgers, source, tx, executorNames) : [];
    for (const movement of movements) {
        events.push({ kind:movement.kind, label:movement.label, at:movement.at, movementId:movement.id, account:movement.account });
    }
    if (tx.completedAt || completedAudit || tx.status === 'completed') {
        events.push({
            kind:'completed', label:'اكتملت العملية بنجاح', status:'completed',
            at:iso(tx.completedAt || completedAudit?.createdAt), actor:text(completedAudit?.performedByName) || text(tx.executorName)
        });
    }
    if (terminalStates.has(tx.status) && tx.status !== 'completed') {
        const cancelled = tx.status === 'cancelled_by_admin';
        events.push({
            kind:cancelled ? 'cancelled' : 'rejected', label:cancelled ? 'أُلغيت العملية' : 'رُفضت العملية',
            status:tx.status, at:iso(tx.cancelledAt || cancelledAudit?.createdAt),
            actor:text(cancelledAudit?.performedByName) || text(tx.cancelledBy)
        });
    }
    events.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
    let pulled = false;
    for (const event of events) {
        if (event.kind === 'admin_pulled') pulled = true;
        if (pulled && event.kind === 'admin_routed') {
            event.label = 'أعادت الإدارة توجيه العملية';
            pulled = false;
        }
    }
    const unknownTime = events.filter(event => !event.at);
    const dated = events.filter(event => event.at);

    return {
        source,
        record:{ id:String(tx._id), reference:tx.customId || '', status:tx.status, createdAt:iso(tx.createdAt),
            updatedAt:iso(tx.updatedAt), cancellationNumber:text(tx.cancellationNumber) },
        events:[...dated, ...unknownTime],
        finance:{ available:canReadFinance, movements, truncated:financeTruncated },
        historyTruncated:auditTruncated
    };
}

module.exports = { buildLifecycle };
