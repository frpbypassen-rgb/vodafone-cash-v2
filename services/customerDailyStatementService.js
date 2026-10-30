'use strict';
const path = require('path'),
    ejs = require('ejs');
const Transaction = require('../models/Transaction');
const { systemDayStart, systemDayEnd, systemDateKey } = require('../config/systemTime');
const { buildReportSummary } = require('../utils/adminReportCalculations');
const { sanitizeAccountStatementReport } = require('../utils/accountStatementPrivacy');
const { generateAdminReportPdf } = require('./reportPdfService');
const previousDay = (now = new Date()) =>
    systemDateKey(new Date(systemDayStart(systemDateKey(now)).getTime() - 1));
const statementScope = (ctx) => {
    if (!ctx?.isCustomer || !ctx.actor?._id) throw new Error('REPORT_FORBIDDEN');
    const identity = [String(ctx.actor._id), ctx.actor.phone, ctx.actor.webUsername].filter(Boolean);
    const own =
        ctx.actorModel === 'SubAccount'
            ? { subAccountId: ctx.actor._id }
            : { userId: { $in: identity }, companyId: null, subAccountId: null };
    return { ...own, tenantId: ctx.actor.tenantId || null };
};
const loadStatement = async (ctx, day) => {
    const start = systemDayStart(day),
        end = systemDayEnd(day);
    if (!start || !end) throw new Error('INVALID_REPORT_DAY');
    const own = statementScope(ctx);
    const cost =
        ctx.actorModel === 'SubAccount'
            ? {
                  $ifNull: [
                      '$agencyPricing.customerChargeLYD',
                      { $ifNull: ['$subAccountCostLYD', { $ifNull: ['$costLYD', 0] }] },
                  ],
              }
            : { $ifNull: ['$costLYD', 0] };
    const [opening, rows] = await Promise.all([
        Transaction.aggregate([
            { $match: { ...own, createdAt: { $lt: start } } },
            {
                $group: {
                    _id: null,
                    balance: {
                        $sum: {
                            $switch: {
                                branches: [
                                    { case: { $eq: ['$status', 'deposit'] }, then: { $abs: '$amount' } },
                                    {
                                        case: { $eq: ['$status', 'deduction'] },
                                        then: { $multiply: [-1, { $abs: '$amount' }] },
                                    },
                                    {
                                        case: { $eq: ['$status', 'completed'] },
                                        then: { $multiply: [-1, cost] },
                                    },
                                ],
                                default: 0,
                            },
                        },
                    },
                },
            },
        ]),
        Transaction.find({ ...own, createdAt: { $gte: start, $lte: end } })
            .select(
                'customId status transferType amount costLYD subAccountCostLYD agencyPricing.customerChargeLYD vodafoneNumber accountNumber accountName customerNotes createdAt'
            )
            .sort({ createdAt: -1 })
            .limit(5001)
            .lean(),
    ]);
    if (rows.length > 5000) throw new Error('REPORT_TOO_LARGE');
    const balance = opening[0]?.balance || 0,
        calculated = buildReportSummary({
            previousTransactions: [
                { status: balance >= 0 ? 'deposit' : 'deduction', amount: Math.abs(balance) },
            ],
            currentTransactions: rows.map((row) => {
                const result = {
                    ...row,
                    costLYD:
                        ctx.actorModel === 'SubAccount'
                            ? (row.agencyPricing?.customerChargeLYD ?? row.subAccountCostLYD ?? row.costLYD)
                            : row.costLYD,
                };
                delete result.agencyPricing;
                delete result.subAccountCostLYD;
                return result;
            }),
        });
    return sanitizeAccountStatementReport({
        success: true,
        scope: { mainCategory: 'direct_client', subId: String(ctx.actor._id), subType: 'all' },
        range: { dateType: 'day', start, end },
        entityInfo: {
            name: ctx.actor.name,
            phone: ctx.actor.phone,
            username: ctx.actor.webUsername,
            joinDate: ctx.actor.createdAt,
            status: 'حساب عميل',
        },
        ...calculated,
        movements: [],
        closedDayChanges: [],
        closure: { closedDays: [], closedDayCount: 0, hasPostCloseChanges: false, status: 'open' },
    });
};
const createStatementPdf = async (ctx, day) =>
    generateAdminReportPdf(
        {
            render: (view, data, callback) =>
                ejs.renderFile(path.join(__dirname, '../views', view + '.ejs'), data, callback),
        },
        { report: await loadStatement(ctx, day), generatedAt: new Date(), adminName: 'كشف حساب العميل' }
    );
module.exports = { previousDay, statementScope, loadStatement, createStatementPdf };
