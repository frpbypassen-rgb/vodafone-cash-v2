const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const { getServiceRatesForTier } = require('../utils/rateHelper');
const { logAction } = require('../services/auditService');

const COMPANY_USERNAME_DOMAIN = '@ahram.com';

const roleLabels = {
    owner: 'مدير الشركة',
    employee: 'موظف',
    accountant: 'محاسب'
};

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

const normalizeCompanyUsername = (rawUsername) => {
    const base = String(rawUsername || '').trim().toLowerCase();
    const username = base.includes('@') ? base : `${base}${COMPANY_USERNAME_DOMAIN}`;
    if (!/^[a-z0-9_]{3,40}@ahram\.com$/.test(username)) {
        throw new Error('INVALID_USERNAME');
    }
    return username;
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
        const start = explicitDate;
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 59, 999);
        return {
            start,
            end,
            targetDate: query.date,
            targetMonth: '',
            dateLabel: query.date,
            showMonth: false
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
        showMonth: true
    };
};

const isLegacyOwner = (account) => {
    const role = String(account.role || '').toLowerCase();
    return role !== 'accountant'
        && account.canViewAllReports === true
        && account.canManageCompany !== true;
};

const isCompanyOwner = (account) => (
    String(account.role || '').toLowerCase() === 'owner'
    || account.canCreateCompanyStaff === true
    || isLegacyOwner(account)
);

const canManageCompany = (account) => isCompanyOwner(account) || account.canManageCompany === true;

const canViewCompanyBalance = (account) => (
    isCompanyOwner(account)
    || account.canManageCompany === true
    || account.canViewAllReports === true
    || String(account.role || '').toLowerCase() === 'accountant'
);

const canCreateStaff = (account) => isCompanyOwner(account);

const dashboardPersona = (account) => {
    const role = String(account.role || '').toLowerCase();
    if (role === 'accountant') return 'accountant';
    if (canManageCompany(account)) return 'manager';
    return 'employee';
};

const getCompanyActor = async (req, preloadedAccount = null) => {
    if (!req.session || req.session.accountType !== 'company') {
        throw new Error('NOT_COMPANY_SESSION');
    }

    const account = preloadedAccount || await ClientEmployee.findById(req.session.clientId);
    if (!account || account.status !== 'active') {
        throw new Error('INVALID_COMPANY_EMPLOYEE');
    }

    const company = await ClientCompany.findById(account.companyId);
    if (!company || company.status !== 'active') {
        throw new Error('INVALID_COMPANY');
    }

    return { account, company };
};

const assertUsernameAvailable = async (webUsername) => {
    const [clientEmployee, user, subAccount, executor, admin] = await Promise.all([
        ClientEmployee.exists({ webUsername }),
        User.exists({ webUsername }),
        SubAccount.exists({ webUsername }),
        Employee.exists({ webUsername }),
        Admin.exists({ webUsername })
    ]);

    if (clientEmployee || user || subAccount || executor || admin) {
        throw new Error('USERNAME_TAKEN');
    }
};

const buildTransactionsQuery = ({ companyId, start, end, search }) => {
    const query = {
        companyId,
        createdAt: { $gte: start, $lte: end }
    };

    if (search) {
        query.$or = [
            { customId: { $regex: search, $options: 'i' } },
            { vodafoneNumber: { $regex: search, $options: 'i' } },
            { accountNumber: { $regex: search, $options: 'i' } },
            { accountName: { $regex: search, $options: 'i' } },
            { employeeName: { $regex: search, $options: 'i' } },
            { notes: { $regex: search, $options: 'i' } }
        ];
    }

    return query;
};

const summarizeCompanyTransactions = (transactions) => {
    return transactions.reduce((totals, tx) => {
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
};

const buildCompanyContext = async ({ req, account, company, forceToday = false }) => {
    const range = resolveRange(req.query, forceToday);
    const search = req.query.search ? String(req.query.search).trim() : '';
    const transactionQuery = buildTransactionsQuery({
        companyId: company._id,
        start: range.start,
        end: range.end,
        search
    });

    const [transactions, settings, staff] = await Promise.all([
        Transaction.find(transactionQuery).sort({ createdAt: -1 }).lean(),
        Settings.findOne({}).lean(),
        ClientEmployee.find({ companyId: company._id }).sort({ role: 1, createdAt: -1 }).lean()
    ]);

    const effectiveSettings = settings || {};
    const serviceRates = getServiceRatesForTier(company.tier || 1, effectiveSettings);
    const persona = dashboardPersona(account);
    const owner = isCompanyOwner(account);
    const staffCount = staff.filter(item => item.status === 'active').length;

    return {
        account,
        company,
        persona,
        roleLabel: owner ? 'مدير الشركة' : (roleLabels[account.role] || 'موظف'),
        canManageCompany: canManageCompany(account),
        canCreateStaff: canCreateStaff(account),
        canViewBalance: canViewCompanyBalance(account),
        canTransfer: String(account.role || '').toLowerCase() !== 'accountant',
        staff,
        staffCount,
        transactions,
        totals: summarizeCompanyTransactions(transactions),
        serviceRates,
        currentRate: serviceRates.vodafone || 0,
        statusLabels,
        serviceLabels,
        search,
        query: req.query || {},
        ...range,
        csrfToken: req.session.csrfToken || ''
    };
};

exports.renderCompanyDashboard = async (req, res, preloadedAccount = null) => {
    try {
        const { account, company } = await getCompanyActor(req, preloadedAccount);
        const persona = dashboardPersona(account);
        const forceToday = persona === 'employee';
        const context = await buildCompanyContext({ req, account, company, forceToday });

        if (persona === 'accountant') {
            return res.render('client/company_accountant_dashboard', context);
        }

        if (persona === 'manager') {
            return res.render('client/company_manager_dashboard', context);
        }

        return res.render('client/company_employee_dashboard', context);
    } catch (error) {
        console.error('[Company Dashboard] render failed:', error.message);
        return res.redirect('/client/logout');
    }
};

exports.getStaffManagement = async (req, res) => {
    try {
        const { account } = await getCompanyActor(req);
        if (!canManageCompany(account)) return res.redirect('/client/dashboard');
        return res.redirect('/client/staff');
    } catch (error) {
        return res.redirect('/client/logout');
    }
};

exports.postAddStaff = async (req, res) => {
    try {
        const { account, company } = await getCompanyActor(req);
        if (!canCreateStaff(account)) {
            return res.status(403).redirect('/client/staff?staffError=forbidden');
        }

        const name = String(req.body.name || '').trim();
        const phone = String(req.body.phone || '').trim();
        const webPassword = String(req.body.webPassword || '').trim();
        const role = String(req.body.role || 'employee').trim();
        const grantManagerAccess = isChecked(req.body.canManageCompany);

        if (!name || !phone || !webPassword || !['employee', 'accountant'].includes(role)) {
            return res.redirect('/client/staff?staffError=missing');
        }
        if (webPassword.length < 6) {
            return res.redirect('/client/staff?staffError=password');
        }

        const webUsername = normalizeCompanyUsername(req.body.webUsername);
        await assertUsernameAvailable(webUsername);

        const created = await ClientEmployee.create({
            companyId: company._id,
            name,
            phone,
            webUsername,
            webPassword,
            role,
            status: 'active',
            canManageCompany: grantManagerAccess,
            canCreateCompanyStaff: false,
            canViewAllReports: role === 'accountant' || grantManagerAccess
        });

        await logAction({
            action: 'USER_CREATED',
            req,
            performedById: account._id,
            performedByModel: 'ClientEmployee',
            performedByName: account.name,
            targetId: created._id,
            targetModel: 'ClientEmployee',
            result: 'ناجح',
            metadata: {
                companyId: company._id,
                role,
                canManageCompany: grantManagerAccess,
                webUsername
            }
        });

        return res.redirect('/client/staff?staffSuccess=created');
    } catch (error) {
        const code = error.message === 'USERNAME_TAKEN'
            ? 'username'
            : error.message === 'INVALID_USERNAME'
                ? 'username_format'
                : 'server';
        console.error('[Company Staff] create failed:', error.message);
        return res.redirect(`/client/staff?staffError=${code}`);
    }
};

exports.postToggleStaff = async (req, res) => {
    try {
        const { account, company } = await getCompanyActor(req);
        if (!canCreateStaff(account)) {
            return res.status(403).redirect('/client/staff?staffError=forbidden');
        }

        const target = await ClientEmployee.findOne({ _id: req.params.id, companyId: company._id });
        if (!target || String(target._id) === String(account._id) || isCompanyOwner(target)) {
            return res.redirect('/client/staff?staffError=forbidden');
        }

        target.status = target.status === 'active' ? 'banned' : 'active';
        await target.save();

        await logAction({
            action: 'USER_STATUS_CHANGED',
            req,
            performedById: account._id,
            performedByModel: 'ClientEmployee',
            performedByName: account.name,
            targetId: target._id,
            targetModel: 'ClientEmployee',
            result: target.status,
            metadata: { companyId: company._id, webUsername: target.webUsername }
        });

        return res.redirect('/client/staff?staffSuccess=status');
    } catch (error) {
        console.error('[Company Staff] toggle failed:', error.message);
        return res.redirect('/client/staff?staffError=server');
    }
};

exports.postResetStaffPassword = async (req, res) => {
    try {
        const { account, company } = await getCompanyActor(req);
        if (!canCreateStaff(account)) {
            return res.status(403).redirect('/client/staff?staffError=forbidden');
        }

        const newPassword = String(req.body.newPassword || '').trim();
        if (newPassword.length < 6) {
            return res.redirect('/client/staff?staffError=password');
        }

        const target = await ClientEmployee.findOne({ _id: req.params.id, companyId: company._id });
        if (!target || String(target._id) === String(account._id) || isCompanyOwner(target)) {
            return res.redirect('/client/staff?staffError=forbidden');
        }

        target.webPassword = newPassword;
        await target.save();

        await logAction({
            action: 'USER_PASSWORD_CHANGED',
            req,
            performedById: account._id,
            performedByModel: 'ClientEmployee',
            performedByName: account.name,
            targetId: target._id,
            targetModel: 'ClientEmployee',
            result: 'ناجح',
            metadata: { companyId: company._id, webUsername: target.webUsername }
        });

        return res.redirect('/client/staff?staffSuccess=password');
    } catch (error) {
        console.error('[Company Staff] password reset failed:', error.message);
        return res.redirect('/client/staff?staffError=server');
    }
};

exports.companyRoleHelpers = {
    isCompanyOwner,
    canManageCompany,
    canViewCompanyBalance,
    canCreateStaff,
    dashboardPersona,
    normalizeCompanyUsername
};
