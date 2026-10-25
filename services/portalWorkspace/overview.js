'use strict';

const SubAccount = require('../../models/SubAccount');
const Transaction = require('../../models/Transaction');
const RegistrationRequest = require('../../models/RegistrationRequest');
const { presentClientPortalTransaction } = require('../clientReceiptService');
const { sanitizeStatementText } = require('../../utils/accountStatementPrivacy');
const { loadCompanyCommandCenter } = require('../companyCommandCenterService');
const { startOfDay, endOfDay, safeNumber } = require('./primitives');
const {
    ownershipFilter,
    summarizeTransactions,
    summarizeWithAggregation,
    staffModelForWorkspace,
    staffOwnerFilter,
    buildTransactionFilter,
} = require('./transactions');
const { countPendingCompanyDeposits } = require('./deposits');
const { SERVICE_CATALOG } = require('./catalog');

const loadOverview = async (workspace) => {
    const now = new Date();
    const monthRange = {
        start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
    };
    const todayRange = { start: startOfDay(now), end: endOfDay(now) };
    const canSeeCustomerStats = workspace.permissions.canManageCustomers;
    const canSeeStaffStats = workspace.permissions.manager || workspace.permissions.accountant;
    const [ownership, customersCount, activeCustomersCount, staffCount, activeStaffCount, pendingRequests] =
        await Promise.all([
            ownershipFilter(workspace),
            canSeeCustomerStats
                ? SubAccount.countDocuments({
                      masterType: workspace.masterType,
                      masterId: workspace.masterId,
                      status: { $ne: 'deleted' },
                  })
                : Promise.resolve(0),
            canSeeCustomerStats
                ? SubAccount.countDocuments({
                      masterType: workspace.masterType,
                      masterId: workspace.masterId,
                      status: 'active',
                  })
                : Promise.resolve(0),
            canSeeStaffStats
                ? staffModelForWorkspace(workspace).countDocuments(staffOwnerFilter(workspace))
                : Promise.resolve(0),
            canSeeStaffStats
                ? staffModelForWorkspace(workspace).countDocuments({
                      ...staffOwnerFilter(workspace),
                      status: 'active',
                  })
                : Promise.resolve(0),
            workspace.isAgent && canSeeCustomerStats
                ? RegistrationRequest.countDocuments({
                      accountType: 'new',
                      status: 'pending_agent',
                      agentId: workspace.entity._id,
                  })
                : Promise.resolve(0),
        ]);
    const monthFilter = {
        $and: [ownership, { createdAt: { $gte: monthRange.start, $lte: monthRange.end } }],
    };
    const todayFilter = {
        $and: [ownership, { createdAt: { $gte: todayRange.start, $lte: todayRange.end } }],
    };
    const [monthSummary, todaySummary, recentTransactions] = await Promise.all([
        summarizeWithAggregation(workspace.forceToday ? todayFilter : monthFilter),
        summarizeWithAggregation(todayFilter),
        Transaction.find(workspace.forceToday ? todayFilter : ownership)
            .sort({ createdAt: -1 })
            .limit(8)
            .lean(),
    ]);
    const teamSpotlight = [];

    const weekRange = {
        start: new Date(todayRange.start.getTime() - 6 * 24 * 60 * 60 * 1000),
        end: todayRange.end,
    };
    const commandCenter = workspace.isCompany
        ? await loadCompanyCommandCenter({
              workspace,
              ownership,
              todayRange,
              weekRange,
              monthRange,
              summarize: summarizeWithAggregation,
          })
        : {
              weekSummary: summarizeTransactions([]),
              weekdaySeries: [],
              employeeRoster: [],
              onlineWindowMinutes: 10,
              commandCenterChart: { labels: [], counts: [], values: [], showValues: false },
          };

    return {
        monthSummary,
        todaySummary,
        weekSummary: commandCenter.weekSummary,
        weekdaySeries: commandCenter.weekdaySeries,
        employeeRoster: commandCenter.employeeRoster,
        onlineWindowMinutes: commandCenter.onlineWindowMinutes,
        commandCenterChart: commandCenter.commandCenterChart,
        recentTransactions: recentTransactions.map(presentClientPortalTransaction),
        customersCount,
        activeCustomersCount,
        staffCount,
        activeStaffCount,
        pendingRequests,
        teamSpotlight,
        pendingDepositCount: workspace.isCompany
            ? await countPendingCompanyDeposits(workspace, ownership)
            : 0,
        currentMonthLabel: workspace.forceToday
            ? 'اليوم'
            : `شهر ${now.getMonth() + 1} / ${now.getFullYear()}`,
    };
};

const loadTransferHub = async (workspace, serviceKey = '') => {
    const ownership = await ownershipFilter(workspace);
    const serviceCondition = SERVICE_CATALOG.some((service) => service.key === serviceKey)
        ? { transferType: serviceKey }
        : { transferType: { $in: SERVICE_CATALOG.map((service) => service.key) } };
    const transactions = await Transaction.find({
        $and: [
            ownership,
            serviceCondition,
            { status: { $nin: ['deposit', 'deposit_pending', 'deduction'] } },
        ],
    })
        .select(
            'customId status transferType amount accountName vodafoneNumber accountNumber serviceDetails.clientPhone serviceDetails.destinationLabel notes createdAt'
        )
        .sort({ createdAt: -1 })
        .limit(60)
        .lean();
    const reasons = new Map();
    transactions.forEach((transaction) => {
        const note = sanitizeStatementText(transaction.notes || '').trim();
        if (note && note.length <= 80) reasons.set(note, (reasons.get(note) || 0) + 1);
    });
    return {
        transferHub: {
            suggestedReasons: [...reasons.entries()]
                .sort((left, right) => right[1] - left[1])
                .slice(0, 5)
                .map(([reason]) => reason),
            recentOperations: transactions.slice(0, 5),
        },
    };
};

const loadCompanyHome = async (workspace) => {
    const ownership = await ownershipFilter(workspace);
    const now = new Date();
    const today = { createdAt: { $gte: startOfDay(now), $lte: endOfDay(now) } };
    const [groups, recent] = await Promise.all([
        Transaction.aggregate([
            { $match: { $and: [ownership, today] } },
            {
                $group: {
                    _id: { service: '$transferType', status: '$status' },
                    count: { $sum: 1 },
                    amount: { $sum: '$amount' },
                },
            },
        ]),
        Transaction.find({
            $and: [
                ownership,
                ...(workspace.forceToday ? [today] : []),
                {
                    transferType: { $in: SERVICE_CATALOG.map((item) => item.key) },
                    status: { $nin: ['deposit', 'deposit_pending', 'deduction'] },
                },
            ],
        })
            .sort({ createdAt: -1 })
            .limit(6)
            .lean(),
    ]);
    const home = {
        cash: { count: 0, amount: 0 },
        bank: { count: 0, amount: 0 },
        deposits: 0,
        pending: 0,
        recent: recent.map(presentClientPortalTransaction),
    };
    groups.forEach((row) => {
        if (row._id.status === 'deposit') home.deposits += safeNumber(row.amount);
        if (['pending', 'accepted', 'processing'].includes(row._id.status)) home.pending += row.count;
        if (row._id.status !== 'completed') return;
        const key =
            row._id.service === 'vodafone' ? 'cash' : row._id.service === 'bank_account' ? 'bank' : null;
        if (key) {
            home[key].count += row.count;
            home[key].amount += safeNumber(row.amount);
        }
    });
    return home;
};

const loadTransactions = async (workspace, query = {}) => {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = 25;
    const { filter, range, search, includeAllHistory } = await buildTransactionFilter(workspace, query, {
        forceToday: workspace.isAgent || workspace.forceToday,
    });
    const StaffModel = staffModelForWorkspace(workspace);
    const [transactions, total, summary, staff, customers] = await Promise.all([
        Transaction.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        Transaction.countDocuments(filter),
        summarizeWithAggregation(filter),
        StaffModel.find(staffOwnerFilter(workspace)).select('name role status').sort({ name: 1 }).lean(),
        SubAccount.find({
            masterType: workspace.masterType,
            masterId: workspace.masterId,
            status: { $ne: 'deleted' },
        })
            .select('name status accountCode')
            .sort({ name: 1 })
            .lean(),
    ]);

    return {
        transactions: transactions.map(presentClientPortalTransaction),
        total,
        summary,
        staff,
        customers,
        pagination: { page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
        filters: {
            search,
            status: query.status || '',
            service: query.service || '',
            staff: query.staff || '',
            customer: query.customer || '',
            history: includeAllHistory ? 'all' : '',
            ...range,
        },
    };
};

module.exports = { loadOverview, loadTransferHub, loadCompanyHome, loadTransactions };
