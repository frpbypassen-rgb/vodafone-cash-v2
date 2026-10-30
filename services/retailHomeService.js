'use strict';
const Transaction = require('../models/Transaction');
const { SERVICE_CATALOG, STATUS_META } = require('./portalWorkspace/catalog');

async function loadRetailHome({ account, isSubAccount, now = new Date() }) {
    const identifier = account.phone || account.webUsername;
    if (isSubAccount ? !account._id : !identifier) throw new Error('CUSTOMER_IDENTITY_REQUIRED');
    const ownership = isSubAccount
        ? { subAccountId: account._id }
        : { userId: identifier, companyId: null, subAccountId: null };
    if (account.tenantId) ownership.tenantId = account.tenantId;
    const scope = { ...ownership, transferType: { $in: SERVICE_CATALOG.map((service) => service.key) } };
    // Use the same server-calendar month as the existing portal's monthly reports.
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const [groups, recent] = await Promise.all([
        Transaction.aggregate([
            { $match: { ...scope, createdAt: { $gte: start, $lt: end } } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        Transaction.find(scope)
            .select('customId status transferType amount createdAt')
            .sort({ createdAt: -1 })
            .limit(3)
            .lean(),
    ]);
    const summary = { totalCount: 0, completedCount: 0, pendingCount: 0 };
    groups.forEach((group) => {
        summary.totalCount += group.count;
        if (group._id === 'completed') summary.completedCount += group.count;
        if (['pending', 'processing', 'accepted'].includes(group._id)) summary.pendingCount += group.count;
    });
    return {
        available: true,
        monthLabel: now.toLocaleDateString('ar-LY', { month: 'long', year: 'numeric' }),
        summary,
        recent: recent.map((tx) => {
            const service = SERVICE_CATALOG.find((item) => item.key === tx.transferType);
            return {
                reference: String(tx.customId || ''),
                status: tx.status,
                statusLabel: STATUS_META[tx.status]?.label || 'قيد المتابعة',
                tone: STATUS_META[tx.status]?.tone || 'neutral',
                serviceLabel: service?.label || 'تحويل',
                icon: service?.icon || 'fa-paper-plane',
                amount: Number(tx.amount || 0),
                currency: service?.amountCurrencyCode || 'EGP',
                createdAt:
                    tx.createdAt && Number.isFinite(new Date(tx.createdAt).getTime())
                        ? new Date(tx.createdAt)
                        : null,
            };
        }),
    };
}
module.exports = { loadRetailHome };
