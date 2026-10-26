'use strict';

const ClientEmployee = require('../../models/ClientEmployee');
const AuditLog = require('../../models/AuditLog');
const agencyFinanceService = require('../agencyFinanceService');
const { pricingFromTransaction, roundMoney } = require('../../utils/agencyPricing');
const { buildArtifact: buildCentralReportArtifact } = require('../centralReportService');
const { findReportTransactions, getUnifiedReportStatus } = require('../unifiedReportService');
const { loadAdminReport, getDateRange } = require('../adminReportService');
const { systemDateKey, systemDayStart } = require('../../config/systemTime');
const { presentClientPortalTransaction } = require('../clientReceiptService');
const { formatInputDate, safeNumber } = require('./primitives');
const { SERVICE_CATALOG, REPORT_SCOPES, COMPANY_REPORT_SCOPES } = require('./catalog');
const { buildTransactionFilter, summarizeTransactions } = require('./transactions');

const reportGroupKey = (scope, tx) => {
    if (scope === 'customers')
        return tx.subAccountName || (tx.subAccountId ? 'عميل تابع' : 'عمليات الحساب الرئيسي');
    if (scope === 'staff') return tx.employeeName || 'غير محدد';
    const date = new Date(tx.createdAt);
    return formatInputDate(date);
};

const buildReportGroups = (transactions, scope) => {
    const groups = new Map();
    transactions.forEach((tx) => {
        const key = reportGroupKey(scope, tx);
        const current = groups.get(key) || {
            key,
            totalCount: 0,
            completedCount: 0,
            pendingCount: 0,
            cancelledCount: 0,
            totalEGP: 0,
            totalLYD: 0,
            deposits: 0,
            deductions: 0,
            realizedProfit: 0,
            expectedProfit: 0,
            reversedProfit: 0,
            lastActivity: tx.createdAt,
        };
        current.totalCount += 1;
        const agencyProfit = tx.isSubAccountTx ? pricingFromTransaction(tx).profitLYD : 0;
        if (tx.status === 'completed') {
            current.completedCount += 1;
            current.totalEGP += safeNumber(tx.amount);
            current.totalLYD += safeNumber(tx.costLYD);
            current.realizedProfit += agencyProfit;
        } else if (['pending', 'processing', 'accepted'].includes(tx.status)) {
            current.pendingCount += 1;
            current.expectedProfit += agencyProfit;
        } else if (['rejected', 'cancelled_by_admin'].includes(tx.status)) {
            current.cancelledCount += 1;
            current.reversedProfit += agencyProfit;
        } else if (tx.status === 'deposit') {
            current.deposits += safeNumber(tx.amount);
        } else if (tx.status === 'deduction') {
            current.deductions += safeNumber(tx.amount);
        }
        if (new Date(tx.createdAt) > new Date(current.lastActivity)) current.lastActivity = tx.createdAt;
        groups.set(key, current);
    });
    return [...groups.values()].sort(
        (left, right) => new Date(right.lastActivity) - new Date(left.lastActivity)
    );
};

const buildReportAnalytics = (transactions = [], balance = 0, now = new Date()) => {
    const dailyMap = new Map();
    transactions.forEach((transaction) => {
        const key = formatInputDate(new Date(transaction.createdAt));
        const current = dailyMap.get(key) || { date: key, incoming: 0, outgoing: 0, count: 0 };
        current.count += 1;
        if (transaction.status === 'deposit') current.incoming += safeNumber(transaction.amount);
        if (transaction.status === 'deduction') current.outgoing += safeNumber(transaction.amount);
        if (transaction.status === 'completed') current.outgoing += safeNumber(transaction.costLYD);
        dailyMap.set(key, current);
    });
    const liquiditySeries = [...dailyMap.values()].sort((left, right) => left.date.localeCompare(right.date));
    const totalIncoming = liquiditySeries.reduce((sum, item) => sum + item.incoming, 0);
    const totalOutgoing = liquiditySeries.reduce((sum, item) => sum + item.outgoing, 0);
    const todayKey = formatInputDate(now);
    const completedDays = liquiditySeries.filter((item) => item.date !== todayKey);
    const averageDailyOutflow = completedDays.length
        ? completedDays.reduce((sum, item) => sum + item.outgoing, 0) / completedDays.length
        : liquiditySeries.find((item) => item.date === todayKey)?.outgoing || 0;
    const todayOutflow = liquiditySeries.find((item) => item.date === todayKey)?.outgoing || 0;
    return {
        liquiditySeries,
        totalIncoming,
        totalOutgoing,
        netMovement: totalIncoming - totalOutgoing,
        forecastBalance: safeNumber(balance) - Math.max(0, averageDailyOutflow - todayOutflow),
        averageDailyOutflow,
    };
};

const centralCompanyReportInput = (workspace, query = {}) => {
    if (!workspace?.isCompany || !workspace.entity?._id) {
        const error = new Error('CENTRAL_COMPANY_REPORT_FORBIDDEN');
        error.statusCode = 403;
        throw error;
    }
    const requestedType = String(query.centralDateType || query.dateType || (query.from && query.to ? 'range' : '')).toLowerCase();
    const quickPeriod = String(query.period || '').toLowerCase();
    const now = new Date();
    if (quickPeriod === 'today') {
        const today = systemDateKey(now);
        return {
            mainCategory: 'company',
            subId: String(workspace.entity._id),
            subType: String(query.centralEmployee || 'all'),
            dateType: 'day',
            dateValue: today,
            dateFrom: today,
            dateTo: today,
        };
    }
    if (quickPeriod === 'week') {
        const end = systemDateKey(now);
        const start = systemDateKey(new Date(systemDayStart(end).getTime() - 6 * 86400000));
        return {
            mainCategory: 'company',
            subId: String(workspace.entity._id),
            subType: String(query.centralEmployee || 'all'),
            dateType: 'range',
            dateValue: '',
            dateFrom: start,
            dateTo: end,
        };
    }
    const dateType = requestedType === 'day' ? 'day' : 'month';
    const today = systemDateKey(now);
    const dateFrom = String(query.centralFrom || query.from || '');
    const dateTo = String(query.centralTo || query.to || '');
    const resolvedType = requestedType === 'range' ? 'range' : dateType;
    const dateValue =
        resolvedType === 'day'
            ? String(query.centralDay || query.centralDateValue || query.dateValue || query.from || today)
            : String(
                  query.centralMonth ||
                      query.centralDateValue ||
                      query.dateValue ||
                      query.month ||
                      today.slice(0, 7)
              );
    getDateRange(resolvedType, dateValue, dateFrom, dateTo);
    return {
        mainCategory: 'company',
        subId: String(workspace.entity._id),
        subType: String(query.centralEmployee || 'all'),
        dateType: resolvedType,
        dateValue,
        dateFrom,
        dateTo,
    };
};

const loadCentralCompanyReport = async (workspace, query = {}) => {
    const input = centralCompanyReportInput(workspace, query);
    input.tenantId = workspace.entity.tenantId || null;
    return { input, report: await loadAdminReport(input, { readOnly: true }) };
};

const loadReports = async (workspace, query = {}) => {
    const requestedScope = String(query.scope || 'organization');
    const availableScopes = workspace.isCompany ? COMPANY_REPORT_SCOPES : REPORT_SCOPES;
    const scope = availableScopes[requestedScope] ? requestedScope : 'organization';
    const companyCentralInput = workspace.isCompany ? centralCompanyReportInput(workspace, query) : null;
    const reportQuery =
        workspace.isCompany && companyCentralInput
            ? {
                  ...query,
                  staff: companyCentralInput.subType === 'all' ? '' : companyCentralInput.subType,
                  ...(companyCentralInput.dateType === 'day'
                      ? { from: companyCentralInput.dateValue, to: companyCentralInput.dateValue, month: '' }
                      : companyCentralInput.dateType === 'range'
                        ? { from: companyCentralInput.dateFrom, to: companyCentralInput.dateTo, month: '' }
                        : { from: '', to: '', month: companyCentralInput.dateValue }),
              }
            : query;
    const { filter, range } = await buildTransactionFilter(workspace, reportQuery, {
        forceToday: workspace.forceToday,
        purpose: 'reports',
    });
    // Reports are always read through the shared central reporting gateway.
    // It mirrors the financial source of truth used by the administration portal.
    const [transactions, centralSync, centralDownloads, centralAdminReport] = await Promise.all([
        findReportTransactions(filter, { sort: { createdAt: -1 }, limit: 5000 }),
        getUnifiedReportStatus().catch(() => ({ status: 'offline' })),
        AuditLog.find({ action: 'CENTRAL_REPORT_DOWNLOADED', targetId: workspace.entity._id })
            .sort({ createdAt: -1 })
            .limit(6)
            .select('performedByName metadata createdAt')
            .lean()
            .catch(() => []),
        workspace.isCompany
            ? loadAdminReport(companyCentralInput)
                  .then((report) => ({ input: companyCentralInput, report }))
                  .catch((error) => ({ error: error.message }))
            : Promise.resolve(null),
    ]);
    const reportSummary = summarizeTransactions(transactions);
    const reportRows = buildReportGroups(transactions, scope);
    const serviceBreakdown = SERVICE_CATALOG.map((service) => {
        const serviceTransactions = transactions.filter(
            (tx) => tx.transferType === service.key && tx.status === 'completed'
        );
        return {
            key: service.key,
            label: service.shortLabel,
            amountCurrencyLabel: service.amountCurrencyLabel,
            count: serviceTransactions.length,
            totalEGP: serviceTransactions.reduce((sum, tx) => sum + safeNumber(tx.amount), 0),
            totalLYD: serviceTransactions.reduce((sum, tx) => sum + safeNumber(tx.costLYD), 0),
            realizedProfit: roundMoney(
                serviceTransactions.reduce(
                    (sum, tx) => sum + (tx.isSubAccountTx ? pricingFromTransaction(tx).profitLYD : 0),
                    0
                )
            ),
        };
    }).filter((item) => item.count > 0);

    return {
        reportScope: scope,
        reportScopeLabel: availableScopes[scope],
        reportScopes: availableScopes,
        reportSummary,
        reportRows,
        serviceBreakdown,
        agencyProfitRows:
            workspace.isAgent && workspace.permissions.canViewBalance && workspace.permissions.canViewAllReports
                ? agencyFinanceService.buildProfitRows(transactions, new Map())
                : [],
        reportTransactions: transactions.slice(0, 100).map(presentClientPortalTransaction),
        reportAnalytics: buildReportAnalytics(transactions, workspace.entity.balance),
        filters: { ...range, scope },
        centralReport: buildCentralReportArtifact({
            workspace,
            report: { reportScope: scope, filters: range, reportSummary, reportRows },
        }),
        centralSync,
        centralDownloads,
        centralAdminReport: centralAdminReport?.report || null,
        centralAdminReportInput: centralAdminReport?.input || null,
        companyReportEmployees: workspace.isCompany
            ? await ClientEmployee.find({ companyId: workspace.entity._id, status: 'active' })
                  .select('name role')
                  .sort({ name: 1 })
                  .lean()
            : [],
    };
};

module.exports = {
    reportGroupKey,
    buildReportGroups,
    buildReportAnalytics,
    centralCompanyReportInput,
    loadCentralCompanyReport,
    loadReports,
};
