'use strict';
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const { scope } = require('./retailOperationDetailsService');
const { SERVICE_CATALOG, STATUS_META } = require('./portalWorkspace/catalog');
const { systemDateKey, systemDayStart, systemDayEnd } = require('../config/systemTime');
const statuses = ['pending', 'processing', 'accepted', 'completed', 'rejected', 'cancelled_by_admin'];
const invalid = () =>
    Object.assign(new Error('الفترة أو الفلاتر غير صالحة. اختر فترة لا تتجاوز سنة.'), { statusCode: 422 });
const normalizeFilters = (query = {}, now = new Date()) => {
    const today = systemDateKey(now),
        dateType = String(query.dateType || 'month');
    const filters = {
        dateType,
        dateValue: '',
        dateFrom: '',
        dateTo: '',
        search: String(query.search || '').trim(),
        status: String(query.status || ''),
        service: String(query.service || ''),
    };
    if (
        filters.search.length > 80 ||
        (filters.status && !statuses.includes(filters.status)) ||
        (filters.service && !SERVICE_CATALOG.some((s) => s.key === filters.service))
    )
        throw invalid();
    let start, end;
    if (dateType === 'month') {
        filters.dateValue = String(query.dateValue || today.slice(0, 7));
        if (!/^\d{4}-\d{2}$/.test(filters.dateValue)) throw invalid();
        start = systemDayStart(filters.dateValue + '-01');
        const [year, month] = filters.dateValue.split('-').map(Number),
            last = new Date(Date.UTC(year, month, 0)).getUTCDate();
        end = systemDayEnd(filters.dateValue + '-' + last);
    } else if (dateType === 'day') {
        filters.dateValue = String(query.dateValue || today);
        start = systemDayStart(filters.dateValue);
        end = systemDayEnd(filters.dateValue);
    } else if (dateType === 'range') {
        filters.dateFrom = String(query.dateFrom || '');
        filters.dateTo = String(query.dateTo || '');
        start = systemDayStart(filters.dateFrom);
        end = systemDayEnd(filters.dateTo);
    } else throw invalid();
    if (!start || !end || start > end || end - start > 366 * 86400000) throw invalid();
    return { filters, start, end };
};
const decodeCursor = (value) => {
    if (!value) return null;
    try {
        if (typeof value !== 'string' || value.length > 200 || !/^[\w-]+$/.test(value)) throw invalid();
        const data = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (!/^[a-f0-9]{24}$/i.test(data.id) || !data.at || new Date(data.at).toISOString() !== data.at)
            throw invalid();
        return { at: new Date(data.at), id: new mongoose.Types.ObjectId(data.id) };
    } catch (_) {
        throw invalid();
    }
};
const list = async (ctx, query = {}, now = new Date()) => {
    const { filters, start, end } = normalizeFilters(query, now),
        cursor = decodeCursor(query.cursor);
    const asOf = query.asOf ? new Date(String(query.asOf)) : now;
    if (!Number.isFinite(asOf.getTime()) || asOf > new Date(now.getTime() + 30000)) throw invalid();
    const match = [
        scope(ctx),
        {
            createdAt: { $gte: start, $lte: end < asOf ? end : asOf },
            transferType: { $in: filters.service ? [filters.service] : SERVICE_CATALOG.map((s) => s.key) },
        },
    ];
    if (filters.status) match.push({ status: filters.status });
    if (filters.search) {
        const literal = filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        match.push({
            $or: ['customId', 'vodafoneNumber', 'accountNumber', 'accountName'].map((field) => ({
                [field]: { $regex: literal, $options: 'i' },
            })),
        });
    }
    const cost =
        ctx.actorModel === 'SubAccount'
            ? {
                  $ifNull: [
                      '$agencyPricing.customerChargeLYD',
                      { $ifNull: ['$subAccountCostLYD', { $ifNull: ['$costLYD', 0] }] },
                  ],
              }
            : { $ifNull: ['$costLYD', 0] };
    const currency = {
        $switch: {
            branches: SERVICE_CATALOG.map((service) => ({
                case: { $eq: ['$transferType', service.key] },
                then: service.amountCurrencyCode || 'EGP',
            })),
            default: 'EGP',
        },
    };
    const rows = [];
    if (cursor)
        rows.push({
            $match: {
                $or: [{ createdAt: { $lt: cursor.at } }, { createdAt: cursor.at, _id: { $lt: cursor.id } }],
            },
        });
    rows.push(
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: 21 },
        {
            $project: {
                customId: 1,
                status: 1,
                transferType: 1,
                amount: 1,
                createdAt: 1,
                vodafoneNumber: 1,
                accountNumber: 1,
                accountName: 1,
                customerCost: 1,
                currency: 1,
            },
        }
    );
    const [result] = await Transaction.aggregate([
        { $match: { $and: match } },
        {
            $project: {
                customId: 1,
                status: 1,
                transferType: 1,
                amount: 1,
                createdAt: 1,
                vodafoneNumber: 1,
                accountNumber: 1,
                accountName: 1,
                customerCost: cost,
                currency,
            },
        },
        {
            $facet: {
                summary: [
                    {
                        $group: {
                            _id: '$currency',
                            count: { $sum: 1 },
                            amount: { $sum: '$amount' },
                            completedCost: {
                                $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$customerCost', 0] },
                            },
                        },
                    },
                ],
                rows,
            },
        },
    ]).option({ maxTimeMS: 7000 });
    const visible = (result?.rows || []).slice(0, 20),
        last = visible[visible.length - 1];
    return {
        filters,
        summary: {
            count: (result?.summary || []).reduce((n, x) => n + x.count, 0),
            amounts: (result?.summary || []).map((x) => ({ currency: x._id, amount: x.amount })),
            completedCostLYD: (result?.summary || []).reduce((n, x) => n + x.completedCost, 0),
        },
        rows: visible.map((tx) => {
            const service = SERVICE_CATALOG.find((s) => s.key === tx.transferType);
            return {
                id: String(tx._id),
                reference: tx.customId || String(tx._id),
                service: service?.label || 'تحويل',
                status: tx.status,
                statusLabel: STATUS_META[tx.status]?.label || 'قيد المتابعة',
                tone: STATUS_META[tx.status]?.tone || 'neutral',
                amount: tx.amount,
                currency: tx.currency,
                costLYD: tx.customerCost,
                recipient:
                    tx.transferType === 'bank_account'
                        ? tx.accountNumber || tx.vodafoneNumber || ''
                        : tx.vodafoneNumber || tx.accountNumber || '',
                recipientName: tx.accountName || '',
                createdAt: tx.createdAt,
            };
        }),
        nextCursor:
            (result?.rows || []).length > 20 && last
                ? Buffer.from(
                      JSON.stringify({ at: new Date(last.createdAt).toISOString(), id: String(last._id) })
                  ).toString('base64url')
                : null,
        updatedAt: now.toISOString(),
        asOf: asOf.toISOString(),
    };
};
module.exports = { normalizeFilters, decodeCursor, list, statuses };
