'use strict';
const AgentEmployee = require('../models/AgentEmployee');
const { buildAgentTransactionScope } = require('./agentTransactionScopeService');
const RegistrationRequest = require('../models/RegistrationRequest');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const { escapeRegex } = require('../utils/helpers');
const { getServiceRatesForTier } = require('../utils/rateHelper');
const statusLabels = {
    pending: 'قيد الانتظار',
    processing: 'قيد التنفيذ',
    accepted: 'قيد التنفيذ',
    completed: 'ناجحة',
    rejected: 'مرفوضة',
    cancelled_by_admin: 'ملغية',
    deposit_pending: 'إيداع معلق',
    deposit: 'إيداع',
    deduction: 'خصم',
};

const serviceLabels = {
    vodafone: 'محافظ كاش',
    post_card: 'بريد بطاقة',
    post_account: 'بريد حساب',
    bank_account: 'حساب بنكي',
    sefa_niger: 'سيفا النيجر',
    bankak_sudan: 'بنكك السودان',
};

const { resolveAgentPermissions, dashboardPersona } = require('../utils/agentPortalPolicy');
const isAgentOwner = (actor) => resolveAgentPermissions(actor).owner;
const canManageAgent = (actor) => resolveAgentPermissions(actor).canManageCustomers;
const canCreateAgentStaff = (actor) => resolveAgentPermissions(actor).canManageStaff;
const canViewAgentBalance = (actor) => resolveAgentPermissions(actor).canViewBalance;
const canTransfer = (actor) => resolveAgentPermissions(actor).canTransfer;

const parseLocalDay = (dateValue) => {
    const match = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const [, year, month, day] = match;
    return new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
};

const resolveRange = (query = {}, forceToday = false) => {
    const now = new Date();
    if (forceToday) {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        return {
            start,
            end,
            targetDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
            targetMonth: '',
            dateLabel: 'عمليات اليوم',
            showMonth: false,
        };
    }

    const explicitDate = parseLocalDay(query.date);
    if (explicitDate) {
        const end = new Date(
            explicitDate.getFullYear(),
            explicitDate.getMonth(),
            explicitDate.getDate(),
            23,
            59,
            59,
            999
        );
        return {
            start: explicitDate,
            end,
            targetDate: query.date,
            targetMonth: '',
            dateLabel: query.date,
            showMonth: false,
        };
    }

    const monthMatch = String(query.month || '').match(/^(\d{4})-(\d{2})$/);
    const year = monthMatch ? Number(monthMatch[1]) : now.getFullYear();
    const month = monthMatch ? Number(monthMatch[2]) - 1 : now.getMonth();
    const start = new Date(year, month, 1, 0, 0, 0, 0);
    const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
    return {
        start,
        end,
        targetDate: '',
        targetMonth: `${year}-${String(month + 1).padStart(2, '0')}`,
        dateLabel: `شهر ${month + 1} / ${year}`,
        showMonth: true,
    };
};

const { loadAgentPortalActor } = require('./agentPortalAccessService');
const getAgentActor = (req, preloadedAccount = null) => loadAgentPortalActor(req, { preloadedAccount });

const transactionQueryForAgent = async ({ actor, agent, start, end, search }) => {
    const query = {
        $and: [await buildAgentTransactionScope({ agent, actor }), { createdAt: { $gte: start, $lte: end } }],
    };

    if (search) {
        const escapedSearch = escapeRegex(search);
        query.$and.push({
            $or: [
                { customId: { $regex: escapedSearch, $options: 'i' } },
                { vodafoneNumber: { $regex: escapedSearch, $options: 'i' } },
                { accountNumber: { $regex: escapedSearch, $options: 'i' } },
                { employeeName: { $regex: escapedSearch, $options: 'i' } },
                { subAccountName: { $regex: escapedSearch, $options: 'i' } },
                { notes: { $regex: escapedSearch, $options: 'i' } },
            ],
        });
    }

    return query;
};

const summarizeTransactions = (transactions) =>
    transactions.reduce(
        (totals, tx) => {
            if (tx.status === 'completed') {
                totals.completedCount += 1;
                totals.totalEGP += Number(tx.amount || 0);
                totals.totalLYD += Number(tx.costLYD || 0);
            } else if (['pending', 'processing', 'accepted'].includes(tx.status)) {
                totals.pendingCount += 1;
            } else if (['rejected', 'cancelled_by_admin'].includes(tx.status)) {
                totals.cancelledCount += 1;
            } else if (tx.status === 'deposit') {
                totals.deposits += Number(tx.amount || 0);
            } else if (tx.status === 'deduction') {
                totals.deposits -= Number(tx.amount || 0);
            }
            return totals;
        },
        {
            completedCount: 0,
            pendingCount: 0,
            cancelledCount: 0,
            totalEGP: 0,
            totalLYD: 0,
            deposits: 0,
        }
    );

const buildContext = async ({ req, actor, agent, actorModel, forceToday = false }) => {
    const range = resolveRange(req.query, forceToday);
    const search = req.query.search ? String(req.query.search).trim().slice(0, 80) : '';
    const [settings, staff, pendingRequests, txQuery] = await Promise.all([
        Settings.findOne({}).lean(),
        AgentEmployee.find({ agentId: agent._id, status: { $ne: 'deleted' } })
            .sort({ role: 1, createdAt: -1 })
            .lean(),
        RegistrationRequest.find({ accountType: 'new', status: 'pending_agent', agentId: agent._id })
            .sort({ createdAt: -1 })
            .lean(),
        transactionQueryForAgent({ actor, agent, ...range, search }),
    ]);
    const transactions = await Transaction.find(txQuery).sort({ createdAt: -1 }).lean();
    const serviceRates = getServiceRatesForTier(agent.tier || 1, settings || {});

    return {
        account: actor,
        actor,
        agent,
        actorModel,
        company: agent,
        entityLabel: 'الوكيل',
        roleLabel: isAgentOwner(actor)
            ? 'مدير الوكيل'
            : canManageAgent(actor)
              ? 'مدير تشغيل'
              : actor.role === 'accountant'
                ? 'محاسب'
                : 'موظف',
        persona: dashboardPersona(actor),
        canManageAgent: canManageAgent(actor),
        canCreateStaff: canCreateAgentStaff(actor),
        canViewBalance: canViewAgentBalance(actor),
        canTransfer: canTransfer(actor),
        staff,
        staffCount: staff.filter((item) => item.status === 'active').length,
        pendingRequests,
        transactions,
        totals: summarizeTransactions(transactions),
        serviceRates,
        currentRate: serviceRates.vodafone || 0,
        statusLabels,
        serviceLabels,
        search,
        query: req.query || {},
        csrfToken: req.session.csrfToken || '',
        ...range,
    };
};

module.exports = { getAgentActor, buildContext };
