'use strict';

const Transaction = require('../models/Transaction');

// Return only a warning, never another employee's transaction details.
const findCompanyDuplicate = async (workspace, parsed, now = new Date()) => {
    if (!workspace.isCompany || !workspace.permissions.canTransfer || !workspace.entity?._id
        || !parsed.ready || (parsed.serviceKey && parsed.serviceKey !== 'vodafone')) return null;
    const filter = {
        companyId: workspace.entity._id,
        transferType: 'vodafone',
        vodafoneNumber: parsed.phone,
        amount: parsed.amountEGP,
        createdAt: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000), $lte: now }
    };
    const [pending, completed] = await Promise.all([
        Transaction.exists({ ...filter, status: { $in: ['pending', 'processing', 'accepted'] } }),
        Transaction.exists({ ...filter, status: 'completed' })
    ]);
    return { detected: Boolean(pending || completed), pending: Boolean(pending), completed: Boolean(completed), windowHours: 24 };
};

module.exports = { findCompanyDuplicate };
