'use strict';

const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const Transaction = require('../models/Transaction');
const RegistrationRequest = require('../models/RegistrationRequest');
const Settings = require('../models/Settings');
const Ledger = require('../models/Ledger');
const { getServiceRatesForTier, getCompanyServiceRates } = require('../utils/rateHelper');
const { getTransferServiceRules } = require('../utils/transferServiceRules');
const {
    sanitizeStatementMovement,
    sanitizeStatementTransaction
} = require('../utils/accountStatementPrivacy');

const STATUS_META = Object.freeze({
    pending: { label: 'قيد الانتظار', tone: 'warning' },
    processing: { label: 'قيد التنفيذ', tone: 'info' },
    accepted: { label: 'قيد التنفيذ', tone: 'info' },
    completed: { label: 'ناجحة', tone: 'success' },
    rejected: { label: 'مرفوضة', tone: 'danger' },
    cancelled_by_admin: { label: 'ملغية', tone: 'danger' },
    deposit_pending: { label: 'إيداع معلق', tone: 'warning' },
    deposit: { label: 'إيداع', tone: 'success' },
    deduction: { label: 'خصم', tone: 'danger' }
});

const SERVICE_CATALOG = Object.freeze([
    Object.freeze({
        key: 'vodafone',
        webType: 'كاش',
        label: 'محافظ كاش',
        shortLabel: 'كاش',
        icon: 'fa-mobile-screen-button',
        tone: 'green',
        description: 'تحويل مباشر إلى المحافظ الإلكترونية المصرية.',
        numberLabel: 'رقم المحفظة',
        numberPlaceholder: '01XXXXXXXXX',
        ...getTransferServiceRules('vodafone')
    }),
    Object.freeze({
        key: 'post_account',
        webType: 'بريد حساب',
        label: 'البريد - حساب',
        shortLabel: 'بريد حساب',
        icon: 'fa-building-columns',
        tone: 'blue',
        description: 'تحويل إلى حساب بريدي باسم المستفيد.',
        numberLabel: 'رقم الحساب البريدي',
        numberPlaceholder: 'أدخل رقم الحساب',
        ...getTransferServiceRules('post_account')
    }),
    Object.freeze({
        key: 'post_card',
        webType: 'بريد بطاقة',
        label: 'البريد - بطاقة',
        shortLabel: 'بريد بطاقة',
        icon: 'fa-id-card',
        tone: 'amber',
        description: 'تحويل بالرقم القومي مع مستند الهوية.',
        numberLabel: 'الرقم القومي',
        numberPlaceholder: '14 رقماً',
        ...getTransferServiceRules('post_card')
    }),
    Object.freeze({
        key: 'bank_account',
        webType: 'حساب بنكي',
        label: 'حساب بنكي',
        shortLabel: 'تحويل بنكي',
        icon: 'fa-landmark',
        tone: 'navy',
        description: 'تحويل إلى حساب مصرفي أو رقم IBAN.',
        numberLabel: 'رقم الحساب أو IBAN',
        numberPlaceholder: 'رقم الحساب البنكي',
        ...getTransferServiceRules('bank_account')
    }),
    Object.freeze({
        key: 'sefa_niger',
        webType: 'سيفا النيجر',
        label: 'سيفا النيجر',
        shortLabel: 'سيفا النيجر',
        icon: 'fa-earth-africa',
        tone: 'cyan',
        description: 'تحويل NITA أو NITA Account داخل النيجر.',
        numberLabel: 'رقم حساب NITA',
        numberPlaceholder: 'رقم الحساب أو الهاتف',
        ...getTransferServiceRules('sefa_niger')
    }),
    Object.freeze({
        key: 'bankak_sudan',
        webType: 'بنكك السودان',
        label: 'بنكك السودان',
        shortLabel: 'بنكك',
        icon: 'fa-money-bill-transfer',
        tone: 'red',
        description: 'تحويل إلى حساب بنكك داخل السودان.',
        numberLabel: 'رقم حساب بنكك',
        numberPlaceholder: 'أدخل رقم الحساب',
        ...getTransferServiceRules('bankak_sudan')
    })
]);

const PAGE_META = Object.freeze({
    overview: { title: 'مركز العمل', eyebrow: 'نظرة تشغيلية', icon: 'fa-grid-2' },
    services: { title: 'الخدمات والتحويل', eyebrow: 'إنشاء عملية', icon: 'fa-paper-plane' },
    transactions: { title: 'المعاملات', eyebrow: 'المتابعة والتنفيذ', icon: 'fa-list-check' },
    finance: { title: 'الحركات المالية', eyebrow: 'كشف الحساب', icon: 'fa-scale-balanced' },
    customers: { title: 'العملاء', eyebrow: 'إدارة الحسابات التابعة', icon: 'fa-users' },
    staff: { title: 'الموظفون والصلاحيات', eyebrow: 'إدارة الفريق', icon: 'fa-user-group' },
    reports: { title: 'التقارير والتحليلات', eyebrow: 'قرارات مبنية على البيانات', icon: 'fa-chart-column' },
    settings: { title: 'الإعدادات', eyebrow: 'بيانات المنشأة والأمان', icon: 'fa-sliders' },
    support: { title: 'الدعم الفني', eyebrow: 'تواصل مباشر وآمن', icon: 'fa-headset' }
});

const REPORT_SCOPES = Object.freeze({
    organization: 'تقرير المنشأة',
    customers: 'تقرير العملاء',
    staff: 'تقرير الموظفين'
});

const safeNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

const parseLocalDate = (value) => {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
};

const resolveDateRange = (query = {}, options = {}) => {
    const now = new Date();
    if (options.forceToday) {
        return {
            start: startOfDay(now),
            end: endOfDay(now),
            from: formatInputDate(now),
            to: formatInputDate(now),
            month: '',
            label: 'اليوم'
        };
    }

    const fromDate = parseLocalDate(query.from || query.date);
    const toDate = parseLocalDate(query.to || query.date);
    if (fromDate || toDate) {
        const start = startOfDay(fromDate || toDate);
        const end = endOfDay(toDate || fromDate);
        return {
            start: start <= end ? start : startOfDay(end),
            end: start <= end ? end : endOfDay(start),
            from: formatInputDate(start <= end ? start : end),
            to: formatInputDate(start <= end ? end : start),
            month: '',
            label: formatRangeLabel(start <= end ? start : end, start <= end ? end : start)
        };
    }

    const monthMatch = String(query.month || '').match(/^(\d{4})-(\d{2})$/);
    const year = monthMatch ? Number(monthMatch[1]) : now.getFullYear();
    const monthIndex = monthMatch ? Number(monthMatch[2]) - 1 : now.getMonth();
    const start = new Date(year, monthIndex, 1, 0, 0, 0, 0);
    const end = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
    return {
        start,
        end,
        from: '',
        to: '',
        month: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
        label: `شهر ${monthIndex + 1} / ${year}`
    };
};

function formatInputDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatRangeLabel(start, end) {
    if (formatInputDate(start) === formatInputDate(end)) return formatInputDate(start);
    return `${formatInputDate(start)} - ${formatInputDate(end)}`;
}

const isLegacyCompanyOwner = (actor) => {
    const role = String(actor.role || '').toLowerCase();
    return role !== 'accountant' && actor.canViewAllReports === true && actor.canManageCompany !== true;
};

const resolveCompanyPermissions = (actor) => {
    const role = String(actor.role || '').toLowerCase();
    const owner = role === 'owner' || actor.canCreateCompanyStaff === true || isLegacyCompanyOwner(actor);
    const manager = owner || actor.canManageCompany === true;
    const accountant = role === 'accountant';
    return {
        owner,
        manager,
        accountant,
        employee: !manager && !accountant,
        canTransfer: !accountant,
        canViewBalance: owner || manager || accountant || actor.canViewAllReports === true,
        canManageCustomers: manager,
        canManageStaff: owner,
        canViewReports: true,
        canEditSettings: owner || manager
    };
};

const resolveAgentPermissions = (actor) => {
    const owner = actor.role === 'agent';
    const accountant = actor.role === 'accountant';
    const manager = owner || actor.canManageAgent === true;
    return {
        owner,
        manager,
        accountant,
        employee: !manager && !accountant,
        canTransfer: !accountant,
        canViewBalance: owner || manager || accountant || actor.canViewAllReports === true,
        canManageCustomers: manager,
        canManageStaff: owner || actor.canCreateAgentStaff === true,
        canViewReports: true,
        canEditSettings: owner || manager
    };
};

const resolveWorkspace = async (req) => {
    if (!req.session || !req.session.clientId) {
        const error = new Error('SESSION_EXPIRED');
        error.statusCode = 401;
        throw error;
    }

    if (req.session.accountType === 'company') {
        const actor = await ClientEmployee.findById(req.session.clientId).lean();
        if (!actor || actor.status !== 'active') throw new Error('INVALID_ACTOR');
        const entity = await ClientCompany.findById(actor.companyId).lean();
        if (!entity || entity.status !== 'active') throw new Error('INVALID_ENTITY');
        const permissions = resolveCompanyPermissions(actor);
        return buildWorkspaceResult({
            type: 'company',
            actor,
            entity,
            actorModel: 'ClientEmployee',
            entityModel: 'ClientCompany',
            permissions
        });
    }

    if (req.session.accountType === 'agent_staff') {
        const actor = await AgentEmployee.findById(req.session.clientId).lean();
        if (!actor || actor.status !== 'active') throw new Error('INVALID_ACTOR');
        const entity = await User.findById(actor.agentId).lean();
        if (!entity || entity.status !== 'active' || entity.role !== 'agent') throw new Error('INVALID_ENTITY');
        const permissions = resolveAgentPermissions(actor);
        return buildWorkspaceResult({
            type: 'agent',
            actor,
            entity,
            actorModel: 'AgentEmployee',
            entityModel: 'User',
            permissions
        });
    }

    if (req.session.accountType === 'user') {
        const actor = await User.findById(req.session.clientId).lean();
        if (!actor || actor.status !== 'active' || actor.role !== 'agent') {
            const error = new Error('NOT_BUSINESS_PORTAL');
            error.statusCode = 404;
            throw error;
        }
        const permissions = resolveAgentPermissions(actor);
        return buildWorkspaceResult({
            type: 'agent',
            actor,
            entity: actor,
            actorModel: 'User',
            entityModel: 'User',
            permissions
        });
    }

    const error = new Error('NOT_BUSINESS_PORTAL');
    error.statusCode = 404;
    throw error;
};

const buildWorkspaceResult = ({ type, actor, entity, actorModel, entityModel, permissions }) => {
    const persona = permissions.accountant ? 'accountant' : (permissions.manager ? 'manager' : 'employee');
    const roleLabel = type === 'company'
        ? (permissions.owner ? 'مدير الشركة' : permissions.manager ? 'مدير تشغيل' : permissions.accountant ? 'محاسب' : 'موظف')
        : (permissions.owner ? 'مدير الوكيل' : permissions.manager ? 'مدير تشغيل' : permissions.accountant ? 'محاسب' : 'موظف');

    return {
        type,
        isCompany: type === 'company',
        isAgent: type === 'agent',
        actor,
        entity,
        actorModel,
        entityModel,
        persona,
        roleLabel,
        entityLabel: type === 'company' ? 'الشركة' : 'الوكيل',
        portalLabel: permissions.employee ? 'واجهة العميل' : (type === 'company' ? 'بوابة الشركات' : 'بوابة الوكلاء'),
        permissions,
        masterType: type === 'company' ? 'company' : 'user',
        masterId: entity._id,
        forceToday: permissions.employee
    };
};

const buildNavigation = (workspace, activePage) => {
    const items = [
        { key: 'overview', href: '/client/dashboard?home=1', label: 'الرئيسية', icon: 'fa-grid-2', group: 'العمل اليومي', visible: true },
        { key: 'services', href: '/client/services', label: 'الخدمات والتحويل', icon: 'fa-paper-plane', group: 'العمل اليومي', visible: workspace.permissions.canTransfer },
        { key: 'transactions', href: '/client/transactions', label: 'المعاملات', icon: 'fa-list-check', group: 'العمل اليومي', visible: true },
        { key: 'finance', href: '/client/finance', label: 'الحركات المالية', icon: 'fa-scale-balanced', group: 'العمل اليومي', visible: workspace.permissions.canViewBalance },
        { key: 'customers', href: '/client/customers', label: 'العملاء', icon: 'fa-users', group: 'الإدارة', visible: workspace.permissions.canManageCustomers },
        { key: 'staff', href: '/client/staff', label: 'الموظفون', icon: 'fa-user-group', group: 'الإدارة', visible: workspace.permissions.manager || workspace.permissions.accountant },
        { key: 'reports', href: '/client/reports', label: 'التقارير', icon: 'fa-chart-column', group: 'التحليل', visible: workspace.permissions.canViewReports },
        { key: 'settings', href: '/client/settings', label: 'الإعدادات', icon: 'fa-sliders', group: 'الحساب والنظام', visible: true },
        { key: 'support', href: '/client/support', label: 'الدعم الفني', icon: 'fa-headset', group: 'الحساب والنظام', visible: true }
    ];

    return items.filter((item) => item.visible).map((item) => ({ ...item, active: item.key === activePage }));
};

const canAccessPage = (workspace, page) => {
    if (['overview', 'transactions', 'settings', 'support'].includes(page)) return true;
    if (page === 'services') return workspace.permissions.canTransfer;
    if (page === 'finance') return workspace.permissions.canViewBalance;
    if (page === 'customers') return workspace.permissions.canManageCustomers;
    if (page === 'staff') return workspace.permissions.manager || workspace.permissions.accountant;
    if (page === 'reports') return workspace.permissions.canViewReports;
    return false;
};

const ownershipFilter = async (workspace) => {
    if (workspace.isCompany) return { companyId: workspace.entity._id };

    const subAccountIds = await SubAccount.find({
        masterType: 'user',
        masterId: workspace.entity._id,
        status: { $ne: 'deleted' }
    }).distinct('_id');

    return {
        $or: [
            { userId: workspace.entity.phone, companyId: null, subAccountId: null },
            { userId: workspace.entity.webUsername, companyId: null, subAccountId: null },
            { subAccountId: { $in: subAccountIds } }
        ].filter((condition) => condition.userId || condition.subAccountId)
    };
};

const buildTransactionFilter = async (workspace, query = {}, options = {}) => {
    const range = resolveDateRange(query, { forceToday: options.forceToday === true });
    const conditions = [await ownershipFilter(workspace), { createdAt: { $gte: range.start, $lte: range.end } }];
    const search = String(query.search || '').trim();

    if (search) {
        const regex = new RegExp(escapeRegex(search), 'i');
        conditions.push({
            $or: [
                { customId: regex },
                { vodafoneNumber: regex },
                { accountNumber: regex },
                { accountName: regex },
                { employeeName: regex },
                { subAccountName: regex },
                { notes: regex }
            ]
        });
    }
    if (query.status && STATUS_META[query.status]) conditions.push({ status: query.status });
    if (query.service && SERVICE_CATALOG.some((service) => service.key === query.service)) conditions.push({ transferType: query.service });
    if (query.staff) conditions.push({ employeeName: String(query.staff).trim() });
    if (query.customer && /^[a-f\d]{24}$/i.test(String(query.customer))) conditions.push({ subAccountId: query.customer });

    return {
        filter: conditions.length === 1 ? conditions[0] : { $and: conditions },
        range,
        search
    };
};

const summarizeTransactions = (transactions = []) => transactions.reduce((totals, tx) => {
    totals.totalCount += 1;
    if (tx.status === 'completed') {
        totals.completedCount += 1;
        totals.totalEGP += safeNumber(tx.amount);
        totals.totalLYD += safeNumber(tx.costLYD);
    } else if (['pending', 'processing', 'accepted'].includes(tx.status)) {
        totals.pendingCount += 1;
    } else if (['rejected', 'cancelled_by_admin'].includes(tx.status)) {
        totals.cancelledCount += 1;
    } else if (tx.status === 'deposit') {
        totals.depositTotal += safeNumber(tx.amount);
    } else if (tx.status === 'deduction') {
        totals.deductionTotal += safeNumber(tx.amount);
    }
    return totals;
}, {
    totalCount: 0,
    completedCount: 0,
    pendingCount: 0,
    cancelledCount: 0,
    totalEGP: 0,
    totalLYD: 0,
    depositTotal: 0,
    deductionTotal: 0
});

const summarizeWithAggregation = async (filter) => {
    const rows = await Transaction.aggregate([
        { $match: filter },
        {
            $group: {
                _id: null,
                totalCount: { $sum: 1 },
                completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
                pendingCount: { $sum: { $cond: [{ $in: ['$status', ['pending', 'processing', 'accepted']] }, 1, 0] } },
                cancelledCount: { $sum: { $cond: [{ $in: ['$status', ['rejected', 'cancelled_by_admin']] }, 1, 0] } },
                totalEGP: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
                totalLYD: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$costLYD', 0] } },
                depositTotal: { $sum: { $cond: [{ $eq: ['$status', 'deposit'] }, '$amount', 0] } },
                deductionTotal: { $sum: { $cond: [{ $eq: ['$status', 'deduction'] }, '$amount', 0] } }
            }
        }
    ]);
    return rows[0] || summarizeTransactions([]);
};

const getSettingsAndRates = async (workspace) => {
    const settings = await Settings.findOne({}).lean() || {};
    const serviceRates = workspace.isCompany
        ? getCompanyServiceRates(workspace.entity, settings)
        : getServiceRatesForTier(workspace.entity.tier || 1, settings);
    return {
        settings,
        serviceRates,
        services: SERVICE_CATALOG.map((service) => ({ ...service, rate: serviceRates[service.key] || 0 }))
    };
};

const staffModelForWorkspace = (workspace) => workspace.isCompany ? ClientEmployee : AgentEmployee;
const staffOwnerFilter = (workspace) => workspace.isCompany
    ? { companyId: workspace.entity._id }
    : { agentId: workspace.entity._id };

const loadOverview = async (workspace) => {
    const now = new Date();
    const monthRange = {
        start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
    };
    const todayRange = { start: startOfDay(now), end: endOfDay(now) };
    const canSeeCustomerStats = workspace.permissions.canManageCustomers;
    const canSeeStaffStats = workspace.permissions.manager || workspace.permissions.accountant;
    const [ownership, customersCount, activeCustomersCount, staffCount, activeStaffCount, pendingRequests] = await Promise.all([
        ownershipFilter(workspace),
        canSeeCustomerStats
            ? SubAccount.countDocuments({ masterType: workspace.masterType, masterId: workspace.masterId, status: { $ne: 'deleted' } })
            : Promise.resolve(0),
        canSeeCustomerStats
            ? SubAccount.countDocuments({ masterType: workspace.masterType, masterId: workspace.masterId, status: 'active' })
            : Promise.resolve(0),
        canSeeStaffStats
            ? staffModelForWorkspace(workspace).countDocuments(staffOwnerFilter(workspace))
            : Promise.resolve(0),
        canSeeStaffStats
            ? staffModelForWorkspace(workspace).countDocuments({ ...staffOwnerFilter(workspace), status: 'active' })
            : Promise.resolve(0),
        workspace.isAgent && canSeeCustomerStats
            ? RegistrationRequest.countDocuments({ accountType: 'new', status: 'pending_agent', agentId: workspace.entity._id })
            : Promise.resolve(0)
    ]);
    const monthFilter = { $and: [ownership, { createdAt: { $gte: monthRange.start, $lte: monthRange.end } }] };
    const todayFilter = { $and: [ownership, { createdAt: { $gte: todayRange.start, $lte: todayRange.end } }] };
    const [monthSummary, todaySummary, recentTransactions] = await Promise.all([
        summarizeWithAggregation(workspace.forceToday ? todayFilter : monthFilter),
        summarizeWithAggregation(todayFilter),
        Transaction.find(workspace.forceToday ? todayFilter : ownership).sort({ createdAt: -1 }).limit(8).lean()
    ]);

    return {
        monthSummary,
        todaySummary,
        recentTransactions,
        customersCount,
        activeCustomersCount,
        staffCount,
        activeStaffCount,
        pendingRequests,
        currentMonthLabel: workspace.forceToday ? 'اليوم' : `شهر ${now.getMonth() + 1} / ${now.getFullYear()}`
    };
};

const loadTransactions = async (workspace, query = {}) => {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = 25;
    const { filter, range, search } = await buildTransactionFilter(workspace, query, { forceToday: workspace.forceToday });
    const StaffModel = staffModelForWorkspace(workspace);
    const [transactions, total, summary, staff, customers] = await Promise.all([
        Transaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Transaction.countDocuments(filter),
        summarizeWithAggregation(filter),
        StaffModel.find(staffOwnerFilter(workspace)).select('name role status').sort({ name: 1 }).lean(),
        SubAccount.find({ masterType: workspace.masterType, masterId: workspace.masterId, status: { $ne: 'deleted' } })
            .select('name status accountCode').sort({ name: 1 }).lean()
    ]);

    return {
        transactions,
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
            ...range
        }
    };
};

const loadCustomers = async (workspace) => {
    const customers = await SubAccount.find({
        masterType: workspace.masterType,
        masterId: workspace.masterId,
        status: { $ne: 'deleted' }
    }).sort({ createdAt: -1 }).lean();

    const customerIds = customers.map((customer) => customer._id);
    const month = resolveDateRange({});
    const stats = customerIds.length ? await Transaction.aggregate([
        { $match: { subAccountId: { $in: customerIds }, createdAt: { $gte: month.start, $lte: month.end } } },
        {
            $group: {
                _id: '$subAccountId',
                transactionCount: { $sum: 1 },
                completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
                totalEGP: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
                totalLYD: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$costLYD', 0] } },
                lastActivity: { $max: '$createdAt' }
            }
        }
    ]) : [];
    const statsById = new Map(stats.map((item) => [String(item._id), item]));
    const enrichedCustomers = customers.map((customer) => ({
        ...customer,
        stats: statsById.get(String(customer._id)) || {
            transactionCount: 0,
            completedCount: 0,
            totalEGP: 0,
            totalLYD: 0,
            lastActivity: null
        }
    }));
    const pendingRequests = workspace.isAgent
        ? await RegistrationRequest.find({ accountType: 'new', status: 'pending_agent', agentId: workspace.entity._id }).sort({ createdAt: -1 }).lean()
        : [];

    return {
        customers: enrichedCustomers,
        pendingRequests,
        customerSummary: {
            total: customers.length,
            active: customers.filter((customer) => customer.status === 'active').length,
            totalBalance: customers.reduce((sum, customer) => sum + safeNumber(customer.balance), 0),
            totalCredit: customers.reduce((sum, customer) => sum + safeNumber(customer.creditLimit), 0),
            monthVolumeEGP: stats.reduce((sum, item) => sum + safeNumber(item.totalEGP), 0)
        },
        periodLabel: month.label
    };
};

const loadStaff = async (workspace) => {
    const StaffModel = staffModelForWorkspace(workspace);
    const staff = await StaffModel.find(staffOwnerFilter(workspace)).sort({ role: 1, createdAt: -1 }).lean();
    const ownership = await ownershipFilter(workspace);
    const month = resolveDateRange({});
    const employeeNames = staff.map((member) => member.name).filter(Boolean);
    const stats = employeeNames.length ? await Transaction.aggregate([
        { $match: { $and: [ownership, { employeeName: { $in: employeeNames } }, { createdAt: { $gte: month.start, $lte: month.end } }] } },
        {
            $group: {
                _id: '$employeeName',
                transactionCount: { $sum: 1 },
                completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
                totalEGP: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
                lastActivity: { $max: '$createdAt' }
            }
        }
    ]) : [];
    const statsByName = new Map(stats.map((item) => [item._id, item]));
    return {
        staff: staff.map((member) => ({
            ...member,
            stats: statsByName.get(member.name) || { transactionCount: 0, completedCount: 0, totalEGP: 0, lastActivity: null }
        })),
        staffSummary: {
            total: staff.length,
            active: staff.filter((member) => member.status === 'active').length,
            managers: staff.filter((member) => member.role === 'owner' || member.canManageCompany || member.canManageAgent).length,
            accountants: staff.filter((member) => member.role === 'accountant').length,
            monthOperations: stats.reduce((sum, item) => sum + safeNumber(item.transactionCount), 0)
        },
        periodLabel: month.label
    };
};

const movementFromTransaction = (tx) => {
    if (tx.status === 'deposit') {
        return { transactionId: tx.customId, type: 'DEPOSIT', amount: safeNumber(tx.amount), direction: 'credit', description: 'إيداع رصيد', createdAt: tx.createdAt, source: 'transaction' };
    }
    if (tx.status === 'deduction') {
        return { transactionId: tx.customId, type: 'DEDUCTION', amount: -Math.abs(safeNumber(tx.amount)), direction: 'debit', description: 'خصم رصيد', createdAt: tx.createdAt, source: 'transaction' };
    }
    if (tx.status === 'completed') {
        return { transactionId: tx.customId, type: 'TRANSFER', amount: -Math.abs(safeNumber(tx.costLYD)), direction: 'debit', description: `تحويل ${safeNumber(tx.amount).toLocaleString('en-US')} EGP`, createdAt: tx.createdAt, source: 'transaction' };
    }
    if (tx.status === 'cancelled_by_admin') {
        return { transactionId: tx.customId, type: 'REFUND', amount: Math.abs(safeNumber(tx.costLYD)), direction: 'credit', description: 'إرجاع عملية ملغية', createdAt: tx.cancelledAt || tx.updatedAt || tx.createdAt, source: 'transaction' };
    }
    return null;
};

const loadFinance = async (workspace, query = {}) => {
    const range = resolveDateRange(query, { forceToday: workspace.forceToday });
    const ownership = await ownershipFilter(workspace);
    const [ledgerRows, transactions] = await Promise.all([
        Ledger.find({
            entityId: workspace.entity._id,
            entityModel: workspace.entityModel,
            createdAt: { $gte: range.start, $lte: range.end }
        }).sort({ createdAt: -1 }).limit(300).lean(),
        Transaction.find({
            $and: [ownership, { createdAt: { $gte: range.start, $lte: range.end } }, { status: { $in: ['completed', 'deposit', 'deduction', 'cancelled_by_admin'] } }]
        }).sort({ createdAt: -1 }).limit(300).lean()
    ]);
    const ledgerIds = new Set(ledgerRows.map((row) => row.transactionId));
    const fallbackRows = transactions
        .filter((tx) => !ledgerIds.has(tx.customId))
        .map(movementFromTransaction)
        .filter(Boolean);
    const movements = [
        ...ledgerRows.map((row) => sanitizeStatementMovement({
            ...row,
            direction: safeNumber(row.amount) >= 0 ? 'credit' : 'debit',
            source: 'ledger'
        })).filter(Boolean),
        ...fallbackRows
    ].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
    const financeSummary = movements.reduce((summary, movement) => {
        const amount = safeNumber(movement.amount);
        if (amount >= 0) summary.credits += amount;
        else summary.debits += Math.abs(amount);
        summary.net += amount;
        summary.count += 1;
        return summary;
    }, { credits: 0, debits: 0, net: 0, count: 0 });

    return { movements, financeSummary, filters: { ...range, type: query.type || '' } };
};

const reportGroupKey = (scope, tx) => {
    if (scope === 'customers') return tx.subAccountName || (tx.subAccountId ? 'عميل تابع' : 'عمليات الحساب الرئيسي');
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
            lastActivity: tx.createdAt
        };
        current.totalCount += 1;
        if (tx.status === 'completed') {
            current.completedCount += 1;
            current.totalEGP += safeNumber(tx.amount);
            current.totalLYD += safeNumber(tx.costLYD);
        } else if (['pending', 'processing', 'accepted'].includes(tx.status)) {
            current.pendingCount += 1;
        } else if (['rejected', 'cancelled_by_admin'].includes(tx.status)) {
            current.cancelledCount += 1;
        } else if (tx.status === 'deposit') {
            current.deposits += safeNumber(tx.amount);
        } else if (tx.status === 'deduction') {
            current.deductions += safeNumber(tx.amount);
        }
        if (new Date(tx.createdAt) > new Date(current.lastActivity)) current.lastActivity = tx.createdAt;
        groups.set(key, current);
    });
    return [...groups.values()].sort((left, right) => new Date(right.lastActivity) - new Date(left.lastActivity));
};

const loadReports = async (workspace, query = {}) => {
    const requestedScope = String(query.scope || 'organization');
    const scope = REPORT_SCOPES[requestedScope] ? requestedScope : 'organization';
    const { filter, range } = await buildTransactionFilter(workspace, query, { forceToday: workspace.forceToday });
    const transactions = await Transaction.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    const reportSummary = summarizeTransactions(transactions);
    const reportRows = buildReportGroups(transactions, scope);
    const serviceBreakdown = SERVICE_CATALOG.map((service) => {
        const serviceTransactions = transactions.filter((tx) => tx.transferType === service.key && tx.status === 'completed');
        return {
            key: service.key,
            label: service.shortLabel,
            count: serviceTransactions.length,
            totalEGP: serviceTransactions.reduce((sum, tx) => sum + safeNumber(tx.amount), 0),
            totalLYD: serviceTransactions.reduce((sum, tx) => sum + safeNumber(tx.costLYD), 0)
        };
    }).filter((item) => item.count > 0);

    return {
        reportScope: scope,
        reportScopeLabel: REPORT_SCOPES[scope],
        reportScopes: REPORT_SCOPES,
        reportSummary,
        reportRows,
        serviceBreakdown,
        reportTransactions: transactions.slice(0, 100).map(sanitizeStatementTransaction),
        filters: { ...range, scope }
    };
};

const buildBaseContext = async (req, page, workspace) => {
    const rates = await getSettingsAndRates(workspace);
    const pageMeta = { ...PAGE_META[page] };
    if (workspace.forceToday) {
        if (page === 'overview') Object.assign(pageMeta, { title: 'الرئيسية', eyebrow: 'عمل اليوم' });
        if (page === 'transactions') Object.assign(pageMeta, { title: 'عمليات اليوم', eyebrow: 'المتابعة اليومية' });
        if (page === 'reports') Object.assign(pageMeta, { title: 'تقارير اليوم', eyebrow: 'ملخص اليوم الحالي' });
    }
    return {
        page,
        pageMeta,
        workspace,
        navigation: buildNavigation(workspace, page),
        statusMeta: STATUS_META,
        serviceCatalog: rates.services,
        serviceRates: rates.serviceRates,
        systemOpen: rates.settings.isManualClosed !== true,
        query: req.query || {},
        csrfToken: req.session.csrfToken || '',
        formatInputDate,
        now: new Date()
    };
};

const loadPageContext = async (req, page) => {
    const workspace = await resolveWorkspace(req);
    if (!canAccessPage(workspace, page)) {
        const error = new Error('FORBIDDEN_PAGE');
        error.statusCode = 403;
        throw error;
    }

    const context = await buildBaseContext(req, page, workspace);
    if (page === 'overview') Object.assign(context, await loadOverview(workspace));
    if (page === 'services') context.servicePage = { selectedService: req.query.service || 'vodafone' };
    if (page === 'transactions') Object.assign(context, await loadTransactions(workspace, req.query));
    if (page === 'finance') Object.assign(context, await loadFinance(workspace, req.query));
    if (page === 'customers') Object.assign(context, await loadCustomers(workspace));
    if (page === 'staff') Object.assign(context, await loadStaff(workspace));
    if (page === 'reports') Object.assign(context, await loadReports(workspace, req.query));
    if (page === 'settings') context.settingsData = { profile: workspace.entity.businessProfile || {} };
    return context;
};

module.exports = {
    STATUS_META,
    SERVICE_CATALOG,
    PAGE_META,
    REPORT_SCOPES,
    resolveDateRange,
    resolveCompanyPermissions,
    resolveAgentPermissions,
    resolveWorkspace,
    canAccessPage,
    buildNavigation,
    ownershipFilter,
    buildTransactionFilter,
    getSettingsAndRates,
    summarizeTransactions,
    buildReportGroups,
    loadPageContext,
    loadReports,
    safeNumber,
    formatInputDate
};
