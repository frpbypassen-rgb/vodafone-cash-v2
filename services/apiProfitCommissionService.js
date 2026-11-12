'use strict';

const ApiBalanceAudit = require('../models/ApiBalanceAudit');
const Transaction = require('../models/Transaction');
const ApiProviderReturn = require('../models/ApiProviderReturn');

const buildProfitPipeline = (group, limit = 100) => {
    const eligible = { 'tx.status': 'completed', 'tx.executorGroupId': group._id };
    if (group.tenantId) eligible['tx.tenantId'] = group.tenantId;
    return [
        { $match: { executorGroupId: group._id } },
        { $sort: { createdAt: -1, _id: -1 } },
        // A repeated audit is a new observation, never an additional profit.
        { $group: { _id: '$transactionId', audit: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$audit' } },
        { $lookup: { from: Transaction.collection.name, localField: 'transactionId', foreignField: '_id', as: 'tx' } },
        { $unwind: '$tx' },
        { $match: eligible },
        { $lookup: {
            from: ApiProviderReturn.collection.name,
            let: { transaction: '$transactionId', group: '$executorGroupId' },
            pipeline: [
                { $match: { $expr: { $and: [
                    { $eq: ['$transactionId', '$$transaction'] },
                    { $eq: ['$executorGroupId', '$$group'] }
                ] } } },
                { $limit: 1 }, { $project: { _id: 1 } }
            ],
            as: 'returns'
        } },
        { $match: { 'returns.0': { $exists: false } } },
        { $set: { nominalAmount: { $ifNull: ['$transactionAmount', '$expectedDebit'] } } },
        { $set: { hasCost: { $and: [
            { $eq: ['$executionStatus', 'success'] },
            { $eq: ['$beforeCheck.success', true] },
            { $eq: ['$afterCheck.success', true] },
            { $isNumber: '$nominalAmount' }, { $gt: ['$nominalAmount', 0] },
            { $isNumber: '$beforeCheck.availableBalance' },
            { $isNumber: '$afterCheck.availableBalance' },
            { $isNumber: '$observedDebit' }, { $gt: ['$observedDebit', 0] }
        ] } } },
        { $set: {
            calculatedProfit: { $cond: ['$hasCost', { $round: [{ $subtract: ['$nominalAmount', '$observedDebit'] }, 3] }, null] },
            profitConfirmed: { $and: ['$hasCost', { $or: [
                { $eq: ['$checkStatus', 'matched'] }, { $eq: ['$reviewStatus', 'reviewed'] }
            ] }] }
        } },
        { $facet: {
            summary: [{ $group: {
                _id: null,
                profit: { $sum: { $cond: ['$profitConfirmed', '$calculatedProfit', 0] } },
                cost: { $sum: { $cond: ['$profitConfirmed', '$observedDebit', 0] } },
                amount: { $sum: { $cond: ['$profitConfirmed', '$nominalAmount', 0] } },
                confirmedCount: { $sum: { $cond: ['$profitConfirmed', 1, 0] } },
                reviewCount: { $sum: { $cond: [{ $and: ['$hasCost', { $not: ['$profitConfirmed'] }] }, 1, 0] } },
                unavailableCount: { $sum: { $cond: ['$hasCost', 0, 1] } }
            } }],
            entries: [
                { $sort: { createdAt: -1, _id: -1 } }, { $limit: limit },
                { $project: {
                    _id: 1, transactionCustomId: 1, transactionId: 1,
                    createdAt: 1, nominalAmount: 1, profitCommissionPercent: 1,
                    observedDebit: 1, calculatedProfit: 1, profitConfirmed: 1,
                    hasCost: 1, referenceNumber: 1
                } }
            ]
        } }
    ];
};

const getApiProfitCommissionReport = async group => {
    const [result] = await ApiBalanceAudit.aggregate(buildProfitPipeline(group)).allowDiskUse(true);
    return {
        summary: { profit: 0, cost: 0, amount: 0, confirmedCount: 0, reviewCount: 0, unavailableCount: 0, ...(result?.summary?.[0] || {}) },
        entries: result?.entries || []
    };
};
module.exports = { buildProfitPipeline, getApiProfitCommissionReport };
