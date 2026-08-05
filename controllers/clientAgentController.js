const User = require('../models/User');
const AgentEmployee = require('../models/AgentEmployee');
const SubAccount = require('../models/SubAccount');
const RegistrationRequest = require('../models/RegistrationRequest');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const ClientEmployee = require('../models/ClientEmployee');
const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const { getServiceRatesForTier } = require('../utils/rateHelper');
const { logAction } = require('../services/auditService');
const {
    CODE_LENGTHS,
    assignGeneratedAccountCode
} = require('../services/accountCodeService');
const { prepareRegistrationIdentityForApproval } = require('../services/registrationIdentityService');

const USERNAME_DOMAIN = '@ahram.com';

const statusLabels = {
    pending: 'قيد الانتظار',
    processing: 'قيد التنفيذ',
    accepted: 'قيد التنفيذ',
    completed: 'ناجحة',
    rejected: 'مرفوضة',
    cancelled_by_admin: 'ملغية',
    deposit_pending: 'إيداع معلق',
    deposit: 'إيداع',
    deduction: 'خصم'
};

const serviceLabels = {
    vodafone: 'محافظ كاش',
    post_card: 'بريد بطاقة',
    post_account: 'بريد حساب',
    bank_account: 'حساب بنكي',
    sefa_niger: 'سيفا النيجر',
    bankak_sudan: 'بنكك السودان'
};

const isChecked = (value) => ['on', 'true', '1', 'yes'].includes(String(value || '').toLowerCase());

const normalizeUsername = (rawUsername) => {
    const base = String(rawUsername || '').trim().toLowerCase();
    const username = base.includes('@') ? base : `${base}${USERNAME_DOMAIN}`;
    if (!/^[a-z0-9_]{3,40}@ahram\.com$/.test(username)) {
        throw new Error('INVALID_USERNAME');
    }
    return username;
};

const isAgentOwner = (account) => account && account.role === 'agent';
const canManageAgent = (actor) => isAgentOwner(actor) || actor.canManageAgent === true;
const canCreateAgentStaff = (actor) => isAgentOwner(actor) || actor.canCreateAgentStaff === true;
const canViewAgentBalance = (actor) => (
    isAgentOwner(actor)
    || actor.canManageAgent === true
    || actor.canViewAllReports === true
    || actor.role === 'accountant'
);
const canTransfer = (actor) => actor.role !== 'accountant';

const dashboardPersona = (actor) => {
    if (isAgentOwner(actor) || canManageAgent(actor)) return 'manager';
    if (actor.role === 'accountant') return 'accountant';
    return 'employee';
};

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
            showMonth: false
        };
    }

    const explicitDate = parseLocalDay(query.date);
    if (explicitDate) {
        const end = new Date(explicitDate.getFullYear(), explicitDate.getMonth(), explicitDate.getDate(), 23, 59, 59, 999);
        return { start: explicitDate, end, targetDate: query.date, targetMonth: '', dateLabel: query.date, showMonth: false };
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
        showMonth: true
    };
};

const getAgentActor = async (req, preloadedAccount = null) => {
    if (req.session.accountType === 'user') {
        const account = preloadedAccount || await User.findById(req.session.clientId);
        if (!account || account.status !== 'active' || account.role !== 'agent') throw new Error('INVALID_AGENT');
        return { actor: account, agent: account, actorModel: 'User' };
    }

    if (req.session.accountType === 'agent_staff') {
        const actor = preloadedAccount || await AgentEmployee.findById(req.session.clientId);
        if (!actor || actor.status !== 'active') throw new Error('INVALID_AGENT_STAFF');
        const agent = await User.findById(actor.agentId);
        if (!agent || agent.status !== 'active' || agent.role !== 'agent') throw new Error('INVALID_AGENT');
        return { actor, agent, actorModel: 'AgentEmployee' };
    }

    throw new Error('NOT_AGENT_SESSION');
};

const assertUsernameAvailable = async (webUsername) => {
    const [user, subAccount, clientEmployee, agentEmployee, executor, admin] = await Promise.all([
        User.exists({ webUsername }),
        SubAccount.exists({ webUsername }),
        ClientEmployee.exists({ webUsername }),
        AgentEmployee.exists({ webUsername }),
        Employee.exists({ webUsername }),
        Admin.exists({ webUsername })
    ]);

    if (user || subAccount || clientEmployee || agentEmployee || executor || admin) {
        throw new Error('USERNAME_TAKEN');
    }
};

const transactionQueryForAgent = async ({ agent, start, end, search }) => {
    const subAccountIds = await SubAccount
        .find({ masterType: 'user', masterId: agent._id, status: { $ne: 'deleted' } })
        .select('_id')
        .lean();

    const query = {
        createdAt: { $gte: start, $lte: end },
        $or: [
            { userId: agent.phone || agent.webUsername, companyId: null },
            { userId: agent.webUsername, companyId: null },
            { subAccountId: { $in: subAccountIds.map((item) => item._id) } }
        ]
    };

    if (search) {
        query.$and = [{
            $or: [
                { customId: { $regex: search, $options: 'i' } },
                { vodafoneNumber: { $regex: search, $options: 'i' } },
                { accountNumber: { $regex: search, $options: 'i' } },
                { employeeName: { $regex: search, $options: 'i' } },
                { subAccountName: { $regex: search, $options: 'i' } },
                { notes: { $regex: search, $options: 'i' } }
            ]
        }];
    }

    return query;
};

const summarizeTransactions = (transactions) => transactions.reduce((totals, tx) => {
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
}, {
    completedCount: 0,
    pendingCount: 0,
    cancelledCount: 0,
    totalEGP: 0,
    totalLYD: 0,
    deposits: 0
});

const buildContext = async ({ req, actor, agent, actorModel, forceToday = false }) => {
    const range = resolveRange(req.query, forceToday);
    const search = req.query.search ? String(req.query.search).trim() : '';
    const [settings, staff, pendingRequests, txQuery] = await Promise.all([
        Settings.findOne({}).lean(),
        AgentEmployee.find({ agentId: agent._id, status: { $ne: 'deleted' } }).sort({ role: 1, createdAt: -1 }).lean(),
        RegistrationRequest.find({ accountType: 'new', status: 'pending_agent', agentId: agent._id }).sort({ createdAt: -1 }).lean(),
        transactionQueryForAgent({ agent, ...range, search })
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
        roleLabel: isAgentOwner(actor) ? 'مدير الوكيل' : (canManageAgent(actor) ? 'مدير تشغيل' : (actor.role === 'accountant' ? 'محاسب' : 'موظف')),
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
        ...range
    };
};

exports.renderAgentDashboard = async (req, res, preloadedAccount = null) => {
    try {
        const { actor, agent, actorModel } = await getAgentActor(req, preloadedAccount);
        const persona = dashboardPersona(actor);
        const context = await buildContext({
            req,
            actor,
            agent,
            actorModel,
            forceToday: persona === 'employee'
        });

        if (persona === 'accountant') return res.render('client/agent_accountant_dashboard', context);
        if (persona === 'manager') return res.render('client/agent_manager_dashboard', context);
        return res.render('client/agent_employee_dashboard', context);
    } catch (error) {
        console.error('[Agent Dashboard] render failed:', error.message);
        return res.redirect('/client/logout');
    }
};

exports.postAddStaff = async (req, res) => {
    try {
        const { actor, agent, actorModel } = await getAgentActor(req);
        if (!canCreateAgentStaff(actor)) return res.status(403).redirect('/client/staff?staffError=forbidden');

        const name = String(req.body.name || '').trim();
        const phone = String(req.body.phone || '').trim();
        const webPassword = String(req.body.webPassword || '').trim();
        const role = String(req.body.role || 'employee').trim();
        const grantManagerAccess = isChecked(req.body.canManageAgent);

        if (!name || !phone || !webPassword || !['employee', 'accountant'].includes(role)) {
            return res.redirect('/client/staff?staffError=missing');
        }
        if (webPassword.length < 6) return res.redirect('/client/staff?staffError=password');

        const webUsername = normalizeUsername(req.body.webUsername);
        await assertUsernameAvailable(webUsername);

        const created = await AgentEmployee.create({
            agentId: agent._id,
            name,
            phone,
            webUsername,
            webPassword,
            role,
            status: 'active',
            canManageAgent: grantManagerAccess,
            canCreateAgentStaff: false,
            canViewAllReports: role === 'accountant' || grantManagerAccess
        });

        await logAction({
            action: 'USER_CREATED',
            req,
            performedById: actor._id,
            performedByModel: actorModel,
            performedByName: actor.name,
            targetId: created._id,
            targetModel: 'AgentEmployee',
            result: 'ناجح',
            metadata: { agentId: agent._id, role, canManageAgent: grantManagerAccess, webUsername }
        });

        return res.redirect('/client/staff?staffSuccess=created');
    } catch (error) {
        const code = error.message === 'USERNAME_TAKEN'
            ? 'username'
            : error.message === 'INVALID_USERNAME'
                ? 'username_format'
                : 'server';
        console.error('[Agent Staff] create failed:', error.message);
        return res.redirect(`/client/staff?staffError=${code}`);
    }
};

exports.postToggleStaff = async (req, res) => {
    try {
        const { actor, agent, actorModel } = await getAgentActor(req);
        if (!canCreateAgentStaff(actor)) return res.status(403).redirect('/client/staff?staffError=forbidden');

        const target = await AgentEmployee.findOne({ _id: req.params.id, agentId: agent._id });
        if (!target || String(target._id) === String(actor._id)) {
            return res.redirect('/client/staff?staffError=forbidden');
        }

        target.status = target.status === 'active' ? 'banned' : 'active';
        await target.save();

        await logAction({
            action: 'USER_STATUS_CHANGED',
            req,
            performedById: actor._id,
            performedByModel: actorModel,
            performedByName: actor.name,
            targetId: target._id,
            targetModel: 'AgentEmployee',
            result: target.status,
            metadata: { agentId: agent._id, webUsername: target.webUsername }
        });

        return res.redirect('/client/staff?staffSuccess=status');
    } catch (error) {
        console.error('[Agent Staff] toggle failed:', error.message);
        return res.redirect('/client/staff?staffError=server');
    }
};

exports.postResetStaffPassword = async (req, res) => {
    try {
        const { actor, agent, actorModel } = await getAgentActor(req);
        if (!canCreateAgentStaff(actor)) return res.status(403).redirect('/client/staff?staffError=forbidden');

        const newPassword = String(req.body.newPassword || '').trim();
        if (newPassword.length < 6) return res.redirect('/client/staff?staffError=password');

        const target = await AgentEmployee.findOne({ _id: req.params.id, agentId: agent._id });
        if (!target || String(target._id) === String(actor._id)) {
            return res.redirect('/client/staff?staffError=forbidden');
        }

        target.webPassword = newPassword;
        await target.save();

        await logAction({
            action: 'USER_PASSWORD_CHANGED',
            req,
            performedById: actor._id,
            performedByModel: actorModel,
            performedByName: actor.name,
            targetId: target._id,
            targetModel: 'AgentEmployee',
            result: 'ناجح',
            metadata: { agentId: agent._id, webUsername: target.webUsername }
        });

        return res.redirect('/client/staff?staffSuccess=password');
    } catch (error) {
        console.error('[Agent Staff] reset failed:', error.message);
        return res.redirect('/client/staff?staffError=server');
    }
};

exports.postApproveClientRequest = async (req, res) => {
    try {
        const { actor, agent, actorModel } = await getAgentActor(req);
        if (!canManageAgent(actor)) return res.status(403).redirect('/client/customers?requestError=forbidden');

        const regReq = await RegistrationRequest.findOne({
            _id: req.params.id,
            accountType: 'new',
            status: 'pending_agent',
            agentId: agent._id
        });
        if (!regReq) return res.redirect('/client/customers?requestError=notfound');

        await prepareRegistrationIdentityForApproval({
            phone: regReq.phone,
            username: regReq.username,
            excludeRequestId: regReq._id
        });

        const subAccount = await SubAccount.create({
            masterType: 'user',
            masterId: agent._id,
            name: regReq.fullName,
            phone: regReq.phone,
            webUsername: regReq.username,
            webPassword: regReq.password,
            status: 'active',
            balance: 0
        });

        await assignGeneratedAccountCode({
            Model: SubAccount,
            modelName: 'SubAccount',
            id: subAccount._id,
            length: CODE_LENGTHS.subAccount
        });

        regReq.status = 'approved';
        regReq.reviewedBy = actor.name || actor.webUsername;
        regReq.reviewedAt = new Date();
        await regReq.save();

        await logAction({
            action: 'REGISTRATION_APPROVED',
            req,
            performedById: actor._id,
            performedByModel: actorModel,
            performedByName: actor.name,
            targetId: subAccount._id,
            targetModel: 'SubAccount',
            result: 'ناجح',
            metadata: { regRequestId: regReq._id, refCode: regReq.refCode, agentId: agent._id }
        });

        return res.redirect('/client/customers?requestSuccess=approved');
    } catch (error) {
        console.error('[Agent Requests] approve failed:', error.message);
        if (['USERNAME_TAKEN', 'PHONE_TAKEN', 'IDENTITY_PENDING', 'IDENTITY_TAKEN'].includes(error.message)) {
            return res.redirect('/client/customers?requestError=duplicate');
        }
        return res.redirect('/client/customers?requestError=server');
    }
};

exports.postRejectClientRequest = async (req, res) => {
    try {
        const { actor, agent, actorModel } = await getAgentActor(req);
        if (!canManageAgent(actor)) return res.status(403).redirect('/client/customers?requestError=forbidden');

        const regReq = await RegistrationRequest.findOne({
            _id: req.params.id,
            accountType: 'new',
            status: 'pending_agent',
            agentId: agent._id
        });
        if (!regReq) return res.redirect('/client/customers?requestError=notfound');

        regReq.status = 'rejected';
        regReq.reviewedBy = actor.name || actor.webUsername;
        regReq.reviewedAt = new Date();
        regReq.adminNotes = [regReq.adminNotes, req.body.notes || 'تم الرفض من الوكيل'].filter(Boolean).join('\n');
        await regReq.save();

        await logAction({
            action: 'REGISTRATION_REJECTED',
            req,
            performedById: actor._id,
            performedByModel: actorModel,
            performedByName: actor.name,
            result: 'مرفوض',
            metadata: { regRequestId: regReq._id, refCode: regReq.refCode, agentId: agent._id }
        });

        return res.redirect('/client/customers?requestSuccess=rejected');
    } catch (error) {
        console.error('[Agent Requests] reject failed:', error.message);
        return res.redirect('/client/customers?requestError=server');
    }
};

exports.agentRoleHelpers = {
    isAgentOwner,
    canManageAgent,
    canCreateAgentStaff,
    canViewAgentBalance,
    canTransfer,
    dashboardPersona,
    normalizeUsername
};
