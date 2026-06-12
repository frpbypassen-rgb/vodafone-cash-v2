const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');

// Helper to get start/end dates
function getDateRange(dateStr, monthStr) {
    if (dateStr) {
        const start = new Date(dateStr); start.setHours(0, 0, 0, 0);
        const end = new Date(dateStr); end.setHours(23, 59, 59, 999);
        return { start, end };
    } else if (monthStr) {
        const [year, month] = monthStr.split('-');
        const start = new Date(year, parseInt(month) - 1, 1);
        const end = new Date(year, parseInt(month), 0, 23, 59, 59, 999);
        return { start, end };
    }
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    return { start, end };
}

const requireClientAuth = async (req, res, next) => {
    try {
        if (!req.session.isClientLoggedIn || !req.session.clientId) return res.redirect('/client/login');

        if (req.session.accountType === 'company') {
            const employee = await ClientEmployee.findById(req.session.clientId).select('status companyId').lean();
            if (!employee || employee.status !== 'active') return res.redirect('/client/logout');
            const company = await ClientCompany.findById(employee.companyId).select('status').lean();
            if (!company || company.status !== 'active') return res.redirect('/client/logout');
            return next();
        }

        if (req.session.accountType === 'sub_client') {
            const subAccount = await SubAccount.findById(req.session.clientId).select('status').lean();
            if (!subAccount || subAccount.status !== 'active') return res.redirect('/client/logout');
            return next();
        }

        const user = await User.findById(req.session.clientId).select('status').lean();
        if (!user || user.status !== 'active') return res.redirect('/client/logout');
        return next();
    } catch (_error) {
        return res.redirect('/client/logout');
    }
};

router.get('/reports', requireClientAuth, async (req, res) => {
    try {
        const isEmployee = req.session.accountType === 'company';
        let account;
        let canViewBalance = true;
        if (isEmployee) {
            account = await ClientEmployee.findById(req.session.clientId).lean();
            if (account) {
                const company = await ClientCompany.findById(account.companyId).lean();
                account.balance = company ? company.balance : 0;
                canViewBalance = account.canViewAllReports;
            }
        } else {
            account = await User.findById(req.session.clientId).lean();
        }
        account.canViewBalance = canViewBalance;
        res.render('client/reports', { account, accountType: req.session.accountType });
    } catch (e) {
        console.error("Reports Render Error:", e);
        res.redirect('/client/dashboard');
    }
});

router.post('/reports/filter', requireClientAuth, async (req, res) => {
    try {
        const isEmployee = req.session.accountType === 'company';
        let account = null;
        let company = null;

        if (isEmployee) {
            account = await ClientEmployee.findById(req.session.clientId);
            if (!account) return res.status(401).json({ error: 'Unauthorized' });
            company = await ClientCompany.findById(account.companyId);
        } else {
            account = await User.findById(req.session.clientId);
            if (!account) return res.status(401).json({ error: 'Unauthorized' });
        }

        const { dateType, dateValue } = req.body;

        let { start, end } = getDateRange(
            dateType === 'day' ? dateValue : null,
            dateType === 'month' ? dateValue : null
        );

        // ClientEmployee may have canViewAllReports
        const isCompanyManager = isEmployee && (account.role === 'manager' || !account.companyId); // Often company manager is just the first user, or wait, ClientCompany is separate.
        // Actually, ClientEmployee doesn't have roles. They are just employees.
        // If it's a direct user, they see everything for themselves.

        const canViewAll = !isEmployee || account.canViewAllReports;

        if (isEmployee && !canViewAll) {
            // إجبار التواريخ لتكون لليوم فقط للموظف العادي
            const today = new Date();
            start = new Date(today.setHours(0, 0, 0, 0));
            end = new Date(today.setHours(23, 59, 59, 999));
        }

        let baseQuery = {};

        if (isEmployee) {
            baseQuery.companyId = account.companyId;
            if (!canViewAll) {
                baseQuery.employeeName = account.name;
            }
        } else {
            // Logic must match mainCategory === 'direct_client' or 'agent' in reports.js
            baseQuery.$or = [
                { userId: account.phone },
                { userId: account.webUsername },
                { employeeName: account.name, companyName: { $regex: /عميل فردي/ } }
            ];
            baseQuery.$or = baseQuery.$or.filter(cond => {
                const val = Object.values(cond)[0];
                return val !== undefined && val !== null;
            });
            baseQuery.companyId = null;
            baseQuery.isSubAccountTx = { $ne: true };

            // If they are an agent, they shouldn't see subAccount transactions here according to reports.js `direct_client`
            // Wait, if they are an agent, in reports.js it's `mainCategory === 'agent'`.
            // But they are logging into the direct client portal.
            // The admin reports has a separate category for agents. If we want it to match EXACTLY what admin sees when they select "Direct Client", this is the logic.
        }

        const prevTransactions = await Transaction.find({ ...baseQuery, createdAt: { $lt: start } }).select('status amount costLYD').lean();
        let previousBalance = 0;
        prevTransactions.forEach(tx => {
            if (tx.status === 'completed') previousBalance -= (tx.costLYD || 0);
            else if (tx.status === 'deposit') previousBalance += (tx.amount || 0);
            else if (tx.status === 'deduction') previousBalance -= (tx.amount || 0);
        });

        const currentTransactions = await Transaction.find({ ...baseQuery, createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).lean();

        let totalLYD = 0; let totalEGP = 0;
        let completedCount = 0; let rejectedCount = 0; let totalDeposits = 0;
        const operations = []; const deposits = [];

        currentTransactions.forEach(tx => {
            if (['deposit', 'deduction', 'deposit_pending'].includes(tx.status)) {
                deposits.push(tx);
                if (tx.status === 'deposit') totalDeposits += (tx.amount || 0);
                else if (tx.status === 'deduction') totalDeposits -= (tx.amount || 0);
            } else {
                operations.push(tx);
                if (tx.status === 'completed') {
                    completedCount++;
                    totalLYD += (tx.costLYD || 0);
                    totalEGP += (tx.amount || 0);
                } else if (tx.status === 'rejected' || tx.status === 'cancelled_by_admin') {
                    rejectedCount++;
                }
            }
        });



        const entityInfo = {
            name: account.name || '---',
            phone: account.phone || '---',
            username: account.webUsername || '---',
            joinDate: account.createdAt,
            status: isEmployee ? (canViewAll ? 'مدير/مسؤول شركة' : 'موظف شركة') : 'عميل مباشر'
        };

        if (isEmployee && company) {
            entityInfo.status += ` (${company.name})`;
        }

        res.json({
            success: true,
            data: {
                previousBalance,
                currentTransactions,
                operations,
                deposits,
                totalLYD,
                totalEGP,
                completedCount,
                rejectedCount,
                totalDeposits,
                entityInfo
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

module.exports = router;
